/*
 * Bridge between the browser UI and the Rapfi engine.
 *
 * Rapfi is a native process that speaks the Piskvork/Gomocup protocol over
 * stdin/stdout, so a web page cannot talk to it directly. This server keeps one
 * engine process alive, serves the UI, and exposes two endpoints:
 *
 *   POST /api/move    - send a position, get the engine's move back
 *   GET  /api/events  - server-sent events carrying live search output
 *   POST /api/cursor  - mouse events for the spectator window, relayed as events
 *
 * No dependencies: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { windowedMove } = require('./window-engine');
const { resistWithin } = require('./white-resistance');

const ROOT = __dirname;
const ENGINE_DIR = path.join(ROOT, 'engine');
const CACHE_FILE = path.join(ENGINE_DIR, 'selected-build.json');
const PORT = Number(process.env.PORT) || 8787;

/* Search threads per engine process: RAPFI_THREADS=N node server.js. More threads
   search deeper but take CPU from anything else running, VRChat included, so the
   count is a setting rather than every core; set it to 4 or less while playing
   something heavy. The default of 8 is one thread per performance core on an
   i7-13700K: nodes per second went x3.95 at 4 threads and x7.44 at 8, but only
   x10.5 at 16, where the extra threads are hyperthreads. Capped at 16. */
const THREADS = Math.min(16, Math.max(1, Math.floor(Number(process.env.RAPFI_THREADS)) || 8));

/* How far inside a fake window edge every stone must stay before a 15x15 window may
   stand in for the 19x19 board (see window-engine.js). WINDOW_MARGIN=N node server.js. */
const WINDOW_MARGIN = Math.min(7, Math.max(0, Math.floor(Number(process.env.WINDOW_MARGIN)))) || 2;

/* Best instruction set first. A build the CPU cannot run dies immediately with
   an illegal-instruction exit, which is how the vendor suggests detecting it.
   The macOS release is a single Apple Silicon binary, so there is nothing to
   probe there. */
const X86_BUILDS = ['avx512vnni', 'avx512', 'avxvnni', 'avx2', 'sse'];
const BUILDS = process.platform === 'darwin' ? ['apple-silicon'] : X86_BUILDS;

const RULES = { freestyle: 0, standard: 1, renju: 4 };


/* Gomocup notation, the form Rapfi prints a principal variation in: column
   letters from A with 'I' included (A-O on 15x15, A-S on 19x19, up to T on the
   largest board accepted here), row 1 at the bottom. */
const COLUMNS = 'ABCDEFGHIJKLMNOPQRST';
const DEFAULT_SIZE = 19;

function boardSize(value) {
  return Math.min(COLUMNS.length, Math.max(5, Number(value) || DEFAULT_SIZE));
}

function pointFromCoord(token) {
  const m = /^([A-T])(\d{1,2})$/i.exec(String(token || ''));
  if (!m) return null;
  const x = COLUMNS.indexOf(m[1].toUpperCase());
  const y = Number(m[2]) - 1;
  return x >= 0 && y >= 0 ? { x, y } : null;
}

/* Rapfi reports a mate as "M12" / "-M12" and everything else as a number.
   Mates sort outside every ordinary score, the nearer ones first, so that a
   won position never falls inside a sampling window next to a lost one. */
