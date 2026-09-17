/*
 * The bridge as a Gomocup engine, so the app's own move selection can play in match
 * runners such as c-gomoku-cli. Each instance starts its own bridge (server.js) on a free
 * port with its own Rapfi processes, and answers the runner's moves through /api/move.
 *
 *   node test/bridge-engine.js [--resist 0|1] [--window N] [--threads N]
 *
 * --resist 0 turns off White's lost-position policy; --window gives the Difficulty
 * window (0 = full strength). Board size comes from START, the rule from INFO rule, and
 * the turn time from INFO timeout_turn (INFO max_node is passed on as a node cap).
 * Only 15x15 and 19x19 play through the app's own paths; other sizes are passed through.
 */
'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const RESIST = opt('resist', '1') !== '0';
const WINDOW = Number(opt('window', '0'));
const THREADS = opt('threads', '1');
const RULE_NAMES = { 0: 'freestyle', 1: 'standard', 4: 'renju' };

const out = line => process.stdout.write(line + '\n');

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let port = 0;
let bridge = null;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
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

async function startBridge() {
  if (bridge) return;
  port = await freePort();
  bridge = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), RAPFI_THREADS: THREADS }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await request('GET', '/api/status')).available) return; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('bridge did not start');
}

let size = 15;
let rule = 'freestyle';
let turnMs = 5000;
let nodes = 0;
let stones = [];              // [x, y, colour] in play order
let queue = Promise.resolve();
let boardRows = null;

const colourToMove = () => (stones.length % 2 === 0 ? 1 : 2);

async function think() {
  const engineColor = colourToMove();
  const reply = await request('POST', '/api/move', {
    size, rule, stones, engineColor, timeoutMs: turnMs, window: WINDOW, nodes, resist: RESIST
  });
  if (reply.error) { out('ERROR ' + reply.error); return; }
  const src = reply.source || {};
  if (src.resistance) {
    const r = src.resistance;
    out(`MESSAGE resistance chosen ${r.chosen.point.x},${r.chosen.point.y} mate ${r.chosen.mate} trap ${r.chosen.trap.toFixed(3)} replaced ${r.replaced ? r.replaced.x + ',' + r.replaced.y : 'none'} probed ${r.probed} forbidden ${r.withForbidden} natural ${r.withForbiddenNatural} ${r.ms}ms`);
  }
  if (src.engine) out(`MESSAGE source ${src.engine}${src.reason ? ' (' + src.reason + ')' : ''}`);
  if (reply.info && reply.info.eval != null) out(`MESSAGE Depth ${reply.info.depth || 0} | Eval ${reply.info.eval}`);
  stones.push([reply.move.x, reply.move.y, engineColor]);
  out(`${reply.move.x},${reply.move.y}`);
}

function enqueue(job) { queue = queue.then(job).catch(err => out('ERROR ' + err.message)); }

function handle(raw) {
  const line = raw.trim();
  if (!line) return;
  if (boardRows) {
    if (/^DONE$/i.test(line)) {
      // BOARD rows arrive in play order; colours follow from parity.
      stones = boardRows.map((r, i) => { const [x, y] = r.split(',').map(Number); return [x, y, i % 2 === 0 ? 1 : 2]; });
      boardRows = null;
      enqueue(think);
    } else boardRows.push(line);
    return;
  }
  const [cmd, ...rest] = line.split(/\s+/);
  switch (cmd.toUpperCase()) {
    case 'START':
      size = Number(rest[0]);
      stones = [];
      enqueue(async () => { await startBridge(); await request('POST', '/api/newgame'); out('OK'); });
      return;
    case 'RESTART':
      stones = [];
      enqueue(async () => { await request('POST', '/api/newgame'); out('OK'); });
      return;
    case 'INFO': {
      const key = (rest[0] || '').toLowerCase();
      if (key === 'rule') rule = RULE_NAMES[Number(rest[1])] || 'freestyle';
      else if (key === 'timeout_turn' && Number(rest[1]) > 0) turnMs = Number(rest[1]);
      else if (key === 'max_node') nodes = Number(rest[1]) || 0;
      return;
    }
    case 'BEGIN':
      enqueue(think);
      return;
    case 'TURN': {
      const [x, y] = rest[0].split(',').map(Number);
      stones.push([x, y, colourToMove()]);
      enqueue(think);
      return;
    }
    case 'BOARD':
      boardRows = [];
      return;
    case 'ABOUT':
      out(`name="bridge${RESIST ? '' : '-noresist'}${WINDOW ? '-w' + WINDOW : ''}", version="1", author="gomoku", country="-"`);
      return;
    case 'END':
      if (bridge) bridge.kill();
      setTimeout(() => process.exit(0), 300);
      return;
    default:
      return;
  }
}

readline.createInterface({ input: process.stdin }).on('line', handle);
process.stdin.on('end', () => { if (bridge) bridge.kill(); setTimeout(() => process.exit(0), 300); });
