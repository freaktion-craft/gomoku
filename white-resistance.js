/*
 * White's move in a lost renju position.
 *
 * Renju gives White one weapon Black does not have: Black may not play double threes,
 * double fours or overlines. When every move White has already loses by force, Rapfi's
 * own pick is simply the move it searched best, which says nothing about how hard the win
 * is to find. This picks instead the losing move most likely to lead a human Black onto a
 * forbidden point. Where no candidate sets a trap, the engine's own move stands.
 *
 * A trap is a point Black would naturally want that renju forbids, where the best legal
 * alternative is clearly worse. "Naturally want" cannot come from a renju search, which
 * never considers forbidden points, so it comes from a second engine playing freestyle.
 * Both sides of the comparison are scored by that same freestyle engine, so the numbers
 * are on one scale:
 *   gap = win chance after Black's natural move - win chance after Black's legal best
 * for each natural move that renju forbids, weighted by how highly the freestyle engine
 * ranked it. The legal best comes from the renju engine and the forbidden set from
 * YXSHOWFORBID. The freestyle search after the legal move still lets Black use forbidden
 * points further on, so the gap is a lower bound: it errs towards "no trap".
 *
 * It never overrides a move that is not lost. It only acts when the engine's own move
 * reports a mate against White and every candidate in the ranked list does too, and it
 * stops probing once its time budget is spent, keeping what it has.
 *
 * The engines come in as functions, so the choice can be tested without Rapfi:
 *   candidates(stones, budget)          -> [{ point, eval }] best first, White to move, renju
 *   forbiddenPoints(stones)             -> [{ x, y }] Black may not play
 *   naturalMoves(stones, count, budget) -> [{ point, eval }] best first, Black to move, freestyle
 *   legalBest(stones, budget)           -> { point, eval } Black to move, renju
 *   freestyleEval(stones, budget)       -> eval string for White to move, freestyle
 * Stones are [x, y, colour] in play order, colour 1 black, 2 white; evals are Rapfi's,
 * from the side to move's point of view ("-M12" is mated in 12).
 */
'use strict';

const SCALING = 200;            // Rapfi's win-rate scaling factor
const RANK_WEIGHTS = [1, 0.6, 0.35, 0.2, 0.1];

/* Mate distance of a mate against the side to move, or null. */
function matedIn(text) {
  const m = /^-M(\d+)$/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/* Win chance for the side to move, mates clamped to 0 and 1. */
function winRate(text) {
  const s = String(text || '');
  const m = /^([+-]?)M\d+$/i.exec(s);
  if (m) return m[1] === '-' ? 0 : 1;
  const v = Number(s);
  return Number.isFinite(v) ? 1 / (1 + Math.exp(-v / SCALING)) : 0.5;
}

const same = (p, q) => p && q && p.x === q.x && p.y === q.y;

/* Does a stone of `colour` at (x, y) complete five or more in a row? */
function makesFive(stones, x, y, colour, size) {
  const at = new Map(stones.map(s => [s[0] * 64 + s[1], s[2]]));
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let run = 1;
    for (const s of [1, -1]) {
      for (let k = 1; ; k++) {
        const px = x + s * k * dx, py = y + s * k * dy;
        if (px < 0 || py < 0 || px >= size || py >= size || at.get(px * 64 + py) !== colour) break;
        run++;
      }
    }
    if (run >= 5) return true;
  }
  return false;
}

/* How much of a trap it is for Black after White plays `move`. */
async function trapScore(stones, move, engines, budget, size) {
  const after = stones.concat([[move.x, move.y, 2]]);
  // `forbidden` and `forbiddenNatural` are counted whatever the score, so a report can
  // tell positions without traps apart from traps the gap test turned down.
  const forbidden = await engines.forbiddenPoints(after);
  if (!forbidden.length) return { score: 0, traps: [], forbidden: 0, forbiddenNatural: 0 };

  const natural = await engines.naturalMoves(after, RANK_WEIGHTS.length, budget);
  const trapped = natural
    .map((n, rank) => ({ n, rank }))
    .filter(({ n }) => forbidden.some(f => same(f, n.point)));
  const counts = { forbidden: forbidden.length, forbiddenNatural: trapped.length };
  if (!trapped.length) return Object.assign({ score: 0, traps: [] }, counts);

  const legal = await engines.legalBest(after, budget);
  let legalRate;
  const listed = natural.find(n => same(n.point, legal.point));
  if (makesFive(after, legal.point.x, legal.point.y, 1, size)) {
    // Black's legal move already wins, so nothing is a trap. The finished board is not
    // searched: an engine asked to move on it errors or never answers.
    legalRate = 1;
  } else if (listed) {
    legalRate = winRate(listed.eval);
  } else {
    // Score the legal move with the freestyle engine too: White to move after it.
    const whiteEval = await engines.freestyleEval(after.concat([[legal.point.x, legal.point.y, 1]]), budget);
    legalRate = 1 - winRate(whiteEval);
  }

  const traps = trapped.map(({ n, rank }) => ({
    point: n.point,
    rank: rank + 1,
    gap: Math.max(0, winRate(n.eval) - legalRate)
  }));
  const score = traps.reduce((s, t) => s + RANK_WEIGHTS[t.rank - 1] * t.gap, 0);
  return Object.assign({ score, traps, legal: legal.point }, counts);
}