function evalToNumber(text) {
  const m = /^([+-]?)M(\d+)$/i.exec(String(text));
  if (m) {
    const mag = 1e6 - Number(m[2]);
    return m[1] === '-' ? -mag : mag;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function exeFor(tag) {
  if (process.platform === 'darwin') {
    return path.join(ENGINE_DIR, 'pbrain-rapfi-macos-' + tag);
  }
  if (process.platform === 'linux') {
    return path.join(ENGINE_DIR, 'pbrain-rapfi-linux-clang-' + tag);
  }
  return path.join(ENGINE_DIR, 'pbrain-rapfi-windows-' + tag + '.exe');
}

/* Rapfi reports search progress as
     MESSAGE Depth 17-37 | Eval -484 | Time 1471ms | I8 J7 ...
   and finishes with a summary line carrying Speed and Node. */
function makeInfoCollector() {
  const info = { depth: null, eval: null, nodes: null, speed: null, timeMs: null, pv: [] };
  const collect = line => {
    const m = /^MESSAGE\s+(.*)$/i.exec(line);
    if (!m) return;
    let sawDepth = false, pv = null;
    for (const part of m[1].split('|').map(s => s.trim())) {
      let f;
      if ((f = /^Depth\s+(\S+)$/i.exec(part))) { info.depth = f[1]; sawDepth = true; }
      else if ((f = /^Eval\s+(\S+)$/i.exec(part))) info.eval = f[1];
      else if ((f = /^Node\s+(\S+)$/i.exec(part))) info.nodes = f[1];
      else if ((f = /^Speed\s+(\S+)$/i.exec(part))) info.speed = f[1];
      else if ((f = /^Time\s+(\d+)ms$/i.exec(part))) info.timeMs = Number(f[1]);
      else if (/^[A-T]\d{1,2}(\s+[A-T]\d{1,2})*$/i.test(part)) pv = part.split(/\s+/);
    }
    if (sawDepth && pv) info.pv = pv;
  };
  return { info, collect };
}

/* Odds of picking a candidate: full weight on the best move, tailing off to a
   small share at the far edge of the window, so no move inside it is ever
   impossible and the best one is always the most likely. */
function weightFor(candidate, top, slack) {
  if (slack <= 0) return 1;
  return 0.15 + 0.85 * (1 - (top - candidate.value) / slack);
}

/* ------------------------------------------------------------------ engine */

class Rapfi {
  constructor(tag) {
    this.tag = tag;
    this.proc = null;
    this.buffer = '';
    this.about = '';
    this.listeners = [];       // line consumers, most recent first
    this.queue = Promise.resolve();
    this.size = 0;
    this.rule = -1;
  }

  start() {
    if (this.retired) throw new Error('engine retired');
    if (this.proc) return;
    this.proc = spawn(exeFor(this.tag), [], { cwd: ENGINE_DIR });
    this.proc.stdout.on('data', chunk => this.onData(chunk));
    this.proc.stderr.on('data', chunk => broadcast('stderr', chunk.toString().trim()));
    this.proc.on('exit', code => {
      broadcast('engine', 'engine exited with code ' + code);
      this.proc = null;
      this.size = 0;
      this.rule = -1;
    });
    this.proc.on('error', err => broadcast('engine', 'engine error: ' + err.message));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    broadcast('line', line);
    for (const fn of this.listeners.slice()) fn(line);
  }

  send(text) {
    if (!this.proc) throw new Error('engine is not running');
    this.proc.stdin.write(text + '\n');
    broadcast('sent', text);
  }

  /* Send `text`, then resolve with the first line `match` accepts. */
  ask(text, match, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const listener = line => {
        if (/^ERROR/i.test(line)) return done(null, new Error(line));
        const hit = match(line);
        if (hit !== undefined && hit !== null && hit !== false) done(hit, null);
      };
      const done = (value, err) => {
        clearTimeout(timer);
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
        err ? reject(err) : resolve(value);
      };
      this.listeners.unshift(listener);
      timer = setTimeout(() => done(null, new Error('engine timed out after ' + timeoutMs + 'ms')), timeoutMs);
      try { this.send(text); } catch (err) { done(null, err); }
    });
  }

  /* Serialise everything: the protocol is a single request/response stream. */
  run(job) {
    if (this.retired) return Promise.reject(new Error('engine retired'));
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  /* Rapfi 0.43.01 with two or more threads keeps the network of the first rule it
     loaded when the rule changes in the same process, so a renju game after a
     freestyle one would quietly search with the freestyle net. Dropping to one
     thread and back after the new rule, before START, makes it load the right
     weights (fixed upstream in Rapfi 613f25c, not yet released). START also
     rebuilds the search tables that depend on the thread count, which is why the
     thread count always goes out before it. Regression test: test/rule-switch.js. */
  async ensureGame(size, rule) {
    this.start();
    if (this.size === size && this.rule === rule) return;
    this.send('INFO rule ' + rule);
    if (THREADS > 1) this.send('INFO THREAD_NUM 1');
    this.send('INFO THREAD_NUM ' + THREADS);
    await this.ask('START ' + size, l => /^OK\b/i.test(l) || undefined, 15000);
    this.size = size;
    this.rule = rule;
    this.send('INFO game_type 0');       // opponent is a human
    this.send('INFO timeout_match 0');   // no whole-game clock
    this.send('INFO max_memory ' + 512 * 1024 * 1024);
  }

  /* stones: [[x, y, color], ...] in move order, color 1 = black, 2 = white.
     `nodes` caps the search at a node count as well as the clock (0, the default, is
     no cap). It exists for deterministic tests; normal play leaves it at 0. */
  async think(opts) {
    const { size, rule, stones, engineColor, timeoutMs, strength, nodes = 0 } = opts;
    await this.ensureGame(size, rule);

    this.send('INFO timeout_turn ' + timeoutMs);
    this.send('INFO strength ' + strength);
    this.send('INFO max_node ' + nodes);

    const rows = stones.map(s => s[0] + ',' + s[1] + ',' + (s[2] === engineColor ? 1 : 2));
    const command = ['BOARD'].concat(rows, 'DONE').join('\n');

    const { info, collect } = makeInfoCollector();

    this.listeners.unshift(collect);
    try {
      const move = await this.ask(command, line => {
        const m = /^(\d{1,2}),(\d{1,2})$/.exec(line);
        return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
      }, timeoutMs + 20000);
      return { move, info };
    } finally {
      const i = this.listeners.indexOf(collect);
      if (i >= 0) this.listeners.splice(i, 1);
    }
  }

  /* Score the best `count` placements for whoever is to move.
     YXBOARD sets the position without asking for a move, then YXNBEST runs a
     multi-PV search that reports each candidate as
        MESSAGE (rank) <eval> | <depth>-<seldepth> | <pv, starting at the move>
     and finishes by printing the best move, like an ordinary search. */
  async analyze(opts) {
    const { size, rule, stones, sideToMove, timeoutMs, count, nodes = 0 } = opts;
    await this.ensureGame(size, rule);

    this.send('INFO timeout_turn ' + timeoutMs);
    this.send('INFO strength 100');
    this.send('INFO max_node ' + nodes);

    const rows = stones.map(s => s[0] + ',' + s[1] + ',' + (s[2] === sideToMove ? 1 : 2));
    this.send(['YXBOARD'].concat(rows, 'DONE').join('\n'));

    /* The plain search info is collected too: a position Rapfi resolves by
       force skips multi-PV entirely, and its Eval is then the only value
       available for scoring the move that led here. */
    const { info, collect: collectInfo } = makeInfoCollector();

    let current = new Map();
    let previous = [];
    const collectRanks = line => {
      const m = /^MESSAGE\s+\((\d+)\)\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(.+)$/i.exec(line);
      if (!m) return;
      const rank = Number(m[1]);
      if (rank === 1) {
        // Each iteration restarts at rank 1; keep the last full set in case the
        // clock stops mid-iteration and the newest one is incomplete.
        if (current.size) previous = Array.from(current.values());
        current = new Map();
      }
      current.set(rank, {
        rank: rank,
        eval: m[2],
        depth: m[3],
        pv: m[4].trim().split(/\s+/)
      });
    };

    const collect = line => { collectRanks(line); collectInfo(line); };
    this.listeners.unshift(collect);
    try {
      const best = await this.ask('YXNBEST ' + count, line => {
        const m = /^(\d{1,2}),(\d{1,2})$/.exec(line);
        return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
      }, timeoutMs + 20000);

      const latest = Array.from(current.values());
      const candidates = (latest.length >= previous.length ? latest : previous)
        .sort((a, b) => a.rank - b.rank);
      return { best, candidates, info };
    } finally {
      const i = this.listeners.indexOf(collect);
      if (i >= 0) this.listeners.splice(i, 1);
    }
  }

  /* Pick a move the way a weaker player would: search at full strength, then
     take something from the top of the list rather than always the very best.
     `window` is how far below the best move, in Rapfi's eval units, a move may
     be and still be considered - 0 is the engine's own choice every time.

     Working in eval units rather than in ranks is what keeps the weak levels
     playable. A rank-based handicap ("play the third best move") throws games
     away, because in a forcing position the third best move loses on the spot.
     A window does not: when a four has to be blocked, every other reply is
     worse by thousands, so the window holds one move and the engine blocks,
     whatever the level. It only spreads out when the position genuinely offers
     several reasonable moves, which is exactly where a weaker player differs.

     Within the window the odds fall off towards the edge, so a level plays
     near-best more often than not and drifts rather than lurching. */
  async choose(opts) {
    const { size, rule, stones, engineColor, timeoutMs, window: slack, nodes = 0 } = opts;
    const { best, candidates, info } = await this.analyze({
      size, rule, stones, sideToMove: engineColor, timeoutMs, nodes,
      count: Math.max(2, Math.min(20, Math.round(slack / 60) + 3))
    });

    const scored = candidates.map(c => ({
      point: pointFromCoord(c.pv && c.pv[0]),
      value: evalToNumber(c.eval)
    })).filter(c => c.point);
    scored.sort((a, b) => b.value - a.value);

    // A position Rapfi resolves by force reports no ranked list at all.
    if (!scored.length) return { move: best, info };

    /* This handicaps a good player, not a weak one: the window shuts on its own
       exactly where the game is decided, since when a four has to be blocked
       every other reply is worse by thousands and the block is the only move
       inside it. That is right for the levels this serves. Making a beginner
       needs a different mechanism entirely, and it lives in the bundled engine
       rather than here - see the difficulty notes in app.js. */
    const top = scored[0].value;
    const inWindow = scored.filter(c => top - c.value <= slack);

    let roll = Math.random() * inWindow.reduce((sum, c) => sum + weightFor(c, top, slack), 0);
    for (const c of inWindow) {
      roll -= weightFor(c, top, slack);
      if (roll <= 0) return { move: c.point, info };
    }
    return { move: inWindow[0].point, info };
  }

  /* Renju forbids Black double threes, double fours and overlines, with the
     recursive twist that a three only counts if the move completing it into an
     open four is itself legal. Rather than re-derive that, ask the engine:
     YXSHOWFORBID answers with the points as concatenated 4-digit xxyy groups,
     terminated by a full stop, and always for Black whoever is to move. */
  async forbidden(opts) {
    const { size, rule, stones, sideToMove } = opts;
    await this.ensureGame(size, rule);

    const rows = stones.map(s => s[0] + ',' + s[1] + ',' + (s[2] === sideToMove ? 1 : 2));
    this.send(['YXBOARD'].concat(rows, 'DONE').join('\n'));

    const line = await this.ask('YXSHOWFORBID',
      l => (/^FORBID/i.test(l) ? l : undefined), 15000);

    const body = line.replace(/^FORBID\s*/i, '').replace(/\.\s*$/, '').trim();
    const points = [];
    for (let i = 0; i + 3 < body.length; i += 4) {
      const x = Number(body.slice(i, i + 2));
      const y = Number(body.slice(i + 2, i + 4));
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    return { points };
  }

  /* RESTART resets the board but keeps the hash table, so a new game on a familiar opening
     would start with the last game's search results already in memory: the engine plays
     it better the second time, and every measurement that replays openings (colour-swapped
     pairs) comes out skewed. YXHASHCLEAR empties the hash, so each game starts cold. */
  async newGame() {
    if (!this.proc) return;
    try {
      await this.ask('RESTART', l => /^OK\b/i.test(l) || undefined, 10000);
    } catch (err) {
      // Not fatal: every move is sent as a full BOARD, so state cannot drift.
      broadcast('engine', 'restart failed: ' + err.message);
    }
    try { this.send('YXHASHCLEAR'); } catch (e) { /* the process went away; it starts cold anyway */ }
  }

  stop() {
    if (!this.proc) return;
    try { this.send('END'); } catch (e) { /* already gone */ }
    const proc = this.proc;
    setTimeout(() => { try { proc.kill(); } catch (e) {} }, 500);
    this.proc = null;
  }

  /* Throw this instance away for good: kill the process at once (an engine stuck in a
     search ignores END) and refuse any further work, so late calls from an abandoned
     request fail fast instead of starting a new process. */
  retire() {
    this.retired = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill(); } catch (e) { /* already gone */ } }
  }
}

