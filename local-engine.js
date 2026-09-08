/* Gomoku engine: board state, win detection, incremental evaluation, alpha-beta search. */
(function (global) {
  'use strict';

  var SIZE = 15;
  var N = SIZE * SIZE;
  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  var WIN_SCORE = 1e9;

  /* ---- precomputed line geometry ------------------------------------- */

  var LINES = [];            // LINES[id] = array of cell indices
  var CELL_LINES = [];       // CELL_LINES[cell] = ids of the 4 lines through it

  (function buildLines() {
    for (var c = 0; c < N; c++) CELL_LINES.push([]);
    for (var d = 0; d < DIRS.length; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (var y = 0; y < SIZE; y++) {
        for (var x = 0; x < SIZE; x++) {
          var px = x - dx, py = y - dy;
          if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) continue; // not a line start
          var cells = [], cx = x, cy = y;
          while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE) {
            cells.push(cy * SIZE + cx);
            cx += dx; cy += dy;
          }
          if (cells.length < 5) continue;
          var id = LINES.length;
          LINES.push(cells);
          for (var i = 0; i < cells.length; i++) CELL_LINES[cells[i]].push(id);
        }
      }
    }
  })();

  /* ---- pattern scoring ------------------------------------------------ */
  /* A line is rendered as a string: 'x' = the player, 'o' = opponent, '.' = empty.
     Tiers are checked strongest first; only the strongest tier present in a line
     contributes, times how often it occurs. Threats in different directions live
     on different lines and so add up - that is what makes double threats win. */

  var TIERS = [
    { re: /xxxxx/g,                              value: 5000000 }, // five
    { re: /\.xxxx\./g,                           value: 200000 },  // open four
    { re: /xxxx\.|\.xxxx|xxx\.x|x\.xxx|xx\.xx/g, value: 20000 },   // four
    { re: /\.xxx\.|\.x\.xx\.|\.xx\.x\./g,        value: 8000 },    // open three
    { re: /xxx\.|\.xxx|xx\.x|x\.xx/g,            value: 900 },     // closed three
    { re: /\.xx\.|\.x\.x\./g,                    value: 220 },     // open two
    { re: /xx|x\.x/g,                            value: 45 },      // two
    { re: /x/g,                                  value: 4 }        // lone stone
  ];

  function scoreString(s) {
    for (var t = 0; t < TIERS.length; t++) {
      var re = TIERS[t].re;
      re.lastIndex = 0;
      var count = 0;
      while (re.exec(s) !== null) count++;
      if (count) return TIERS[t].value * count;
    }
    return 0;
  }

  /* ---- board ---------------------------------------------------------- */

  function Board() {
    this.cells = new Int8Array(N);
    this.history = [];
    this.lineScore = [null, new Int32Array(LINES.length), new Int32Array(LINES.length)];
    this.total = [0, 0, 0];
    this.stones = 0;
  }

  Board.prototype.reset = function () {
    this.cells.fill(EMPTY);
    this.history.length = 0;
    this.lineScore[1].fill(0);
    this.lineScore[2].fill(0);
    this.total = [0, 0, 0];
    this.stones = 0;
    return this;
  };

  Board.prototype.at = function (x, y) { return this.cells[y * SIZE + x]; };

  Board.prototype.lineToString = function (lineId, player) {
    var cells = LINES[lineId], out = '';
    for (var i = 0; i < cells.length; i++) {
      var v = this.cells[cells[i]];
      out += v === EMPTY ? '.' : (v === player ? 'x' : 'o');
    }
    return out;
  };

  Board.prototype.refreshLines = function (cell) {
    var ids = CELL_LINES[cell];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      for (var p = 1; p <= 2; p++) {
        var next = scoreString(this.lineToString(id, p));
        this.total[p] += next - this.lineScore[p][id];
        this.lineScore[p][id] = next;
      }
    }
  };

  Board.prototype.place = function (cell, player) {
    this.cells[cell] = player;
    this.history.push(cell);
    this.stones++;
    this.refreshLines(cell);
    return this;
  };

  Board.prototype.undo = function () {
    if (!this.history.length) return -1;
    var cell = this.history.pop();
    this.cells[cell] = EMPTY;
    this.stones--;
    this.refreshLines(cell);
    return cell;
  };

  /* The winning run through `cell`, or null. Under the standard rule an
     overline of six or more is not a win, so `exactFive` rejects it. */
  Board.prototype.winningLineAt = function (cell, exactFive) {
    var player = this.cells[cell];
    if (!player) return null;
    var x0 = cell % SIZE, y0 = (cell / SIZE) | 0;
    for (var d = 0; d < DIRS.length; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var run = [cell], x, y, s;
      for (s = -1; s <= 1; s += 2) {
        x = x0 + dx * s; y = y0 + dy * s;
        while (x >= 0 && x < SIZE && y >= 0 && y < SIZE && this.cells[y * SIZE + x] === player) {
          run.push(y * SIZE + x);
          x += dx * s; y += dy * s;
        }
      }
      if (run.length >= 5 && !(exactFive && run.length > 5)) {
        run.sort(function (a, b) { return a - b; });
        return run;
      }
    }
    return null;
  };

  /* The search itself always uses freestyle rules: this engine is only the
     offline fallback, and Rapfi handles the rule variants properly. */
  Board.prototype.isWinAt = function (cell) {
    return this.winningLineAt(cell) !== null;
  };

  Board.prototype.isFull = function () { return this.stones >= N; };

  /* ---- move generation ------------------------------------------------ */

  var NEAR = [];
  (function buildNear() {
    for (var c = 0; c < N; c++) {
      var x0 = c % SIZE, y0 = (c / SIZE) | 0, list = [];
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          var x = x0 + dx, y = y0 + dy;
          if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
          list.push(y * SIZE + x);
        }
      }
      NEAR.push(list);
    }
  })();

  /* How much `player`'s own score would grow by playing `cell`. */
  Board.prototype.gainAt = function (cell, player) {
    this.cells[cell] = player;
    var ids = CELL_LINES[cell], gain = 0;
    for (var i = 0; i < ids.length; i++) {
      gain += scoreString(this.lineToString(ids[i], player)) - this.lineScore[player][ids[i]];
    }
    this.cells[cell] = EMPTY;
    return gain;
  };

  /* Empty points within 2 of a stone, best-looking first. */
  Board.prototype.candidates = function (player, limit) {
    if (this.stones === 0) return [(SIZE >> 1) * SIZE + (SIZE >> 1)];
    var seen = new Uint8Array(N), list = [], opp = 3 - player;
    for (var h = 0; h < this.history.length; h++) {
      var near = NEAR[this.history[h]];
      for (var i = 0; i < near.length; i++) {
        var c = near[i];
        if (this.cells[c] !== EMPTY || seen[c]) continue;
        seen[c] = 1;
        list.push({ cell: c, score: this.gainAt(c, player) + this.gainAt(c, opp) * 0.85 });
      }
    }
    list.sort(function (a, b) { return b.score - a.score; });
    if (limit && list.length > limit) list.length = limit;
    var out = [];
    for (var k = 0; k < list.length; k++) out.push(list[k].cell);
    return out;
  };

  /* `evaluate` is always called with the side to move, so weighting that side
     up is how tempo enters a static score: the same shape is worth more to
     whoever gets to extend it first. */
  var TUNING = { attack: 1.6 };

  Board.prototype.evaluate = function (player) {
    return this.total[player] * TUNING.attack - this.total[3 - player];
  };

  /* ---- search --------------------------------------------------------- */

  /* `depth` is the remaining depth, so a high value means "near the root".
     Search wide near the root where the choice is made, narrow near the
     leaves where the branching factor is what costs time. */
  function widthFor(depth) {
    if (depth >= 5) return 12;
    if (depth >= 3) return 8;
    return 6;
  }

  Board.prototype.negamax = function (depth, alpha, beta, player) {
    if (depth <= 0) return this.evaluate(player);
    var moves = this.candidates(player, widthFor(depth));
    if (!moves.length) return this.evaluate(player);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      this.place(m, player);
      var val = this.isWinAt(m)
        ? WIN_SCORE + depth
        : -this.negamax(depth - 1, -beta, -alpha, 3 - player);
      this.undo();
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  };

  /* Pick a move for `player`. Depth 1 plays greedily with a little noise. */
  Board.prototype.bestMove = function (player, depth) {
    if (this.stones === 0) return (SIZE >> 1) * SIZE + (SIZE >> 1);
    var opp = 3 - player, i, m, hit;

    var moves = this.candidates(player, 24);
    if (!moves.length) return -1;

    // Take a win now.
    for (i = 0; i < moves.length; i++) {
      this.cells[moves[i]] = player;
      hit = this.isWinAt(moves[i]);
      this.cells[moves[i]] = EMPTY;
      if (hit) return moves[i];
    }
    // Otherwise stop an immediate loss.
    for (i = 0; i < moves.length; i++) {
      this.cells[moves[i]] = opp;
      hit = this.isWinAt(moves[i]);
      this.cells[moves[i]] = EMPTY;
      if (hit) return moves[i];
    }

    if (depth <= 1) {
      var top = moves.slice(0, 4), pick = top[0], bestG = -Infinity;
      for (i = 0; i < top.length; i++) {
        var g = (this.gainAt(top[i], player) + this.gainAt(top[i], opp) * 0.85)
              * (0.85 + Math.random() * 0.3);
        if (g > bestG) { bestG = g; pick = top[i]; }
      }
      return pick;
    }

    var width = Math.max(12, widthFor(depth)); // the root always looks wide
    if (moves.length > width) moves.length = width;

    var best = -Infinity, bestMoves = [], alpha = -Infinity;
    for (i = 0; i < moves.length; i++) {
      m = moves[i];
      this.place(m, player);
      var val = this.isWinAt(m)
        ? WIN_SCORE + depth
        : -this.negamax(depth - 1, -Infinity, -alpha, opp);
      this.undo();
      if (val > best) { best = val; bestMoves = [m]; alpha = val; }
      else if (val === best) bestMoves.push(m);
    }
    return bestMoves[(Math.random() * bestMoves.length) | 0];
  };

  /* ---- notation ------------------------------------------------------- */

  var COLUMNS = 'ABCDEFGHIJKLMNO'; // Gomocup notation: 'I' is included

  function toCoord(cell) {
    return COLUMNS[cell % SIZE] + (SIZE - ((cell / SIZE) | 0));
  }

  var api = {
    Board: Board,
    SIZE: SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    WIN_SCORE: WIN_SCORE,
    COLUMNS: COLUMNS,
    tuning: TUNING,
    toCoord: toCoord
  };

  global.Gomoku = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
