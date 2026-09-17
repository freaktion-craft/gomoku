/*
 * Where to put a 15x15 window on a 19x19 renju board.
 *
 * Rapfi's renju networks are trained on 15x15 only; at 19x19 it falls back to its
 * classical evaluator, which plays renju measurably worse. So on a 19x19 renju board
 * the bridge lays a 15x15 window over the stones, asks a 15x15 renju engine for the move
 * inside it, and translates the answer back. Measured against plain 19x19 play on the
 * same openings: about +50 Elo, and White survives about 8 plies longer.
 *
 * The window's sides are fake edges wherever they are not also the real board's edge,
 * and the engine inside treats them as a wall. A window is only usable while no stone is
 * closer than `margin` points to a fake edge, and no five-point line crossing the window
 * boundary holds three or more stones of one colour and none of the other (a threat the
 * engine could not see past the wall). When no placement qualifies, the move is handed to
 * the 19x19 engine instead.
 *
 * This is a port of renju19's window.js placement code and must stay move-for-move equal
 * to it: same loop order, same distance, same tie-break. test/window-parity.js checks.
 *
 * Stones are [x, y, colour] in play order, colour 1 black, 2 white.
 */
'use strict';

const W = 15;
const N = 19;

/* A five-point segment crossing the window boundary with 3+ of one colour and none of
   the other could still become five through the fake edge. */
function edgeThreat(grid, ox, oy) {
  const inside = (x, y) => x >= ox && x < ox + W && y >= oy && y < oy + W;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    for (const [dx, dy] of dirs) {
      const ex = x + 4 * dx, ey = y + 4 * dy;
      if (ex < 0 || ex >= N || ey < 0 || ey >= N) continue;
      let ins = 0;
      const count = [0, 0, 0];
      for (let k = 0; k < 5; k++) {
        const cx = x + k * dx, cy = y + k * dy;
        if (inside(cx, cy)) ins++;
        count[grid[cy * N + cx]]++;
      }
      if (ins === 0 || ins === 5) continue;
      if ((count[1] >= 3 && count[2] === 0) || (count[2] >= 3 && count[1] === 0)) return true;
    }
  }
  return false;
}

function windowValid(stones, grid, ox, oy, margin) {
  // Only a side that is not also the real board's edge is a fake edge.
  const left = ox > 0 ? margin : 0, top = oy > 0 ? margin : 0;
  const right = ox + W < N ? margin : 0, bottom = oy + W < N ? margin : 0;
  for (const [x, y] of stones) {
    const lx = x - ox, ly = y - oy;
    if (lx < left || ly < top || lx > W - 1 - right || ly > W - 1 - bottom) return false;
  }
  return !edgeThreat(grid, ox, oy);
}

/* The valid window whose centre is nearest the stones' bounding-box centre, or null when
   none is valid. Origins are scanned oy outer, ox inner, ascending, and only a strictly
   nearer origin is checked, so the first valid origin at the minimum distance wins. */
function chooseWindow(stones, margin) {
  if (!stones.length) return { ox: 2, oy: 2 };
  const grid = new Int8Array(N * N);
  let minX = N, maxX = -1, minY = N, maxY = -1;
  for (const [x, y, c] of stones) {
    grid[y * N + x] = c;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let best = null;
  for (let oy = 0; oy <= N - W; oy++) for (let ox = 0; ox <= N - W; ox++) {
    const d = Math.hypot(ox + (W - 1) / 2 - cx, oy + (W - 1) / 2 - cy);
    if (best && d >= best.d) continue;
    if (windowValid(stones, grid, ox, oy, margin)) best = { ox, oy, d };
  }
  return best && { ox: best.ox, oy: best.oy };
}

module.exports = { W, N, chooseWindow };