/* ----------------------------------------------------------- build probing */

function probeBuild(tag) {
  return new Promise(resolve => {
    if (!fs.existsSync(exeFor(tag))) return resolve(null);
    /* A hand-unpacked archive can arrive without the executable bit, which
       would otherwise look just like a CPU that cannot run the build. */
    if (process.platform !== 'win32') {
      try { fs.chmodSync(exeFor(tag), 0o755); } catch (e) {}
    }
    let out = '', settled = false;
    const proc = spawn(exeFor(tag), [], { cwd: ENGINE_DIR });
    const finish = ok => {
      if (settled) return;
      settled = true;
      try { proc.stdin.write('END\n'); proc.kill(); } catch (e) {}
      resolve(ok ? (/name="[^"]*"[^\n]*/.exec(out) || [''])[0] || 'ok' : null);
    };
    proc.stdout.on('data', d => {
      out += d.toString();
      if (/^OK\b/m.test(out)) finish(true);
    });
    proc.on('error', () => finish(false));
    proc.on('exit', () => finish(false));
    setTimeout(() => finish(false), 10000);
    proc.stdin.write('ABOUT\nSTART 15\n');
  });
}

async function selectBuild() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached && cached.tag && fs.existsSync(exeFor(cached.tag))) return cached;
  } catch (e) { /* no cache yet */ }

  for (const tag of BUILDS) {
    process.stdout.write('  probing ' + tag + ' ... ');
    const about = await probeBuild(tag);
    console.log(about ? 'works' : 'not supported by this CPU');
    if (about) {
      const picked = { tag, about };
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(picked, null, 2)); } catch (e) {}
      return picked;
    }
  }
  return null;
}

