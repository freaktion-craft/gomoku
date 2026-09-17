/*
 * Unit test for the window engine's move decision (window-engine.js windowedMove), with
 * stub engines in place of Rapfi so each path runs on demand. The parity test plays real
 * games, where a window move is almost never occupied or forbidden, so those paths need
 * forcing here.
 *
 *   node test/window-handover.js
 *
 * Exits non-zero on failure.
 */
'use strict';

const assert = require('assert');
const { chooseWindow, windowedMove } = require('../window-engine');

// A small cluster near the centre, so a window fits.
const STONES = [[9, 9, 1], [9, 10, 2], [10, 9, 1], [8, 10, 2]];
const MARGIN = 2;

/* Stub engines: the window proposes `windowMove` (in window coordinates), the 19x19 board
   engine always answers `boardMove`, and `forbidden` lists Black's forbidden points. Every
   call is recorded. */
function stubs({ windowMove, boardMove = { x: 0, y: 18 }, forbidden = [] }) {
  const calls = { windowPick: [], boardPick: [], forbiddenPoints: [] };
  return {
    calls,
    engines: {
      windowPick: async o => { calls.windowPick.push(o); return { move: windowMove, info: { eval: '10' } }; },
      boardPick: async o => { calls.boardPick.push(o); return { move: boardMove, info: { eval: '-20' } }; },
      forbiddenPoints: async s => { calls.forbiddenPoints.push(s); return forbidden; }
    }
  };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const origin = chooseWindow(STONES, MARGIN);
const toLocal = (x, y) => ({ x: x - origin.ox, y: y - origin.oy });

test('a window fits the test position', () => {
  assert.ok(origin, 'expected a valid window for a central cluster');
});

test('legal window move is played, translated to the real board', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(11, 11) });
  const r = await windowedMove({ stones: STONES, engineColor: 1, timeoutMs: 1600, margin: MARGIN }, engines);
  assert.deepStrictEqual(r.move, { x: 11, y: 11 });
  assert.strictEqual(r.source.engine, 'window');
  assert.strictEqual(calls.boardPick.length, 0);
  assert.strictEqual(calls.forbiddenPoints.length, 1, 'Black move checked against forbidden points');
});

test('window move forbidden for Black hands over with a quarter of the turn', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(11, 11), forbidden: [{ x: 5, y: 5 }, { x: 11, y: 11 }] });
  const r = await windowedMove({ stones: STONES, engineColor: 1, timeoutMs: 1600, margin: MARGIN }, engines);
  assert.strictEqual(r.source.engine, 'handover');
  assert.strictEqual(r.source.reason, 'window move forbidden for Black');
  assert.deepStrictEqual(r.source.proposed, { x: 11, y: 11 });
  assert.deepStrictEqual(r.move, { x: 0, y: 18 });
  assert.strictEqual(calls.boardPick.length, 1);
  assert.strictEqual(calls.boardPick[0].timeoutMs, 400);
  assert.strictEqual(calls.boardPick[0].stones, STONES, 'the board engine searches the real position');
});

test('a forbidden point elsewhere does not reject the window move', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(11, 11), forbidden: [{ x: 12, y: 12 }] });
  const r = await windowedMove({ stones: STONES, engineColor: 1, timeoutMs: 1600, margin: MARGIN }, engines);
  assert.strictEqual(r.source.engine, 'window');
  assert.strictEqual(calls.boardPick.length, 0);
});

test('window move on an occupied point hands over', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(9, 10) });
  const r = await windowedMove({ stones: STONES, engineColor: 2, timeoutMs: 1600, margin: MARGIN }, engines);
  assert.strictEqual(r.source.engine, 'handover');
  assert.strictEqual(r.source.reason, 'window move on an occupied point');
  assert.strictEqual(calls.forbiddenPoints.length, 0);
  assert.strictEqual(calls.boardPick[0].timeoutMs, 400);
});

test('White is never checked for forbidden points', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(11, 11), forbidden: [{ x: 11, y: 11 }] });
  const r = await windowedMove({ stones: STONES, engineColor: 2, timeoutMs: 1600, margin: MARGIN }, engines);
  assert.strictEqual(r.source.engine, 'window');
  assert.strictEqual(calls.forbiddenPoints.length, 0);
});

test('fixed handover nodes replace the quarter turn after a rejection', async () => {
  const { calls, engines } = stubs({ windowMove: toLocal(11, 11), forbidden: [{ x: 11, y: 11 }] });
  await windowedMove({ stones: STONES, engineColor: 1, timeoutMs: 1600, nodes: 20000, handoverNodes: 5000, margin: MARGIN }, engines);
  assert.strictEqual(calls.boardPick[0].nodes, 5000);
  assert.strictEqual(calls.boardPick[0].timeoutMs, 1600);
});

test('no valid window: the board engine plays with the full turn', async () => {
  // Stones against opposite corners cannot all sit inside one window.
  const wide = [[0, 0, 1], [18, 18, 2], [0, 18, 1]];
  const { calls, engines } = stubs({ windowMove: { x: 7, y: 7 } });
  const r = await windowedMove({ stones: wide, engineColor: 2, timeoutMs: 1600, nodes: 20000, handoverNodes: 5000, margin: MARGIN }, engines);
  assert.strictEqual(r.source.engine, 'handover');
  assert.strictEqual(r.source.reason, 'no valid window');
  assert.strictEqual(calls.windowPick.length, 0);
  assert.strictEqual(calls.boardPick[0].timeoutMs, 1600);
  assert.strictEqual(calls.boardPick[0].nodes, 20000);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log('ok   ' + c.name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + c.name + ': ' + err.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
