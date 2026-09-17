/*
 * Unit test for White's lost-position policy (white-resistance.js), with stub engines so
 * each decision can be forced: when it stays out of the way, how it scores a trap, and how
 * it ranks candidates.
 *
 *   node test/white-resistance.js
 *
 * Exits non-zero on failure.
 */
'use strict';

const assert = require('assert');
const { resist, resistWithin, matedIn, winRate } = require('../white-resistance');

const STONES = [[9, 9, 1], [10, 10, 2], [9, 10, 1]];
const P = (x, y) => ({ x, y });

/* Candidates are fixed; for each White candidate (keyed "x,y") the stubs give Black's
   forbidden points, Black's freestyle natural moves, Black's renju legal best, and the
   freestyle eval for White after that legal move. */
function stubs({ candidates, byMove = {} }) {
  const calls = { candidates: 0, forbidden: 0, natural: 0, legal: 0, freestyle: 0 };
  const key = stones => { const s = stones[STONES.length]; return s ? `${s[0]},${s[1]}` : ''; };
  return {
    calls,
    engines: {
      candidates: async () => { calls.candidates++; return candidates; },
      forbiddenPoints: async s => { calls.forbidden++; return (byMove[key(s)] || {}).forbidden || []; },
      naturalMoves: async s => { calls.natural++; return (byMove[key(s)] || {}).natural || []; },
      legalBest: async s => { calls.legal++; return (byMove[key(s)] || {}).legal || { point: P(0, 0), eval: '0' }; },
      freestyleEval: async s => { calls.freestyle++; return (byMove[key(s)] || {}).whiteAfterLegal || '0'; }
    }
  };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('helpers: mate parsing and win rate', () => {
  assert.strictEqual(matedIn('-M12'), 12);
  assert.strictEqual(matedIn('M12'), null);
  assert.strictEqual(matedIn('-300'), null);
  assert.strictEqual(winRate('M3'), 1);
  assert.strictEqual(winRate('-M3'), 0);
  assert.ok(Math.abs(winRate('0') - 0.5) < 1e-9);
});

test('not lost: the policy stays out of the way and asks no engine', async () => {
  const { calls, engines } = stubs({ candidates: [] });
  const r = await resist({ stones: STONES, ownMove: P(5, 5), ownEval: '-800', timeoutMs: 1000 }, engines);
  assert.strictEqual(r, null);
  assert.strictEqual(calls.candidates, 0);
});

test('a non-losing candidate in the list keeps the normal move', async () => {
  const { engines } = stubs({ candidates: [
    { point: P(5, 5), eval: '-M9' }, { point: P(6, 6), eval: '-2400' }
  ] });
  const r = await resist({ stones: STONES, ownMove: P(5, 5), ownEval: '-M9', timeoutMs: 1000 }, engines);
  assert.strictEqual(r, null);
});

test('no traps anywhere: the engine\'s own move stands, even against a longer listed mate', async () => {
  const { engines } = stubs({ candidates: [
    { point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M11' }, { point: P(7, 7), eval: '-M7' }
  ] });
  const r = await resist({ stones: STONES, ownMove: P(5, 5), ownEval: '-M5', timeoutMs: 1000 }, engines);
  assert.deepStrictEqual(r.move, P(5, 5));
  assert.strictEqual(r.report.replaced, null);
  assert.strictEqual(r.report.chosen.trap, 0);
});

test('a forbidden natural move with a clearly worse legal reply beats a longer mate', async () => {
  const { engines } = stubs({
    candidates: [{ point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M15' }],
    byMove: {
      '5,5': {
        forbidden: [P(8, 8)],
        natural: [{ point: P(8, 8), eval: 'M3' }, { point: P(3, 3), eval: '200' }],
        legal: { point: P(4, 4), eval: '100' },
        whiteAfterLegal: '-50'                 // Black about 56% after the legal move
      }
    }
  });
  const r = await resist({ stones: STONES, ownMove: P(6, 6), ownEval: '-M15', timeoutMs: 1000 }, engines);
  assert.deepStrictEqual(r.move, P(5, 5));
  assert.ok(r.report.chosen.trap > 0.4, 'trap score ' + r.report.chosen.trap);
});

test('a forbidden point with an equally good legal neighbour is no trap', async () => {
  const { engines } = stubs({
    candidates: [{ point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M15' }],
    byMove: {
      '5,5': {
        forbidden: [P(8, 8)],
        natural: [{ point: P(8, 8), eval: 'M3' }, { point: P(8, 9), eval: 'M3' }],
        legal: { point: P(8, 9), eval: 'M3' }  // the legal best is listed and just as winning
      }
    }
  });
  const r = await resist({ stones: STONES, ownMove: P(6, 6), ownEval: '-M15', timeoutMs: 1000 }, engines);
  assert.deepStrictEqual(r.move, P(6, 6), 'no trap, so the engine\'s own move stands');
  assert.strictEqual(r.report.weighed[0].trap, 0);
});

test('a forbidden point Black would not want anyway is no trap', async () => {
  const { calls, engines } = stubs({
    candidates: [{ point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M9' }],
    byMove: { '5,5': { forbidden: [P(1, 1)], natural: [{ point: P(8, 8), eval: 'M3' }] } }
  });
  const r = await resist({ stones: STONES, ownMove: P(5, 5), ownEval: '-M5', timeoutMs: 1000 }, engines);
  assert.deepStrictEqual(r.move, P(5, 5), 'no trap, so the engine\'s own move stands');
  assert.strictEqual(calls.legal, 0, 'no legal-move search when nothing natural is forbidden');
});

test('a legal reply that wins on the spot is no trap, and the finished board is not searched', async () => {
  // Black stones on row 12 from x=5 to x=8; after White's candidate, Black's legal best
  // (9,12) completes five.
  const stones = [[5, 12, 1], [0, 0, 2], [6, 12, 1], [0, 2, 2], [7, 12, 1], [0, 4, 2], [8, 12, 1]];
  const { calls, engines } = stubs({ candidates: [{ point: P(18, 18), eval: '-M1' }] });
  engines.forbiddenPoints = async () => [P(4, 4)];
  engines.naturalMoves = async () => [{ point: P(4, 4), eval: 'M1' }, { point: P(9, 12), eval: 'M1' }].slice(0, 1);
  engines.legalBest = async () => ({ point: P(9, 12), eval: 'M1' });
  const r = await resist({ stones, ownMove: P(18, 18), ownEval: '-M1', timeoutMs: 1000, size: 19 }, engines);
  assert.strictEqual(calls.freestyle, 0, 'no search on a board Black has already won');
  assert.strictEqual(r.report.chosen.trap, 0);
  assert.deepStrictEqual(r.move, P(18, 18));
});

test('an equally long mate does not replace the engine\'s own move', async () => {
  const { engines } = stubs({ candidates: [
    { point: P(5, 5), eval: '-M6' }, { point: P(6, 6), eval: '-M6' }, { point: P(7, 7), eval: '-M4' }
  ] });
  const r = await resist({ stones: STONES, ownMove: P(6, 6), ownEval: '-M6', timeoutMs: 1000 }, engines);
  assert.deepStrictEqual(r.move, P(6, 6));
  assert.strictEqual(r.report.replaced, null);
});

test('a probe that never answers: give up on time, report the failure, then the next turn works', async () => {
  const lost = { stones: STONES, ownMove: P(5, 5), ownEval: '-M5', timeoutMs: 1000 };
  // Turn 1: forbidden points exist, so the freestyle probe is asked, and it never answers.
  const hung = stubs({ candidates: [{ point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M7' }] });
  hung.engines.forbiddenPoints = async () => [P(8, 8)];
  hung.engines.naturalMoves = () => new Promise(() => {});
  const failures = [];
  const started = Date.now();
  const r1 = await resistWithin(lost, hung.engines, 200, err => failures.push(err.message));
  const took = Date.now() - started;
  assert.ok(r1 && r1.error, 'returns an error so the caller plays its own move');
  assert.strictEqual(failures.length, 1, 'the caller is told, so it can throw the probe away');
  assert.ok(took >= 190 && took < 600, 'gave up on time: ' + took + ' ms');

  // Turn 2: a fresh probe that answers; the policy works normally again.
  const fresh = stubs({ candidates: [{ point: P(5, 5), eval: '-M5' }] });
  const r2 = await resistWithin(lost, fresh.engines, 200, err => failures.push(err.message));
  assert.ok(r2 && !r2.error, 'next turn succeeds');
  assert.deepStrictEqual(r2.move, P(5, 5));
  assert.strictEqual(failures.length, 1, 'no new failure');
});

test('an engine error is a failure too, not a lost move', async () => {
  const broken = stubs({ candidates: [] });
  broken.engines.candidates = async () => { throw new Error('engine timed out after 20150ms'); };
  const failures = [];
  const r = await resistWithin({ stones: STONES, ownMove: P(5, 5), ownEval: '-M5', timeoutMs: 1000 }, broken.engines, 500, e => failures.push(e));
  assert.strictEqual(r.error, 'engine timed out after 20150ms');
  assert.strictEqual(failures.length, 1);
});

test('no forbidden points: only the forbidden query is made per candidate', async () => {
  const { calls, engines } = stubs({ candidates: [{ point: P(5, 5), eval: '-M5' }, { point: P(6, 6), eval: '-M9' }] });
  await resist({ stones: STONES, ownMove: P(5, 5), ownEval: '-M5', timeoutMs: 1000 }, engines);
  assert.strictEqual(calls.forbidden, 2);
  assert.strictEqual(calls.natural, 0);
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