/* -------------------------------------------------------------------- http */

const sseClients = new Set();

function broadcast(kind, text) {
  if (!text) return;
  const payload = 'data: ' + JSON.stringify({ kind, text }) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(err); }
    });
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* Three engine processes. `engine` plays every size and rule except 19x19 renju, and
   serves all analysis (hints, scored options, review, forbidden points) at every size, so
   evaluations stay on one scale. `windowEngine` only chooses moves for 19x19 renju,
   inside a 15x15 window where the renju networks apply. `probeEngine` plays freestyle and
   only answers White's trap search in lost renju positions (white-resistance.js). The
   last two start on first use. Keeping the move choice on its own process is also what
   lets it ponder later without analysis requests stopping it. */
let engine = null;
let windowEngine = null;
let probeEngine = null;

const rankedPoints = r => r.candidates
  .map(c => ({ point: pointFromCoord(c.pv && c.pv[0]), eval: c.eval }))
  .filter(c => c.point);

/* The engine's move. Outside 19x19 renju this is the plain search (or the difficulty
   window's pick). On 19x19 renju the move comes from the 15x15 window when a valid
   placement exists and its move is legal on the real board; otherwise the 19x19 engine
   plays it, with a quarter of the turn if the window search already spent the turn.
   In renju, when that move leaves White mated by force, White's resistance policy may
   swap it for the losing move that sets Black the best forbidden-point trap (`resist:
   false` turns that off). `source` says which engine chose the move and why, for the
   game log. */
