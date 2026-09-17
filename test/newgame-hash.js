/*
 * Check that a new game starts with an empty hash table.
 *
 * Starts the bridge on port 8795 with one search thread and searches one position at a
 * fixed node count three times: once cold, once again with the hash warm from the first
 * search, and once more after POST /api/newgame. With one thread and a node cap the search
 * is deterministic, so the third result must equal the first. The event stream is also
 * checked for YXHASHCLEAR, once for every engine process that was running.
 *
 *   node test/newgame-hash.js
 *
 * Exits non-zero on failure.
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8795;
const sent = [];

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

function listen() {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, res => {
    res.on('error', () => { /* the bridge is stopped at the end */ });
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const m = /^data: (.*)$/m.exec(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (!m) continue;
        const msg = JSON.parse(m[1]);
        if (msg.kind === 'sent') sent.push(msg.text);
      }
    });
  });
  req.on('error', () => { /* the bridge is stopped at the end */ });
}

(async () => {
  const bridge = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), RAPFI_THREADS: '1' }),
    stdio: 'ignore'
  });
  let failed = false;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed = true; };
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await request('GET', '/api/status')).available) break; } catch (e) { /* not up */ }
      await new Promise(r => setTimeout(r, 500));
    }
    listen();
    await new Promise(r => setTimeout(r, 300));

    // A freestyle 15x15 position, so only the main engine process is involved.
    const position = {
      size: 15, rule: 'freestyle', engineColor: 1, timeoutMs: 60000, nodes: 60000,
      stones: [[7, 7, 1], [8, 8, 2], [7, 8, 1], [6, 9, 2], [8, 6, 1]]
    };
    const summary = r => `${r.move && r.move.x},${r.move && r.move.y} eval ${r.info.eval} nodes ${r.info.nodes} depth ${r.info.depth}`;
    const cold = await request('POST', '/api/move', position);
    const warm = await request('POST', '/api/move', position);
    // One 19x19 renju move starts the window engine as well, so a new game has two
    // processes to clear. (The freestyle probe only starts in a lost White position.)
    await request('POST', '/api/move', {
      size: 19, rule: 'renju', engineColor: 2, timeoutMs: 200, stones: [[9, 9, 1]]
    });
    const cleared = sent.length;
    await request('POST', '/api/newgame');
    await new Promise(r => setTimeout(r, 300));
    const again = await request('POST', '/api/move', position);

    console.log(`cold:  ${summary(cold)}\nwarm:  ${summary(warm)}\nafter new game: ${summary(again)}`);
    check(summary(warm) !== summary(cold), 'a warm hash changes the search (so the check below means something)');
    check(summary(again) === summary(cold), 'after a new game the search matches the cold one');
    const clears = sent.slice(cleared).filter(t => t === 'YXHASHCLEAR').length;
    check(clears === 2, `YXHASHCLEAR sent once per running engine process (${clears} for 2: main and window)`);
  } catch (err) {
    check(false, err.message);
  } finally {
    bridge.kill();
  }
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
