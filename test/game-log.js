/*
 * Test for the bridge's game log (POST /api/log).
 *
 * Starts the bridge on port 8797 with GAME_LOG_DIR in a temporary folder, posts a game
 * record, posts it again, posts a malformed one, and checks the day's JSONL file: one
 * line, with a stable id, carrying the record as posted. Then starts it once more with
 * GAME_LOG=0 and checks that nothing is written.
 *
 *   node test/game-log.js
 *
 * Exits non-zero on failure.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8797;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withBridge(env, fn) {
  const bridge = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), RAPFI_THREADS: '1' }, env),
    stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await request('GET', '/api/status'); break; } catch (e) { await new Promise(r => setTimeout(r, 300)); }
    }
    await fn();
  } finally {
    bridge.kill();
    await new Promise(r => setTimeout(r, 500));
  }
}

const record = {
  app: 'rapfi-gomoku', savedAt: '2026-09-17T10:20:30.456Z', size: 19, rule: 'renju',
  opponent: 'ai-white', difficulty: 100, result: 'black',
  moves: [
    { n: 1, player: 'black', coord: 'K10', x: 9, y: 9 },
    { n: 2, player: 'white', coord: 'L11', x: 10, y: 8, eval: -40, grade: 'Good' }
  ]
};

(async () => {
  let failed = false;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed = true; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-log-'));
  try {
    await withBridge({ GAME_LOG_DIR: dir }, async () => {
      const first = await request('POST', '/api/log', record);
      check(first.status === 200 && first.body.logged === true, 'a finished game is logged');
      check(/^20260917T102030Z-[0-9a-f]{10}$/.test(first.body.id), 'the id is the save time plus a hash: ' + first.body.id);
      const again = await request('POST', '/api/log', record);
      check(again.body.duplicate === true && again.body.id === first.body.id, 'the same game posted again is recognised, not written twice');
      const other = Object.assign({}, record, { moves: record.moves.slice(0, 1) });
      const otherReply = await request('POST', '/api/log', other);
      check(otherReply.body.logged === true && otherReply.body.id !== first.body.id, 'a different game at the same time gets its own id');
      const bad = await request('POST', '/api/log', { moves: 'nope' });
      check(bad.status === 400, 'a malformed record is refused');

      const lines = fs.readFileSync(path.join(dir, '2026-09-17.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      check(lines.length === 2, 'two lines in the day\'s file');
      const logged = lines[0];
      check(logged.id === first.body.id && logged.rule === 'renju' && logged.size === 19 && logged.result === 'black' &&
            logged.moves.length === 2 && logged.moves[1].grade === 'Good', 'the line carries the record as posted, with its id first');
    });

    const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-log-off-'));
    await withBridge({ GAME_LOG_DIR: offDir, GAME_LOG: '0' }, async () => {
      const r = await request('POST', '/api/log', record);
      check(r.body.logged === false, 'GAME_LOG=0 turns the log off');
      check(fs.readdirSync(offDir).length === 0, 'and nothing is written');
    });
  } catch (err) {
    check(false, err.message);
  }
  process.exit(failed ? 1 : 0);
})();