async function playMove(opts) {
  const { size, rule, stones, engineColor, timeoutMs, window: slack, nodes, handoverNodes, resist: resistOn = true, probeNodes } = opts;
  // At the top level there is nothing to sample from, so the plain search is both the
  // right answer and the cheaper way to get it.
  const pick = (eng, o) => eng.run(() => slack > 0
    ? eng.choose(Object.assign({ window: slack }, o))
    : eng.think(Object.assign({ strength: 100 }, o)));

  const result = size === 19 && rule === RULES.renju
    ? await windowedMove({ stones, engineColor, timeoutMs, nodes, handoverNodes, margin: WINDOW_MARGIN }, {
        windowPick: o => pick(windowEngine, Object.assign({ size: 15, rule }, o)),
        boardPick: o => pick(engine, Object.assign({ size, rule }, o)),
        forbiddenPoints: s => engine.run(() => engine.forbidden({ size, rule, stones: s, sideToMove: 1 }))
          .then(r => r.points)
      })
    : await pick(engine, { size, rule, stones, engineColor, timeoutMs, nodes });

  if (!resistOn || rule !== RULES.renju || engineColor !== 2) return result;

  const freestyle = RULES.freestyle;
  /* The policy only ever improves on a move that is already chosen, so it must never cost
     one. If it fails, or runs well past its 30% budget, the chosen move is played. The
     freestyle probe is disposable: on any failure the instance this request used is killed
     and a fresh one starts on next use, so a probe stuck mid-search never holds a queue. */
  const giveUpMs = Math.floor(timeoutMs * 0.3) + 1000;
  const probe = probeEngine;
  const resisted = await resistWithin({
    stones, ownMove: result.move, ownEval: result.info && result.info.eval, timeoutMs, probeNodes, size
  }, {
    candidates: (s, b) => engine.run(() => engine.analyze(Object.assign({ size, rule, stones: s, sideToMove: 2, count: 5 }, b)))
      .then(rankedPoints),
    forbiddenPoints: s => engine.run(() => engine.forbidden({ size, rule, stones: s, sideToMove: 1 }))
      .then(r => r.points),
    naturalMoves: (s, count, b) => probe.run(() => probe.analyze(Object.assign({ size, rule: freestyle, stones: s, sideToMove: 1, count }, b)))
      .then(rankedPoints),
    legalBest: (s, b) => engine.run(() => engine.think(Object.assign({ size, rule, stones: s, engineColor: 1, strength: 100 }, b)))
      .then(r => ({ point: r.move, eval: r.info.eval })),
    freestyleEval: (s, b) => probe.run(() => probe.think(Object.assign({ size, rule: freestyle, stones: s, engineColor: 2, strength: 100 }, b)))
      .then(r => r.info.eval)
  }, giveUpMs, err => {
    broadcast('engine', 'resistance skipped: ' + err.message);
    if (probeEngine === probe) {
      probe.retire();
      probeEngine = new Rapfi(probe.tag);
    }
  });

  if (!resisted) return result;
  if (resisted.error) {
    return Object.assign({}, result, { source: Object.assign({}, result.source, { resistanceError: resisted.error }) });
  }
  return Object.assign({}, result, {
    move: resisted.move,
    source: Object.assign({}, result.source, { resistance: resisted.report })
  });
}

