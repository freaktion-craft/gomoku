/*
 * Parity test for the 19x19 renju window engine: the bridge (POST /api/move) against
 * renju19's standalone window.js wrapper, which it was ported from.
 *
 * Both run Rapfi at fixed node counts with one search thread, so both are deterministic,
 * and both receive the same sequence of searches, so their hash tables stay in step. For
 * each opening the bridge plays a whole game against itself; at every ply the wrapper is
 * asked for its move on the same position, and the two must agree. The bridge's move is
 * the one played. The game ends at five in a row, a full board or MAX_PLIES.
 *
 *   node test/window-parity.js --wrapper D:/renju19-work/window/window.js \
 *        --openings <pos-notation file> [--games 20] [--nodes 20000] [--handover-nodes 5000]
 *
 * Openings are 15x15 pos notation ("h8i9...") and are centred on the 19x19 board. The
 * bridge is started on port 8792 with RAPFI_THREADS=1. Exits non-zero on any mismatch.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const WRAPPER = opt('wrapper');
const OPENINGS = opt('openings');
const GAMES = Number(opt('games', '20'));
const NODES = Number(opt('nodes', '20000'));
const HANDOVER_NODES = Number(opt('handover-nodes', '5000'));
const TIMEOUT_MS = 60000;            // far above what the node caps need, so nodes decide
const MAX_PLIES = 200;
const PORT = 8792;
const ROOT = path.join(__dirname, '..');
const N = 19;

if (!WRAPPER || !OPENINGS) {
  console.log('usage: node test/window-parity.js --wrapper <window.js> --openings <file> [--games N] [--nodes N] [--handover-nodes N]');
  process.exit(2);
}

const selected = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'selected-build.json'), 'utf8'));
const EXE = path.join(ROOT, 'engine', `pbrain-rapfi-windows-${selected.tag}.exe`).replace(/\\/g, '/');

/* ---- the bridge --------------------------------------------------------- */

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(text)); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function waitForBridge() {
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/api/status')).available) return; } catch (e) { /* not up */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('bridge did not come up on port ' + PORT);
}

/* ---- the wrapper -------------------------------------------------------- */

function startWrapper() {
  const log = path.join(os.tmpdir(), 'window-parity-stats.jsonl');
  const proc = spawn(process.execPath, [WRAPPER, '--margin', String(process.env.WINDOW_MARGIN || 2),
    '--exe', EXE, '--handover-nodes', String(HANDOVER_NODES), '--log', log],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = [];
  readline.createInterface({ input: proc.stdout }).on('line', raw => {
    const line = raw.trim();
    const w = waiters[0];
    if (w && w.match(line)) { waiters.shift(); w.resolve(line); }
  });
  const send = t => proc.stdin.write(t + '\n');
  const ask = (text, match) => new Promise(resolve => { waiters.push({ match, resolve }); send(text); });
  return { proc, send, ask };
}

/* ---- games -------------------------------------------------------------- */

// 15x15 pos notation, centred on 19x19: [[x, y, colour], ...]
function opening(line) {
  return [...line.matchAll(/([a-o])(\d{1,2})/g)]
    .map((m, i) => [m[1].charCodeAt(0) - 97 + 2, Number(m[2]) - 1 + 2, i % 2 === 0 ? 1 : 2]);
}

// Five for White is five or more; for Black under renju exactly five.
function finished(stones) {
  const g = new Int8Array(N * N);
  for (const [x, y, c] of stones) g[y * N + x] = c;
  const [x, y, c] = stones[stones.length - 1];
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let run = 1;
    for (const s of [1, -1]) {
      let k = 1;
      while (true) {
        const px = x + s * k * dx, py = y + s * k * dy;
        if (px < 0 || px >= N || py < 0 || py >= N || g[py * N + px] !== c) break;
        run++; k++;
      }
    }
    if (c === 2 ? run >= 5 : run === 5) return true;
  }
  return stones.length >= N * N;
}

(async () => {
  const bridge = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), RAPFI_THREADS: '1' }),
    stdio: 'ignore'
  });
  const wrapper = startWrapper();
  let failed = false;
  const tally = { plies: 0, same: 0, window: 0, handover: 0, bridgeMs: 0, wrapperMs: 0 };
  try {
    await waitForBridge();
    // The same game settings the bridge sends its engines, so both hash tables match.
    wrapper.send('INFO rule 4');
    wrapper.send('INFO game_type 0');
    wrapper.send('INFO timeout_match 0');
    wrapper.send('INFO max_memory ' + 512 * 1024 * 1024);
    wrapper.send('INFO strength 100');
    wrapper.send('INFO timeout_turn ' + TIMEOUT_MS);
    wrapper.send('INFO max_node ' + NODES);
    await wrapper.ask('START 19', l => /^OK/.test(l));

    const lines = fs.readFileSync(OPENINGS, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, GAMES);
    for (let gi = 0; gi < lines.length; gi++) {
      const stones = opening(lines[gi]);
      let mismatch = null;
      while (stones.length < MAX_PLIES && !(stones.length && finished(stones))) {
        const engineColor = stones.length % 2 === 0 ? 1 : 2;

        let t = Date.now();
        const reply = await request('POST', '/api/move', {
          size: 19, rule: 'renju', stones, engineColor, timeoutMs: TIMEOUT_MS,
          nodes: NODES, handoverNodes: HANDOVER_NODES
        });
        tally.bridgeMs += Date.now() - t;
        if (reply.error) throw new Error('bridge: ' + reply.error);

        t = Date.now();
        const board = ['BOARD'].concat(stones.map(s => `${s[0]},${s[1]},${s[2] === engineColor ? 1 : 2}`), 'DONE');
        const theirs = await wrapper.ask(board.join('\n'), l => /^\d+,\d+$/.test(l));
        tally.wrapperMs += Date.now() - t;

        const ours = `${reply.move.x},${reply.move.y}`;
        tally.plies++;
        tally[reply.source.engine]++;
        if (ours === theirs) tally.same++;
        else if (!mismatch) mismatch = { ply: stones.length + 1, ours, theirs, source: reply.source };
        stones.push([reply.move.x, reply.move.y, engineColor]);
      }
      if (mismatch) failed = true;
      console.log(`game ${String(gi + 1).padStart(2)}: ${stones.length} plies, ` +
        (mismatch ? `FIRST MISMATCH at ply ${mismatch.ply}: bridge ${mismatch.ours} (${mismatch.source.engine}, ${mismatch.source.reason || ''}) vs wrapper ${mismatch.theirs}` : 'all moves match'));
    }
  } catch (err) {
    failed = true;
    console.log('FAIL ' + err.message);
  } finally {
    wrapper.send('END');
    bridge.kill();
  }
  console.log(`\n${tally.plies} moves: ${tally.same} identical; bridge used the window ${tally.window} times, handed over ${tally.handover} times`);
  if (tally.plies) {
    console.log(`mean time per move: bridge ${(tally.bridgeMs / tally.plies).toFixed(1)} ms, wrapper ${(tally.wrapperMs / tally.plies).toFixed(1)} ms`);
  }
  setTimeout(() => process.exit(failed ? 1 : 0), 800);
})();
