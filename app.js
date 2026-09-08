/* UI: canvas board, input handling, and game flow.
   Moves come from Rapfi through server.js when it is reachable, and from the
   bundled JavaScript engine when the page is opened as a plain file. */
(function () {
  'use strict';

  var G = window.Gomoku;
  var SIZE = G.SIZE, BLACK = G.BLACK, WHITE = G.WHITE, EMPTY = G.EMPTY;

  /* Canvas colours come from the stylesheet so the board follows the theme
     without a second palette to keep in step. Refreshed whenever it changes. */
  var COLOR = {};
  var COLOR_VARS = {
    board: '--board',
    grid: '--grid',
    gridEdge: '--grid-edge',
    label: '--coord',
    black: '--stone-black',
    blackEdge: '--stone-black-edge',
    white: '--stone-white',
    whiteEdge: '--stone-white-edge',
    hint: '--marker',
    win: '--win'
  };

  function refreshColors() {
    var style = getComputedStyle(document.documentElement);
    for (var key in COLOR_VARS) {
      COLOR[key] = style.getPropertyValue(COLOR_VARS[key]).trim() || '#888';
    }
  }

  var STAR = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var els = {};
  ['statusText', 'statusMeta', 'turnDot', 'engineBadge', 'mode', 'level', 'thinkTime',
   'rule', 'newGame', 'undo', 'undoAll', 'hint', 'movelog', 'analysis',
   'anDepth', 'anEval', 'anNodes', 'anSpeed', 'anPv', 'nbest', 'candList',
   'review', 'theme', 'renjuOption', 'coachPhase', 'coachNote',
   'prevMove', 'prevShape', 'curMove', 'curShape', 'coachPrev',
   'boardStack', 'evalBar', 'evalFill', 'evalNumWhite', 'evalNumBlack',
   'evalBarToggle', 'panelToggle', 'panelTab', 'panelLeft', 'leftToggle',
   'leftTab'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var board = new G.Board();
  var state = {
    turn: BLACK,
    over: false,
    winner: 0,
    winLine: null,
    thinking: false,
    analysing: false,   // thinking on the human's behalf, for a hint
    error: '',
    hover: -1,
    hint: -1,
    candidates: [],     // scored placements for the side to move
    candPending: false,
    candSeq: 0,         // stale analysis replies are dropped
    grades: [],         // grades[i] describes history[i]
    prior: null,        // analysis of the position before the pending move
    forbidden: [],      // renju: cells Black may not play
    forbidSeq: 0,
    shapes: [],         // shapes[i] names what history[i] created
    hintOn: false,
    evalBarOn: true,
    whiteRate: null,    // white's share of the win chance, 0 to 1
    panelOpen: true,
    leftOpen: true,
    metrics: null
  };

  /* How much worse than the engine's best a move turned out to be, in the eval
     units Rapfi reports. Measured against real play: repeating the engine's own
     choice still shows a loss near 100 because the two searches stop at
     different depths, the tenth-best move in a balanced position costs about
     430, and a wasted move in the corner about 1200. */
  var GRADES = [
    { limit: 150,  name: 'Best' },
    { limit: 300,  name: 'Good' },
    { limit: 550,  name: 'Inaccuracy' },
    { limit: 1000, name: 'Mistake' },
    { limit: Infinity, name: 'Blunder' }
  ];

  /* Rapfi turns a score into a win rate with a logistic curve,
       winRate = 1 / (1 + exp(-eval / ScalingFactor))
     from Rapfi/eval/scoretables.h, where ScalingFactor defaults to 200 in
     Rapfi/config.cpp. Mate scores clamp to a certainty. */
  var SCALING_FACTOR = 200;

  function winRateFor(value) {
    if (value === null || !Number.isFinite(value)) return null;
    if (value >= 1e5) return 1;      // our mate encoding, either way
    if (value <= -1e5) return 0;
    return 1 / (1 + Math.exp(-value / SCALING_FACTOR));
  }

  /* A score is always from the point of view of the side to move. */
  function setWinRate(value, sideToMove) {
    var p = winRateFor(value);
    state.whiteRate = p === null ? null : (sideToMove === WHITE ? p : 1 - p);
  }

  function renderEvalBar() {
    var on = state.evalBarOn && backend.kind === 'rapfi';
    els.boardStack.classList.toggle('no-eval', !on);
    if (!on) return;

    var p = state.whiteRate;
    if (p === null) {
      els.evalFill.style.height = '50%';
      els.evalNumWhite.textContent = '';
      els.evalNumBlack.textContent = '';
      return;
    }
    var pct = Math.max(0, Math.min(100, p * 100));
    els.evalFill.style.height = pct.toFixed(1) + '%';
    els.evalNumWhite.textContent = Math.round(pct) + '%';
    els.evalNumBlack.textContent = Math.round(100 - pct) + '%';
  }

  function gradeFor(loss) {
    for (var i = 0; i < GRADES.length; i++) {
      if (loss < GRADES[i].limit) return GRADES[i].name;
    }
    return 'Blunder';
  }

  /* Rapfi if server.js answers, otherwise the bundled engine. */
  var backend = { kind: 'local', label: 'Built-in engine (offline)' };

  /* ---- coordinates ------------------------------------------------------
     A cell index is row * SIZE + col with row 0 drawn at the top. Rapfi uses
     y = 0 at the bottom, so the two differ by a flip. Column letters are
     A-O with I included, which is what Rapfi prints in its principal variation. */

  function colOf(cell) { return cell % SIZE; }
  function rowOf(cell) { return (cell / SIZE) | 0; }
  function toEngine(cell) { return { x: colOf(cell), y: SIZE - 1 - rowOf(cell) }; }
  function fromEngine(x, y) { return (SIZE - 1 - y) * SIZE + x; }

  function isRenju() { return els.rule.value === 'renju'; }

  /* Who has to make exactly five. Freestyle lets both sides win with five or
     more; standard requires exactly five from both; renju restricts Black only,
     so an overline wins for White but is forbidden for Black. */
  function needsExactFive(player) {
    if (els.rule.value === 'standard') return true;
    if (els.rule.value === 'renju') return player === BLACK;
    return false;
  }

  /* "J10" as printed by Rapfi -> a cell index. */
  function cellFromCoord(token) {
    var m = /^([A-O])(\d{1,2})$/i.exec(token || '');
    if (!m) return -1;
    var x = G.COLUMNS.indexOf(m[1].toUpperCase());
    var y = Number(m[2]) - 1;
    if (x < 0 || y < 0 || y >= SIZE) return -1;
    return fromEngine(x, y);
  }

  /* Rapfi reports mates as "M12" / "-M12" and everything else as a number.
     Mates sort outside every ordinary score, nearer ones first. */
  function evalToNumber(text) {
    var m = /^([+-]?)M(\d+)$/i.exec(String(text));
    if (m) {
      var mag = 1e6 - Number(m[2]);
      return m[1] === '-' ? -mag : mag;
    }
    var n = Number(text);
    return Number.isFinite(n) ? n : 0;
  }

  function formatEval(text) {
    if (/^-?M/i.test(String(text))) return String(text);
    var n = Number(text);
    if (!Number.isFinite(n)) return String(text);
    return (n > 0 ? '+' : '') + n;
  }

  /* Render a number back out, turning the mate magnitudes evalToNumber
     produces into "M12" again. */
  function formatValue(n) {
    if (n === null || !Number.isFinite(n)) return '';
    if (Math.abs(n) >= 1e5) return (n < 0 ? '-' : '+') + 'M' + (1e6 - Math.abs(n));
    return (n > 0 ? '+' : '') + Math.round(n);
  }

  /* ---- geometry -------------------------------------------------------- */

  function layout() {
    var css = canvas.getBoundingClientRect();
    var side = Math.max(160, Math.min(css.width, css.height));
    var pad = Math.round(side * 0.055);
    var step = (side - pad * 2) / (SIZE - 1);
    state.metrics = { side: side, pad: pad, step: step, stone: step * 0.44 };
    return state.metrics;
  }

  function px(i) { return state.metrics.pad + i * state.metrics.step; }

  function cellFromPoint(clientX, clientY) {
    var r = canvas.getBoundingClientRect(), m = state.metrics;
    if (!m) return -1;
    var col = Math.round((clientX - r.left - m.pad) / m.step);
    var row = Math.round((clientY - r.top - m.pad) / m.step);
    if (col < 0 || col >= SIZE || row < 0 || row >= SIZE) return -1;
    if (Math.hypot(clientX - r.left - px(col), clientY - r.top - px(row)) > m.step * 0.55) return -1;
    return row * SIZE + col;
  }

  /* ---- drawing --------------------------------------------------------- */

  function resize() {
    var r = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
    draw();
  }

  function drawStone(cell, player, alpha) {
    var m = state.metrics;
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(px(colOf(cell)), px(rowOf(cell)), m.stone, 0, Math.PI * 2);
    ctx.fillStyle = player === BLACK ? COLOR.black : COLOR.white;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = player === BLACK ? COLOR.blackEdge : COLOR.whiteEdge;
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    var m = state.metrics;
    if (!m) return;
    var i, p;

    ctx.fillStyle = COLOR.board;
    ctx.fillRect(0, 0, m.side, m.side);

    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i < SIZE; i++) {
      p = Math.round(px(i)) + 0.5;
      ctx.moveTo(Math.round(px(0)) + 0.5, p);
      ctx.lineTo(Math.round(px(SIZE - 1)) + 0.5, p);
      ctx.moveTo(p, Math.round(px(0)) + 0.5);
      ctx.lineTo(p, Math.round(px(SIZE - 1)) + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = COLOR.gridEdge;
    ctx.strokeRect(
      Math.round(px(0)) + 0.5, Math.round(px(0)) + 0.5,
      Math.round(px(SIZE - 1)) - Math.round(px(0)),
      Math.round(px(SIZE - 1)) - Math.round(px(0))
    );

    ctx.fillStyle = COLOR.gridEdge;
    for (i = 0; i < STAR.length; i++) {
      ctx.beginPath();
      ctx.arc(px(STAR[i][0]), px(STAR[i][1]), Math.max(1.6, m.step * 0.055), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = COLOR.label;
    ctx.font = Math.max(9, Math.round(m.step * 0.36)) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < SIZE; i++) {
      // Letters along the bottom, numbers down the right, once each.
      ctx.fillText(G.COLUMNS[i], px(i), m.side - m.pad * 0.45);
      ctx.fillText(String(SIZE - i), m.side - m.pad * 0.45, px(i));
    }

    for (i = 0; i < SIZE * SIZE; i++) {
      if (board.cells[i] !== EMPTY) drawStone(i, board.cells[i]);
    }

    drawCandidates();
    drawForbidden();

    if (!state.over && !state.thinking && state.hover >= 0 &&
        board.cells[state.hover] === EMPTY && isHumanTurn()) {
      drawStone(state.hover, state.turn, 0.32);
    }

    if (state.hint >= 0 && board.cells[state.hint] === EMPTY) {
      ctx.save();
      ctx.strokeStyle = COLOR.hint;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(px(colOf(state.hint)), px(rowOf(state.hint)), m.stone, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    var last = board.history[board.history.length - 1];
    if (last != null && !state.winLine) {
      ctx.strokeStyle = board.cells[last] === BLACK ? COLOR.white : COLOR.black;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(colOf(last)), px(rowOf(last)), m.stone * 0.32, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (state.winLine && state.winLine.length) {
      var a = state.winLine[0], b = state.winLine[state.winLine.length - 1];
      ctx.save();
      ctx.strokeStyle = COLOR.win;
      ctx.lineWidth = Math.max(2, m.step * 0.09);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(colOf(a)), px(rowOf(a)));
      ctx.lineTo(px(colOf(b)), px(rowOf(b)));
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---- engine backends -------------------------------------------------- */

  function isCoach() { return els.mode.value === 'coach'; }

  /* 0 means nobody is played by the engine: two-player and coach both leave
     every stone to the user, coach just keeps the analysis running. */
  function engineColor() {
    var mode = els.mode.value;
    if (mode === 'ai-white') return WHITE;
    if (mode === 'ai-black') return BLACK;
    return 0;
  }

  function isHumanTurn() { return !state.thinking && state.turn !== engineColor(); }

  /* Board as Rapfi wants it: engine coordinates, in the order they were played. */
  function stonesForEngine() {
    return board.history.map(function (cell) {
      var e = toEngine(cell);
      return [e.x, e.y, board.cells[cell]];
    });
  }

  function askRapfi(color, timeoutMs, strength) {
    return fetch('api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        engineColor: color,
        timeoutMs: timeoutMs,
        strength: strength
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      showAnalysis(data.info);
      return { cell: fromEngine(data.move.x, data.move.y), info: data.info };
    });
  }

  function askLocal(color) {
    // Map Rapfi's 0-100 strength onto the fallback engine's search depth.
    var s = Number(els.level.value);
    var depth = s >= 100 ? 6 : s >= 80 ? 4 : s >= 50 ? 4 : s >= 25 ? 2 : 1;
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ cell: board.bestMove(color, depth), info: null });
      }, 30);
    });
  }

  function askForMove(color) {
    var timeoutMs = Number(els.thinkTime.value);
    var strength = Number(els.level.value);
    if (backend.kind !== 'rapfi') return askLocal(color);
    return askRapfi(color, timeoutMs, strength).catch(function (err) {
      // Rapfi went away mid-game: keep playing rather than stranding the user.
      setBackend({ kind: 'local', label: 'Built-in engine (Rapfi unreachable)' });
      return askLocal(color);
    });
  }

  /* ---- renju forbidden points -------------------------------------------- */

  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function stoneAt(col, row) {
    if (col < 0 || col >= SIZE || row < 0 || row >= SIZE) return -1;   // off board
    return board.cells[row * SIZE + col];
  }

  function longestRunAt(cell, player) {
    var c0 = colOf(cell), r0 = rowOf(cell), best = 0;
    for (var d = 0; d < DIRS.length; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], run = 1;
      for (var s = -1; s <= 1; s += 2) {
        var c = c0 + dx * s, r = r0 + dy * s;
        while (stoneAt(c, r) === player) { run++; c += dx * s; r += dy * s; }
      }
      if (run > best) best = run;
    }
    return best;
  }

  /* Does this direction hold a five-window through `cell` with four black
     stones and one empty point, i.e. a four? */
  function makesFourIn(cell, dx, dy) {
    var c0 = colOf(cell), r0 = rowOf(cell);
    for (var start = -4; start <= 0; start++) {
      var black = 0, empty = 0, ok = true;
      for (var k = 0; k < 5; k++) {
        var v = stoneAt(c0 + (start + k) * dx, r0 + (start + k) * dy);
        if (v === BLACK) black++;
        else if (v === EMPTY) empty++;
        else { ok = false; break; }
      }
      if (ok && black === 4 && empty === 1) return true;
    }
    return false;
  }

  /* The engine has already decided the point is forbidden; this only names
     which rule it broke. Overline is exact, and two fours are counted
     directly, so a double three is what is left. */
  function forbiddenReason(cell) {
    board.cells[cell] = BLACK;
    var run = longestRunAt(cell, BLACK);
    var fours = 0;
    for (var d = 0; d < DIRS.length; d++) {
      if (makesFourIn(cell, DIRS[d][0], DIRS[d][1])) fours++;
    }
    board.cells[cell] = EMPTY;

    if (run >= 6) return 'overline';
    if (fours >= 2) return 'double four';
    return 'double three';
  }

  function clearForbidden() {
    state.forbidden = [];
    state.forbidSeq++;
  }

  function requestForbidden() {
    if (!isRenju() || backend.kind !== 'rapfi') {
      clearForbidden();
      return;
    }
    var seq = ++state.forbidSeq;
    fetch('api/forbidden', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        sideToMove: state.turn
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (seq !== state.forbidSeq) return;
      if (data.error) throw new Error(data.error);
      state.forbidden = (data.points || [])
        .map(function (p) { return fromEngine(p.x, p.y); })
        .filter(function (c) { return c >= 0 && board.cells[c] === EMPTY; });
      render();
    }).catch(function () {
      if (seq !== state.forbidSeq) return;
      state.forbidden = [];
      render();
    });
  }

  function drawForbidden() {
    if (!state.forbidden.length) return;
    var m = state.metrics, arm = m.stone * 0.5;
    ctx.save();
    ctx.strokeStyle = COLOR.win;
    ctx.lineWidth = Math.max(1.5, m.step * 0.055);
    ctx.lineCap = 'round';
    for (var i = 0; i < state.forbidden.length; i++) {
      var x = px(colOf(state.forbidden[i])), y = px(rowOf(state.forbidden[i]));
      ctx.beginPath();
      ctx.moveTo(x - arm, y - arm); ctx.lineTo(x + arm, y + arm);
      ctx.moveTo(x + arm, y - arm); ctx.lineTo(x - arm, y + arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- naming the shapes -------------------------------------------------
     Gomoku vocabulary is about threats rather than game phases. Each term is
     defined by what one more stone could do, so that is how they are detected
     here: a four is a shape with a point that completes five, an open four has
     two such points and cannot be blocked, an open three becomes an open four,
     and a move that makes two threats at once is a fork. */

  function runThrough(cell, dx, dy, player) {
    var c0 = colOf(cell), r0 = rowOf(cell), run = 1;
    for (var s = -1; s <= 1; s += 2) {
      var c = c0 + dx * s, r = r0 + dy * s;
      while (stoneAt(c, r) === player) { run++; c += dx * s; r += dy * s; }
    }
    return run;
  }

  /* Empty points on this line, within reach of `cell`, that could extend it. */
  function neighbourGaps(cell, dx, dy) {
    var c0 = colOf(cell), r0 = rowOf(cell), out = [];
    for (var k = -4; k <= 4; k++) {
      if (!k) continue;
      var c = c0 + k * dx, r = r0 + k * dy;
      if (stoneAt(c, r) === EMPTY) out.push(r * SIZE + c);
    }
    return out;
  }

  /* How many different points would complete five along this line. Two or more
     is an open four, which cannot be blocked; exactly one is a plain four. */
  function waysToFive(cell, dx, dy, player) {
    var gaps = neighbourGaps(cell, dx, dy), ways = 0;
    for (var i = 0; i < gaps.length; i++) {
      board.cells[gaps[i]] = player;
      if (runThrough(gaps[i], dx, dy, player) >= 5) ways++;
      board.cells[gaps[i]] = EMPTY;
    }
    return ways;
  }

  /* Could one more stone here turn the shape into an open four (an open
     three), or into a plain four (a closed three)? */
  function threeKind(cell, dx, dy, player) {
    var gaps = neighbourGaps(cell, dx, dy), best = 0;
    for (var i = 0; i < gaps.length; i++) {
      board.cells[gaps[i]] = player;
      var ways = runThrough(gaps[i], dx, dy, player) >= 5 ? 0 : waysToFive(gaps[i], dx, dy, player);
      board.cells[gaps[i]] = EMPTY;
      if (ways >= 2) return 'open';
      if (ways === 1) best = 1;
    }
    return best ? 'closed' : '';
  }

  function makesOpenTwo(cell, dx, dy, player) {
    var gaps = neighbourGaps(cell, dx, dy);
    for (var i = 0; i < gaps.length; i++) {
      board.cells[gaps[i]] = player;
      var kind = threeKind(gaps[i], dx, dy, player);
      board.cells[gaps[i]] = EMPTY;
      if (kind === 'open') return true;
    }
    return false;
  }

  /* `cell` must already hold the stone. Returns the name of the strongest
     shape the move made, with a one-line note on what it means. */
  function describeMove(cell, player) {
    var openFours = 0, fours = 0, openThrees = 0, closedThrees = 0, openTwos = 0;

    for (var d = 0; d < DIRS.length; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      if (runThrough(cell, dx, dy, player) >= 5) {
        return { name: 'five in a row', note: 'the game is over' };
      }
      var ways = waysToFive(cell, dx, dy, player);
      if (ways >= 2) { openFours++; continue; }
      if (ways === 1) { fours++; continue; }
      var kind = threeKind(cell, dx, dy, player);
      if (kind === 'open') { openThrees++; continue; }
      if (kind === 'closed') { closedThrees++; continue; }
      if (makesOpenTwo(cell, dx, dy, player)) openTwos++;
    }

    var forcing = openFours + fours;
    if (openFours) {
      return { name: 'open four', note: 'two ways to make five, so it cannot be blocked' };
    }
    if (forcing >= 2) {
      return { name: 'double four', note: 'a fork: only one of the two fours can be blocked' };
    }
    if (fours && openThrees) {
      return { name: 'four-three', note: 'a fork: the four must be answered, then the three wins' };
    }
    if (openThrees >= 2) {
      return { name: 'double three', note: 'a fork: two open threes, only one can be answered' };
    }
    if (fours) return { name: 'four', note: 'forces a reply on the completing point' };
    if (openThrees) return { name: 'open three', note: 'becomes an open four unless it is answered' };
    if (closedThrees) return { name: 'closed three', note: 'blocked on one side, not yet forcing' };
    if (openTwos) return { name: 'open two', note: 'quiet development towards a three' };
    return { name: 'quiet move', note: 'no threat yet' };
  }

  /* A descriptive phase, not a formal one: gomoku has no canonical opening,
     middle game and endgame the way chess does. */
  function phaseName() {
    if (state.over) return 'finished';
    var last = state.shapes[board.history.length - 1];
    if (last && /four|three/.test(last.name)) return 'attack';
    if (board.history.length < 6) return 'opening';
    return 'middle game';
  }

  /* ---- scored options ----------------------------------------------------
     Rapfi ranks candidates as it searches, but a rank order captured when the
     clock stops can lag the scores it just produced, so the list is sorted by
     score here. Given enough think time the top of that order is the same move
     the engine returns as its own choice. */

  function clearCandidates() {
    state.candidates = [];
    state.candPending = false;
    state.candSeq++;
    renderCandidates();
  }

  /* Grade the move that was just played by comparing the value the engine saw
     before it with the value it sees now. Both readings are from the side to
     move at the time, so the loss to the mover is simply their sum. */
  function gradeLastMove(after) {
    var prior = state.prior;
    if (!prior || prior.moveCount !== board.history.length - 1) return;
    if (prior.value === null || after === null) return;

    var index = prior.moveCount;
    var value = -after;                        // worth of the position to the mover
    var loss = Math.max(0, prior.value - value);
    var playedBest = prior.bestCell >= 0 && prior.bestCell === board.history[index];

    state.grades[index] = {
      value: value,
      loss: loss,
      best: prior.bestCoord,
      grade: playedBest ? 'Best' : gradeFor(loss)
    };
  }

  function requestAnalysis() {
    // Tactics mode analyses even when the option list is switched off.
    var count = Number(els.nbest.value) || (isCoach() ? 5 : 0)
                || (state.hintOn || state.evalBarOn ? 1 : 0);
    if (!count || backend.kind !== 'rapfi' || state.over || !isHumanTurn()) {
      clearCandidates();
      if (!state.hintOn || state.over) state.hint = -1;
      return;
    }
    var seq = ++state.candSeq;
    state.candPending = true;
    renderCandidates();

    // Keep analysis snappy: it queues ahead of the move the user is about to make.
    var timeoutMs = Math.min(Number(els.thinkTime.value) || 1000, 2000);

    fetch('api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        sideToMove: state.turn,
        timeoutMs: timeoutMs,
        count: count
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (seq !== state.candSeq) return;           // the board moved on
      if (data.error) throw new Error(data.error);

      var list = (data.candidates || []).map(function (c) {
        return {
          cell: cellFromCoord(c.pv && c.pv[0]),
          score: c.eval,
          value: evalToNumber(c.eval),
          depth: c.depth,
          pv: c.pv || []
        };
      }).filter(function (c) { return c.cell >= 0 && board.cells[c.cell] === EMPTY; });

      list.sort(function (a, b) { return b.value - a.value; });

      // A forced position can come back with a move but no ranked list.
      if (!list.length && data.best) {
        var cell = fromEngine(data.best.x, data.best.y);
        if (cell >= 0 && board.cells[cell] === EMPTY) {
          list = [{ cell: cell, score: '', value: 0, depth: '', pv: [] }];
        }
      }

      var positionValue = data.info && data.info.eval != null
        ? evalToNumber(data.info.eval) : null;

      gradeLastMove(positionValue);
      setWinRate(positionValue, state.turn);

      state.prior = {
        moveCount: board.history.length,
        value: positionValue,
        bestCell: list.length ? list[0].cell : -1,
        bestCoord: list.length ? G.toCoord(list[0].cell) : ''
      };

      state.candidates = list;
      state.candPending = false;
      if (state.hintOn && list.length) state.hint = list[0].cell;
      // If only the hint asked for this search, do not paint the option list.
      if (!Number(els.nbest.value) && !isCoach()) state.candidates = [];
      render();
    }).catch(function () {
      if (seq !== state.candSeq) return;
      state.candPending = false;
      state.candidates = [];
      render();
    });
  }

  function renderReview() {
    var i = board.history.length - 1;
    var g = i >= 0 ? state.grades[i] : null;
    if (!g) { els.review.textContent = ''; return; }
    var played = G.toCoord(board.history[i]);
    var text = 'Move ' + (i + 1) + ' ' + played + ' · ' + g.grade;
    if (g.grade !== 'Best') {
      text += ' · gave up ' + Math.round(g.loss);
      if (g.best && g.best !== played) text += ' · best was ' + g.best;
    }
    els.review.textContent = text;
  }

  function renderCandidates() {
    var html = '';
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      html += '<li class="' + (i === 0 ? 'top' : '') + '" data-cell="' + c.cell + '">' +
              '<span class="rank">' + (i + 1) + '</span>' +
              '<span class="mv">' + G.toCoord(c.cell) + '</span>' +
              (c.depth ? '<span class="dp">d' + c.depth + '</span>' : '') +
              '<span class="sc">' + (c.score === '' ? 'forced' : formatEval(c.score)) + '</span>' +
              '</li>';
    }
    els.candList.innerHTML = html;
    els.candList.classList.toggle('pending', state.candPending);
  }

  function drawCandidates() {
    if (!state.candidates.length || state.over) return;
    var m = state.metrics;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      var x = px(colOf(c.cell)), y = px(rowOf(c.cell));
      // Best option is drawn solid black, the rest fade back by rank.
      var weight = Math.max(0.22, 1 - i * 0.11);
      ctx.globalAlpha = weight;
      ctx.strokeStyle = COLOR.hint;
      ctx.lineWidth = i === 0 ? 1.8 : 1;
      ctx.beginPath();
      ctx.arc(x, y, m.stone * 0.92, 0, Math.PI * 2);
      ctx.stroke();

      if (c.score !== '') {
        var label = formatEval(c.score);
        ctx.font = (i === 0 ? '600 ' : '') + Math.max(8, Math.round(m.step * 0.27)) +
                   'px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.globalAlpha = Math.max(0.35, weight);
        ctx.fillStyle = COLOR.board;
        ctx.fillText(label, x, y);       // knock back the grid behind the number
        ctx.globalAlpha = weight;
        ctx.fillStyle = COLOR.hint;
        ctx.fillText(label, x, y);
      }
    }
    ctx.restore();
  }

  /* ---- analysis readout -------------------------------------------------- */

  function clearAnalysis() {
    els.anDepth.textContent = '-';
    els.anEval.textContent = '-';
    els.anNodes.textContent = '-';
    els.anSpeed.textContent = '-';
    els.anPv.textContent = '';
  }

  function showAnalysis(info) {
    if (!info) return;
    if (info.depth) els.anDepth.textContent = info.depth;
    if (info.eval) els.anEval.textContent = info.eval;
    if (info.nodes) els.anNodes.textContent = info.nodes;
    if (info.speed) els.anSpeed.textContent = info.speed;
    if (info.pv && info.pv.length) els.anPv.textContent = info.pv.join(' ');
  }

  /* Rapfi prints search progress as
     "MESSAGE Depth 17-37 | Eval -484 | Time 1471ms | I8 J7 ..." */
  function parseMessage(line) {
    var m = /^MESSAGE\s+(.*)$/i.exec(line);
    if (!m) return null;
    var info = {}, sawDepth = false, pv = null;
    m[1].split('|').map(function (s) { return s.trim(); }).forEach(function (part) {
      var f;
      if ((f = /^Depth\s+(\S+)$/i.exec(part))) { info.depth = f[1]; sawDepth = true; }
      else if ((f = /^Eval\s+(\S+)$/i.exec(part))) info.eval = f[1];
      else if ((f = /^Node\s+(\S+)$/i.exec(part))) info.nodes = f[1];
      else if ((f = /^Speed\s+(\S+)$/i.exec(part))) info.speed = f[1];
      else if (/^[A-O]\d{1,2}(\s+[A-O]\d{1,2})*$/i.test(part)) pv = part.split(/\s+/);
    });
    if (sawDepth && pv) info.pv = pv;
    return info;
  }

  function openEventStream() {
    if (!window.EventSource) return;
    var es = new EventSource('api/events');
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.kind !== 'line') return;
      var info = parseMessage(msg.text);
      if (info) showAnalysis(info);
    };
    es.onerror = function () { /* EventSource retries on its own */ };
  }

  /* ---- game flow -------------------------------------------------------- */

  function name(player) { return player === BLACK ? 'Black' : 'White'; }

  function play(cell) {
    if (state.over || cell < 0 || board.cells[cell] !== EMPTY) return false;
    var player = state.turn;

    if (player === BLACK && state.forbidden.indexOf(cell) >= 0) {
      state.error = G.toCoord(cell) + ' is forbidden for Black: ' + forbiddenReason(cell);
      render();
      return false;
    }

    board.place(cell, player);
    state.shapes[board.history.length - 1] = describeMove(cell, player);
    state.hint = -1;
    state.error = '';

    var line = board.winningLineAt(cell, needsExactFive(player));
    if (line) {
      state.over = true;
      state.winner = player;
      state.winLine = line;
    } else if (board.isFull()) {
      state.over = true;
      state.winner = 0;
      state.winLine = null;
    } else {
      state.turn = 3 - player;
    }
    render();
    return true;
  }

  /* Called whenever the position changes: either the engine owes a move, or
     the side to move is human and their options can be scored. */
  function settle() {
    requestForbidden();
    var color = engineColor();
    if (!state.over && color && state.turn === color && !state.thinking) maybeEngineMove();
    else { requestAnalysis(); refreshHint(); }
  }

  function maybeEngineMove() {
    var color = engineColor();
    if (state.over || !color || state.turn !== color || state.thinking) return;
    state.thinking = true;
    state.error = '';
    clearCandidates();
    render();
    askForMove(color).then(function (res) {
      state.thinking = false;
      // The engine's own reading of this position grades the move that led to
      // it, and becomes the baseline for grading the engine's reply.
      var value = res.info && res.info.eval != null ? evalToNumber(res.info.eval) : null;
      if (value !== null) {
        gradeLastMove(value);
        setWinRate(value, state.turn);
        state.prior = {
          moveCount: board.history.length,
          value: value,
          bestCell: -1,
          bestCoord: ''
        };
      }
      if (res.cell >= 0) play(res.cell);
      else render();
      settle();
    }, function (err) {
      state.thinking = false;
      state.error = 'Engine error: ' + err.message;
      render();
    });
  }

  function newGame() {
    board.reset();
    state.turn = BLACK;
    state.over = false;
    state.winner = 0;
    state.winLine = null;
    state.thinking = false;
    state.hint = -1;
    state.grades = [];
    state.shapes = [];
    state.prior = null;
    state.whiteRate = null;
    clearAnalysis();
    clearCandidates();
    clearForbidden();
    if (backend.kind === 'rapfi') {
      fetch('api/newgame', { method: 'POST' }).catch(function () {});
    }
    render();
    settle();
  }

  /* Shared tail of undo and undo-all. */
  function afterTakeback() {
    state.over = false;
    state.winner = 0;
    state.winLine = null;
    state.hint = -1;
    state.error = '';
    state.turn = board.history.length % 2 === 0 ? BLACK : WHITE;
    state.grades.length = board.history.length;
    state.shapes.length = board.history.length;
    state.prior = null;
    state.whiteRate = null;
    clearAnalysis();
    clearCandidates();
    clearForbidden();
    render();
    settle();
  }

  function undo() {
    if (state.thinking || !board.history.length) return;
    var color = engineColor();
    var steps = color ? 2 : 1;
    // If the human moved last, one step is enough to get back to their turn.
    if (color && board.cells[board.history[board.history.length - 1]] !== color) steps = 1;
    for (var i = 0; i < steps && board.history.length; i++) board.undo();
    afterTakeback();
  }

  function undoAll() {
    if (state.thinking || !board.history.length) return;
    while (board.history.length) board.undo();
    afterTakeback();
  }

  /* ---- hold to undo all --------------------------------------------------
     Wiping the whole game is a press-and-hold rather than a click, so it
     cannot happen by accident. Letting go early abandons it. */

  var HOLD_MS = 3000;
  var hold = { active: false, raf: 0, start: 0 };

  function holdTick() {
    var elapsed = Date.now() - hold.start;
    if (elapsed >= HOLD_MS) {
      cancelHold();
      undoAll();
      return;
    }
    var pct = (elapsed / HOLD_MS) * 100;
    els.undoAll.style.setProperty('--hold', pct.toFixed(1) + '%');
    els.undoAll.textContent = 'Hold ' + Math.ceil((HOLD_MS - elapsed) / 1000);
    hold.raf = window.requestAnimationFrame(holdTick);
  }

  function startHold() {
    if (hold.active || els.undoAll.disabled) return;
    hold.active = true;
    hold.start = Date.now();
    els.undoAll.classList.add('holding');
    holdTick();
  }

  function cancelHold() {
    if (!hold.active) return;
    hold.active = false;
    if (hold.raf) window.cancelAnimationFrame(hold.raf);
    hold.raf = 0;
    els.undoAll.classList.remove('holding');
    els.undoAll.style.setProperty('--hold', '0%');
    els.undoAll.textContent = 'Undo all';
  }

  function toggleHint() {
    state.hintOn = !state.hintOn;
    state.hint = -1;
    requestAnalysis();
    refreshHint();
    render();
  }

  /* With Rapfi the hint is the top scored option, so it rides along with the
     analysis already being requested. Offline it needs its own search. */
  function refreshHint() {
    if (!state.hintOn || state.over || !isHumanTurn()) {
      state.hint = -1;
      return;
    }
    if (backend.kind === 'rapfi') return;   // comes back with the analysis
    var seq = ++state.candSeq;
    askLocal(state.turn).then(function (res) {
      if (seq !== state.candSeq || !state.hintOn) return;
      state.hint = res.cell;
      render();
    });
  }

  /* ---- panel ------------------------------------------------------------ */

  function setBackend(next) {
    backend = next;
    els.engineBadge.textContent = next.label;
    els.analysis.hidden = next.kind !== 'rapfi';

    // Renju needs the engine: its forbidden points come from YXSHOWFORBID, and
    // the fallback engine cannot work them out.
    if (els.renjuOption) {
      els.renjuOption.disabled = next.kind !== 'rapfi';
      if (els.renjuOption.disabled && els.rule.value === 'renju') {
        els.rule.value = 'freestyle';
        clearForbidden();
      }
    }
  }

  function renderPanel() {
    var text, dotClass;
    if (state.over) {
      text = state.winner ? name(state.winner) + ' wins' : 'Draw';
      dotClass = state.winner === WHITE ? 'stone-dot white'
        : (state.winner ? 'stone-dot' : 'stone-dot none');
    } else {
      text = state.thinking
        ? (state.analysing ? 'Analysing' : 'Engine is thinking')
        : name(state.turn) + ' to move';
      dotClass = state.turn === WHITE ? 'stone-dot white' : 'stone-dot';
    }
    els.statusText.textContent = text;
    els.turnDot.className = dotClass;

    var meta = 'Move ' + board.history.length;
    if (!state.over && engineColor()) meta += ' · you are ' + name(3 - engineColor());
    els.statusMeta.textContent = state.error || meta;

    els.undo.disabled = state.thinking || board.history.length === 0;
    els.undoAll.disabled = els.undo.disabled;
    if (els.undoAll.disabled) cancelHold();   // nothing left to wipe, drop the countdown
    els.hint.disabled = false;
    els.hint.textContent = state.hintOn ? 'Hint on' : 'Hint off';
    els.hint.setAttribute('aria-pressed', state.hintOn ? 'true' : 'false');
    els.evalBarToggle.textContent = state.evalBarOn ? 'Evaluation bar on' : 'Evaluation bar off';
    els.evalBarToggle.setAttribute('aria-pressed', state.evalBarOn ? 'true' : 'false');

    var html = '';
    for (var i = 0; i < board.history.length; i++) {
      var g = state.grades[i];
      var cls = (i % 2 === 0 ? 'b' : 'w') + (i === board.history.length - 1 ? ' last' : '');
      if (g) cls += ' g-' + g.grade.toLowerCase();
      html += '<li class="' + cls + '">' +
              '<span class="n">' + (i + 1) + '</span>' +
              '<span class="sd">' + (i % 2 === 0 ? 'B' : 'W') + '</span>' +
              '<span class="c">' + G.toCoord(board.history[i]) + '</span>' +
              '<span class="ev">' + (g ? formatValue(g.value) : '') + '</span>' +
              '<span class="q">' + (g ? g.grade : '') + '</span>' +
              '</li>';
    }
    els.movelog.innerHTML = html;
    if (board.history.length) els.movelog.scrollTop = els.movelog.scrollHeight;

    renderReview();

    canvas.classList.toggle('locked', state.over || !isHumanTurn());
  }

  function titleCase(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* One column of the card: which stone was played, and what it made. */
  function setCoachColumn(moveEl, shapeEl, index) {
    if (index < 0 || index >= board.history.length) {
      moveEl.textContent = "";
      shapeEl.textContent = "";
      return;
    }
    var shape = state.shapes[index];
    moveEl.textContent = (index % 2 === 0 ? "B " : "W ") + G.toCoord(board.history[index]);
    shapeEl.textContent = shape ? shape.name : "";
  }

  /* The move just played sits on the right, the one before it on the left. */
  function renderCoach() {
    var i = board.history.length - 1;
    els.coachPhase.textContent = titleCase(phaseName());

    if (i < 0) {
      els.coachPrev.hidden = true;
      els.curMove.textContent = "Black opens";
      els.curShape.textContent = "";
      els.coachNote.textContent = "the first stone usually goes near the centre";
      return;
    }

    els.coachPrev.hidden = i < 1;
    setCoachColumn(els.prevMove, els.prevShape, i - 1);
    setCoachColumn(els.curMove, els.curShape, i);

    if (state.over) {
      els.coachNote.textContent = state.winner
        ? name(state.winner) + " made five in a row"
        : "the board is full";
      return;
    }
    var shape = state.shapes[i];
    els.coachNote.textContent = shape ? shape.note : "";
  }

  function render() {
    draw();
    renderPanel();
    renderCandidates();
    renderCoach();
    renderEvalBar();
  }

  /* ---- events ------------------------------------------------------------ */

  canvas.addEventListener('mousemove', function (e) {
    var cell = cellFromPoint(e.clientX, e.clientY);
    if (cell !== state.hover) { state.hover = cell; draw(); }
  });

  canvas.addEventListener('mouseleave', function () {
    if (state.hover !== -1) { state.hover = -1; draw(); }
  });

  canvas.addEventListener('click', function (e) {
    if (!isHumanTurn() || state.over) return;
    if (play(cellFromPoint(e.clientX, e.clientY))) settle();
  });

  /* A scored option is playable straight from the list. */
  els.candList.addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('li[data-cell]') : null;
    if (!li || !isHumanTurn() || state.over) return;
    if (play(Number(li.getAttribute('data-cell')))) settle();
  });

  els.newGame.addEventListener('click', newGame);
  els.undo.addEventListener('click', undo);
  els.hint.addEventListener('click', toggleHint);

  els.undoAll.addEventListener('mousedown', startHold);
  els.undoAll.addEventListener('mouseup', cancelHold);
  els.undoAll.addEventListener('mouseleave', cancelHold);
  els.undoAll.addEventListener('blur', cancelHold);
  els.undoAll.addEventListener('touchstart', function (e) {
    e.preventDefault();      // otherwise the synthetic mousedown starts it twice
    startHold();
  }, { passive: false });
  els.undoAll.addEventListener('touchend', cancelHold);
  els.undoAll.addEventListener('touchcancel', cancelHold);
  els.undoAll.addEventListener('click', function (e) { e.preventDefault(); });
  els.mode.addEventListener('change', newGame);
  els.rule.addEventListener('change', newGame);
  els.nbest.addEventListener('change', requestAnalysis);

  els.evalBarToggle.addEventListener('click', function () {
    state.evalBarOn = !state.evalBarOn;
    store(EVALBAR_KEY, state.evalBarOn ? 'on' : 'off');
    if (state.evalBarOn) requestAnalysis(); else state.whiteRate = null;
    render();
  });

  els.panelToggle.addEventListener('click', function () { setPanelOpen(false); });
  els.panelTab.addEventListener('click', function () { setPanelOpen(true); });
  els.leftToggle.addEventListener('click', function () { setLeftOpen(false); });
  els.leftTab.addEventListener('click', function () { setLeftOpen(true); });
  els.level.addEventListener('change', function () { state.hint = -1; render(); });
  els.thinkTime.addEventListener('change', function () { state.hint = -1; render(); });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newGame(); }
    else if (k === 'u') {
      e.preventDefault();
      // Shift+U has to be held too; key repeat is ignored while it counts down.
      if (e.shiftKey) startHold();
      else undo();
    } else if (k === 'h') { e.preventDefault(); toggleHint(); }
  });

  document.addEventListener('keyup', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'u' || k === 'shift') cancelHold();
  });

  window.addEventListener('blur', cancelHold);

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  /* ---- theme -------------------------------------------------------------
     "system" leaves the root element unmarked and lets the stylesheet's
     prefers-color-scheme block decide; light and dark stamp an explicit
     data-theme that wins in either direction. */

  var THEME_KEY = 'gomoku.theme';

  function applyPanelState() {
    var app = document.querySelector ? document.querySelector('.app') : null;
    if (app && app.classList) {
      app.classList.toggle('panel-collapsed', !state.panelOpen);
      app.classList.toggle('left-collapsed', !state.leftOpen);
    }
    els.panelToggle.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false');
    els.leftToggle.setAttribute('aria-expanded', state.leftOpen ? 'true' : 'false');
  }

  function setPanelOpen(open) {
    state.panelOpen = !!open;
    store(PANEL_KEY, state.panelOpen ? 'open' : 'closed');
    applyPanelState();
    resize();          // the board pane just changed width
  }

  function setLeftOpen(open) {
    state.leftOpen = !!open;
    store(LEFT_KEY, state.leftOpen ? 'open' : 'closed');
    applyPanelState();
    resize();
  }

  var EVALBAR_KEY = 'gomoku.evalbar';
  var PANEL_KEY = 'gomoku.panel';
  var LEFT_KEY = 'gomoku.leftpanel';

  /* Browser storage can throw outright in a private window. */
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* not available */ }
  }

  function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    refreshColors();
    draw();
  }

  function setTheme(choice) {
    els.theme.value = choice;
    store(THEME_KEY, choice);
    applyTheme(choice);
  }

  function initTheme() {
    var stored = recall(THEME_KEY);
    var choice = stored === 'light' || stored === 'dark' ? stored : 'system';
    els.theme.value = choice;
    applyTheme(choice);
  }

  els.theme.addEventListener('change', function () { setTheme(els.theme.value); });

  if (window.matchMedia) {
    var dark = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemChange = function () {
      if (els.theme.value === 'system') applyTheme('system');
    };
    if (dark.addEventListener) dark.addEventListener('change', onSystemChange);
    else if (dark.addListener) dark.addListener(onSystemChange);
  }

  /* ---- start ------------------------------------------------------------- */

  initTheme();
  state.evalBarOn = recall(EVALBAR_KEY) !== 'off';
  state.panelOpen = recall(PANEL_KEY) !== 'closed';
  state.leftOpen = recall(LEFT_KEY) !== 'closed';
  applyPanelState();
  setBackend(backend);
  clearAnalysis();
  resize();

  fetch('api/status').then(function (r) { return r.json(); }).then(function (s) {
    if (!s.available) throw new Error('engine unavailable');
    var version = (/version="([^"]*)"/.exec(s.about || '') || [])[1] || '';
    setBackend({
      kind: 'rapfi',
      label: 'Rapfi ' + (version.split(' ')[0] || '') + ' · ' + s.build
    });
    openEventStream();
  }).catch(function () {
    setBackend({ kind: 'local', label: 'Built-in engine, run server.js for Rapfi' });
  }).then(newGame);
})();