let selected = null;

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/status') {
    return sendJson(res, 200, {
      available: !!selected,
      build: selected ? selected.tag : null,
      about: selected ? selected.about : null,
      running: !!(engine && engine.proc)
    });
  }

  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url === '/api/move' && req.method === 'POST') {
    if (!engine) return sendJson(res, 503, { error: 'no usable Rapfi build was found' });
    try {
      const body = await readJson(req);
      const size = boardSize(body.size);
      const rule = RULES[body.rule] != null ? RULES[body.rule] : 0;
      const stones = Array.isArray(body.stones) ? body.stones : [];
      const engineColor = body.engineColor === 2 ? 2 : 1;
      const timeoutMs = Math.min(120000, Math.max(50, Number(body.timeoutMs) || 1000));
      const window = Math.min(100000, Math.max(0, Number(body.window) || 0));
      // Node caps for deterministic tests only (test/window-parity.js); 0 is no cap.
      const nodes = Math.max(0, Math.floor(Number(body.nodes)) || 0);
      const handoverNodes = Math.max(0, Math.floor(Number(body.handoverNodes)) || 0);
      const probeNodes = Math.max(0, Math.floor(Number(body.probeNodes)) || 0);
      const resistOn = body.resist !== false;

      const result = await playMove({
        size, rule, stones, engineColor, timeoutMs, window, nodes, handoverNodes, resist: resistOn, probeNodes
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (url === '/api/analyze' && req.method === 'POST') {
    if (!engine) return sendJson(res, 503, { error: 'no usable Rapfi build was found' });
    try {
      const body = await readJson(req);
      const size = boardSize(body.size);
      const rule = RULES[body.rule] != null ? RULES[body.rule] : 0;
      const stones = Array.isArray(body.stones) ? body.stones : [];
      const sideToMove = body.sideToMove === 2 ? 2 : 1;
      const timeoutMs = Math.min(120000, Math.max(50, Number(body.timeoutMs) || 1000));
      const count = Math.min(50, Math.max(1, Number(body.count) || 5));

      const result = await engine.run(() => engine.analyze({
        size, rule, stones, sideToMove, timeoutMs, count
      }));
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (url === '/api/forbidden' && req.method === 'POST') {
    if (!engine) return sendJson(res, 503, { error: 'no usable Rapfi build was found' });
    try {
      const body = await readJson(req);
      const size = boardSize(body.size);
      const rule = RULES[body.rule] != null ? RULES[body.rule] : 0;
      const stones = Array.isArray(body.stones) ? body.stones : [];
      const sideToMove = body.sideToMove === 2 ? 2 : 1;

      const result = await engine.run(() => engine.forbidden({ size, rule, stones, sideToMove }));
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  /* The spectator window's right-drag cursor. spectate.bat's helper reads the
     mouse outside the browser and posts what it saw here; the page hears it on
     the event stream. Events are passed on as they came, in order. */
  if (url === '/api/cursor' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const events = Array.isArray(body.events) ? body.events : [];
      for (const ev of events) {
        if (!ev || ['down', 'move', 'up'].indexOf(ev.phase) < 0) continue;
        broadcast('cursor', { phase: ev.phase, x: Number(ev.x) || 0, y: Number(ev.y) || 0 });
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: 'bad cursor events' });
    }
  }

  if (url === '/api/newgame' && req.method === 'POST') {
    if (engine) await engine.run(() => engine.newGame());
    if (windowEngine) await windowEngine.run(() => windowEngine.newGame());
    if (probeEngine) await probeEngine.run(() => probeEngine.newGame());
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res);
});

(async () => {
  console.log('Rapfi Gomoku');
  if (!fs.existsSync(ENGINE_DIR)) {
    console.log('  engine/ folder is missing - the UI will fall back to the built-in engine');
  } else {
    selected = await selectBuild();
    if (selected) {
      console.log('  using ' + selected.tag + ' build');
      engine = new Rapfi(selected.tag);
      engine.start();
      windowEngine = new Rapfi(selected.tag);   // spawned by its first 19x19 renju move
      probeEngine = new Rapfi(selected.tag);    // spawned by White's first lost renju position
    } else {
      console.log('  no runnable Rapfi build - the UI will fall back to the built-in engine');
    }
  }

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('  port ' + PORT + ' is already in use. Set PORT=<other> and retry.');
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('  open http://127.0.0.1:' + PORT + '  (Ctrl+C to stop)');
  });
})();

function shutdown() {
  if (engine) engine.stop();
  if (windowEngine) windowEngine.stop();
  if (probeEngine) probeEngine.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