/* Returns null when the policy does not apply (the position is not lost for White), or
   { move, report } with the chosen move and what was weighed. `ownMove` and `ownEval`
   are the move and eval of the normal search, which the policy only replaces. */
async function resist(opts, engines) {
  const { stones, ownMove, ownEval, timeoutMs, probeNodes = 0, size = 19 } = opts;
  if (matedIn(ownEval) == null) return null;

  const started = Date.now();
  const limit = Math.max(50, Math.floor(timeoutMs * 0.3));
  const budget = { timeoutMs: Math.max(30, Math.floor(timeoutMs * 0.05)), nodes: probeNodes };

  const list = await engines.candidates(stones, { timeoutMs: Math.max(30, Math.floor(timeoutMs * 0.1)), nodes: probeNodes });
  if (!list.length || list.some(c => matedIn(c.eval) == null)) return null;

  const weighed = list.map((c, i) => ({ point: c.point, rank: i + 1, mate: matedIn(c.eval), trap: null }));
  // A candidate is only probed if the slowest probe so far would still fit in the budget,
  // so the policy does not start one it cannot finish in time.
  let slowest = 0;
  for (const c of weighed) {
    const at = Date.now();
    if (at - started + slowest > limit) break;
    const t = await trapScore(stones, c.point, engines, budget, size);
    slowest = Math.max(slowest, Date.now() - at);
    c.trap = t.score;
    c.traps = t.traps;
    c.forbidden = t.forbidden;
    c.forbiddenNatural = t.forbiddenNatural;
  }

  /* Only a real trap replaces the engine's move. Picking the longest mate from the ranked
     list was tried first and made White lose sooner: -3.1 plies [-6.1, -0.1] over 18
     colour-swapped pairs, because the short multi-PV search that ranks the candidates
     judges mate distance less well than the full search that chose the engine's move.
     Among traps: most trap first, then the longest mate, then the list's order. */
  const traps = weighed.filter(c => c.trap > 0).sort((a, b) =>
    b.trap - a.trap || b.mate - a.mate || a.rank - b.rank);
  const chosen = traps.length
    ? { point: traps[0].point, mate: traps[0].mate, trap: traps[0].trap }
    : { point: ownMove, mate: matedIn(ownEval), trap: 0 };
  const probed = weighed.filter(c => c.trap != null);
  return {
    move: chosen.point,
    report: {
      replaced: same(chosen.point, ownMove) ? null : ownMove,
      chosen,
      weighed: weighed.map(c => ({
        point: c.point, mate: c.mate, trap: c.trap, forbidden: c.forbidden, forbiddenNatural: c.forbiddenNatural
      })),
      // how many candidates were probed, left a forbidden point for Black, and left one
      // among Black's natural moves, whether or not the gap made it a trap
      probed: probed.length,
      withForbidden: probed.filter(c => c.forbidden > 0).length,
      withForbiddenNatural: probed.filter(c => c.forbiddenNatural > 0).length,
      ms: Date.now() - started
    }
  };
}

/* resist(), but never allowed to cost the move: it gives up after `giveUpMs`, and on a
   give-up or any error calls `onFailure(err)` and returns { error } so the caller plays the
   move it already chose. The caller uses onFailure to throw away a probe engine that may be
   stuck mid-search, so a hung probe cannot hold up the next turn. */
async function resistWithin(opts, engines, giveUpMs, onFailure) {
  let timer;
  try {
    return await Promise.race([
      resist(opts, engines),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('resistance took over ' + giveUpMs + ' ms')), giveUpMs);
      })
    ]);
  } catch (err) {
    onFailure(err);
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resist, resistWithin, matedIn, winRate };
