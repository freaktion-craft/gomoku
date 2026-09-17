/*
 * Regression test for the rule-switch weight bug in Rapfi 0.43.01.
 *
 * With two or more search threads, changing the rule in a running engine process
 * kept the network of the first rule it loaded. server.js works around it in
 * ensureGame(). This starts the bridge with RAPFI_THREADS=2 on a spare port,
 * analyses a position under freestyle, renju, standard and freestyle again in turn,
 * and checks the engine output for the weight files each rule should load.
 *
 *   node test/rule-switch.js
 *
 * Needs the engine in engine/ (get-engine.cmd). Exits non-zero on failure.
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8791;
const ROOT = path.join(__dirname, '..');

// The weight file each rule must load, as named in engine/config.toml.
const STEPS = [
  { rule: 'freestyle', weights: /freestyle_bsmix/ },
  { rule: 'renju', weights: /renju_bs15_black/ },
  { rule: 'standard', weights: /standard_bs15/ },
  { rule: 'freestyle', weights: /freestyle_bsmix/ }
];

const loaded = [];

function post(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function listen() {
  http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(block);
        if (!m) continue;
        const msg = JSON.parse(m[1]);
        const w = /load weight from (\S+)/.exec(msg.text || '');
        if (msg.kind === 'line' && w) loaded.push(w[1]);
      }
    });
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/api/status' }, res => {
          let t = '';
          res.on('data', c => { t += c; });
          res.on('end', () => resolve(JSON.parse(t)));
        }).on('error', reject);
      });
      if (status.available) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('bridge did not come up on port ' + PORT);
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), RAPFI_THREADS: '2' }),
    stdio: 'ignore'
  });
  let failed = false;
  try {
    await waitForServer();
    listen();
    await new Promise(r => setTimeout(r, 300));
    for (const step of STEPS) {
      const before = loaded.length;
      await post('/api/analyze', {
        size: 15, rule: step.rule, sideToMove: 2, timeoutMs: 300, count: 1,
        stones: [[7, 7, 1]]
      });
      await new Promise(r => setTimeout(r, 300));   // let the last event lines arrive
      const now = loaded.slice(before);
      const ok = now.some(f => step.weights.test(f));
      if (!ok) failed = true;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${step.rule}: loaded ${now.length ? now.join(', ') : 'nothing'}`);
    }
  } catch (err) {
    failed = true;
    console.log('FAIL ' + err.message);
  } finally {
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
