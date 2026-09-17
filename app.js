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
    star: '--star',
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
  ['statusText', 'statusMeta', 'turnDot', 'engineBadge', 'mode', 'difficulty', 'difficultyNote',
   'rule', 'newGame', 'undo', 'undoAll', 'hint', 'valueMap', 'movelog', 'analysis',
   'anDepth', 'anEval', 'anNodes', 'anSpeed', 'anPv', 'nbest', 'candList',
   'review', 'theme', 'renjuOption', 'coachPhase', 'coachNote',
   'prevMove', 'prevShape', 'curMove', 'curShape', 'coachPrev',
   'boardStack', 'evalBar', 'evalFill', 'evalNumWhite', 'evalNumBlack',
   'evalBarToggle', 'panelToggle', 'panelTab', 'panelLeft', 'leftToggle', 'leftTab',
   'demoControls', 'demoMatch', 'demoNote', 'demoPace',
   'demoPlay', 'demoStep', 'demoStopOnError', 'engineFold', 'keysFold',
   'tabMoves', 'tabHistory', 'history', 'gameList', 'historyClear',
   'movesFoot', 'exportGame', 'exportReplay', 'reviewGame', 'reviewSummary', 'replayNote',
   'replay', 'replayTitle', 'replayLog', 'replayStart', 'replayPrev',
   'replayNext', 'replayEnd', 'replayClose', 'spectateBar', 'spectateUndo'].forEach(function (id) {
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
    reviewSeq: 0,       // a review that is closed under is abandoned the same way
    reviewing: null,    // { index, done, total } while a game is being read
    grades: [],         // grades[i] describes history[i]
    prior: null,        // analysis of the position before the pending move
    forbidden: [],      // renju: cells Black may not play
    forbidSeq: 0,
    shapes: [],         // shapes[i] names what history[i] created
    hintOn: false,
    evalBarOn: true,
    valueMapOn: false,
    stopOnError: true,  // sparring: hold the game when a side errs
    valueMap: [],       // empty points worth marking, and how much each is worth
    games: [],          // finished games, newest first
    tab: 'moves',       // which list the left panel shows
    replay: null,       // the game being replayed, and the live game it displaced
    whiteRate: null,    // white's share of the win chance, 0 to 1
    panelOpen: true,
    leftOpen: true,
    demoPaused: false,  // sparring: the game is held, waiting to be stepped on
    stoppedAt: -1,      // and the ply it was held on, so it holds there once
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


  /* index.html?spectate is the always-on-top window spectate.bat opens: the
     board alone, fixed in tactics mode with the hint on, for entering the moves
     of a game being watched elsewhere. spectate.bat finds the window by title. */
  var SPECTATE = /[?&]spectate(?:[=&]|$)/.test(location.search);
  var SPECTATE_TITLE = 'Gomoku spectator';

  /* How a point is written down: the board's own notation, A-O with row 1 at
     the bottom, the same form the engine prints. */
  function coordText(cell) {
    if (cell == null || cell < 0) return '';
    return G.toCoord(cell);
  }


  /* ---- sparring -----------------------------------------------------------
     The engine playing itself, for watching rather than for playing. The point
     is to learn from it, which rules out the obvious version: two copies at
     full strength trade a long balanced game where nothing ever goes wrong, so
     there is nothing to see and no reason a move was good. What teaches is a
     mistake and its answer, one after the other.

     So a matchup names a level for each side, and none of them is full against
     full. The best of them is deliberately lopsided: the stronger side punishes
     every slip, which is the clearest way to see why a slip was one. */

  var MATCHUPS = {
    'full-club':     { black: 'full',   white: 'club' },
    'club-club':     { black: 'club',   white: 'club' },
    'casual-casual': { black: 'casual', white: 'casual' },
    'difficulty':    null                 // both sides take the Difficulty dial
  };

  var MATCH_NOTE = {
    'full-club':     'Black punishes every slip White makes. The clearest way to see why a move was bad.',
    'club-club':     'Both sides err, so the mistakes and the answers come from either direction.',
    'casual-casual': 'Loose play throughout, which makes the mistakes easy to spot before they are answered.'
  };

  function isDemo() { return els.mode.value === 'demo'; }

  function matchup() { return MATCHUPS[els.demoMatch.value] || null; }

  /* Which settings a given side plays by. Outside sparring there is only one
     opponent, so both answers are the Difficulty dial. */
  function levelFor(color) {
    var m = isDemo() ? matchup() : null;
    if (!m) return difficulty();
    return DIFFICULTY[color === BLACK ? m.black : m.white] || difficulty();
  }

  function demoNoteText() {
    var m = matchup();
    if (m) return MATCH_NOTE[els.demoMatch.value] || '';
    if (els.difficulty.value === 'full') {
      return 'Two perfect players trade a balanced game with nothing to punish. ' +
             'Pick a lower Difficulty, or one of the matchups above.';
    }
    return 'Both sides at the current Difficulty setting.';
  }

  var demoTimer = 0;

  function clearDemoTimer() {
    if (demoTimer) { window.clearTimeout(demoTimer); demoTimer = 0; }
  }

  function scheduleDemoMove() {
    clearDemoTimer();
    var wait = Number(els.demoPace.value) || 0;
    demoTimer = window.setTimeout(function () {
      demoTimer = 0;
      maybeEngineMove();
    }, wait);
  }

  function setDemoPaused(paused) {
    state.demoPaused = !!paused;
    if (state.demoPaused) clearDemoTimer();
    render();
    if (!state.demoPaused) settle();
  }

  /* One move, then hold again. */
  function demoStep() {
    if (!isDemo() || state.over || state.thinking) return;
    state.demoPaused = true;
    clearDemoTimer();
    maybeEngineMove();
  }

  /* Whether the move just graded is worth stopping on. The grade is only known
     once the next search comes back, so this runs a move late by nature - which
     is what we want, since it holds the board on the mistake itself, before the
     answer to it is played.

     The ply it stopped on is remembered, because the grade that caused the stop
     is still sitting there afterwards: without this, carrying on would trip the
     same stop again and the game could never be resumed past a mistake. */
  function worthStopping() {
    if (!isDemo() || !state.stopOnError) return false;
    if (state.stoppedAt === board.history.length) return false;
    var g = state.grades[board.history.length - 1];
    return !!g && (g.grade === 'Mistake' || g.grade === 'Blunder');
  }

  /* ---- difficulty --------------------------------------------------------
     How well the engine plays, as one dial. It never searches less hard: every
     level reads the position at full strength and for a real length of time.
     What changes is which of the moves it found it then plays.

     The ladder is built two different ways, because one way does not reach the
     bottom of it.

     Club and above are Rapfi, handicapped by a `window`: how far below its own
     best move, in Rapfi's eval units, the move it plays may be. That keeps a
     good player's weakness coherent, since it can only ever pick from moves the
     engine has already read and understood.

     A window cannot make a beginner, though, because it shuts exactly where the
     game is decided: when a four has to be blocked every other reply is worse by
     thousands, so the block is the only move inside any window. Nor can search
     depth, which is how chess engines do this - measured here, Rapfi answers an
     open three at max_depth 1 exactly as it does at full depth, because in
     gomoku the shape is visible without any search at all. And randomly
     discarding the best move, which was the first thing tried here, produces an
     opponent that plays well and then twitches: the errors land anywhere, which
     is not how a person is wrong.

     So Beginner and Casual are the bundled engine reading the board through a
     perception table - what they take each shape to be worth. Lower the value
     of an open four and the player stops foreseeing that an open three becomes
     one, which is exactly the beginner's blind spot, while a four is still
     answered because that is measured against a five. The mistake is a property
     of the position rather than of a roll of the dice: the same board always
     draws the same error, and the errors land where a beginner's land.

     `depth` is how far the bundled engine looks, used by the perception levels
     and by every level when there is no Rapfi to reach.

     The eval numbers come from measuring real play: repeating the engine's own
     choice still shows a loss near 100 because two searches stop at different
     depths, and the tenth-best move in a balanced position costs about 430. */

  /* `sees` is a perception table: what the side reads each shape as being
     worth, against what it is worth. `window` is the eval slack a Rapfi level
     will settle for. A level uses one or the other, never both. */
  var DIFFICULTY = {
    beginner: { sees: { openFour: 0.05, openThree: 0.25, closedThree: 0.40, openTwo: 0.6 },
                depth: 1, timeoutMs: 300 },
    casual:   { sees: { openFour: 0.10, openThree: 0.45, closedThree: 0.60, openTwo: 0.8 },
                depth: 1, timeoutMs: 300 },
    club:     { window: 400, timeoutMs: 500,  depth: 3 },
    strong:   { window: 100, timeoutMs: 800,  depth: 4 },
    full:     { window: 0,   timeoutMs: 1500, depth: 6 }
  };

  /* Said plainly under the control, because "weaker" here does not mean what it
     usually means: the engine is not thinking less, it is settling for less. */
  var DIFFICULTY_NOTE = {
    beginner: 'Answers a four, but walks straight past an open three.',
    casual:   'Answers a four, and spots about half the open threes.',
    club:     'Answers everything, and takes the second-best line often enough.',
    strong:   'Answers everything, and is rarely off the best move.',
    full:     'Always plays the best move it finds.'
  };

  var ANALYSIS_MS = 1000;

  function difficulty() {
    return DIFFICULTY[els.difficulty.value] || DIFFICULTY.full;
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
  function exactFiveUnder(rule, player) {
    if (rule === 'standard') return true;
    if (rule === 'renju') return player === BLACK;
    return false;
  }

  function needsExactFive(player) {
    return exactFiveUnder(els.rule.value, player);
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

  /* The order the stones went down, written on them: 1 is Black's first, 2 is
     White's reply, and so on, so a finished game can be read off the board.
     Three digits get a smaller face so they still fit inside the stone. */
  function drawMoveNumbers() {
    var m = state.metrics, hist = board.history;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < hist.length; i++) {
      var label = String(i + 1);
      var scale = label.length > 2 ? 0.66 : (label.length > 1 ? 0.88 : 1.05);
      ctx.font = '600 ' + Math.max(7, Math.round(m.stone * scale)) +
                 'px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = board.cells[hist[i]] === BLACK ? COLOR.white : COLOR.black;
      ctx.fillText(label, px(colOf(hist[i])), px(rowOf(hist[i])));
    }
    ctx.restore();
  }

  function paintBoard() {
    var m = state.metrics, i, p;

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

    ctx.fillStyle = COLOR.star;
    for (i = 0; i < STAR.length; i++) {
      ctx.beginPath();
      ctx.arc(px(STAR[i][0]), px(STAR[i][1]), Math.max(2, m.step * 0.075), 0, Math.PI * 2);
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
  }

  function draw() {
    var m = state.metrics;
    if (!m) return;
    var i;

    paintBoard();

    for (i = 0; i < SIZE * SIZE; i++) {
      if (board.cells[i] !== EMPTY) drawStone(i, board.cells[i]);
    }

    drawValueMap();
    drawCandidates();
    drawForbidden();

    if (!state.over && !state.thinking && !isReplaying() && state.hover >= 0 &&
        board.cells[state.hover] === EMPTY && isHumanTurn()) {
      drawStone(state.hover, state.turn, 0.32);
    }

    if (state.hint >= 0 && board.cells[state.hint] === EMPTY) markHint(state.hint);

    var last = board.history[board.history.length - 1];
    if (last != null && !state.winLine) markLast(last);

    if (state.winLine && state.winLine.length) markWin(state.winLine);

    drawCursor();

    // Last, so the winning line does not strike through the numbers.
    if (isReplaying()) drawMoveNumbers();
  }

  function markHint(cell) {
    var m = state.metrics;
    ctx.save();
    ctx.strokeStyle = COLOR.hint;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(px(colOf(cell)), px(rowOf(cell)), m.stone, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function markLast(cell) {
    var m = state.metrics;
    ctx.save();
    if (isReplaying()) {
      // The number already sits in the middle of the stone, so the marker
      // for the move being shown goes round the outside of it.
      ctx.strokeStyle = COLOR.hint;
      ctx.lineWidth = Math.max(1.5, m.step * 0.05);
      ctx.beginPath();
      ctx.arc(px(colOf(cell)), px(rowOf(cell)), m.stone * 1.12, 0, Math.PI * 2);
    } else {
      ctx.strokeStyle = board.cells[cell] === BLACK ? COLOR.white : COLOR.black;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(colOf(cell)), px(rowOf(cell)), m.stone * 0.32, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  function markWin(line) {
    var m = state.metrics;
    var a = line[0], b = line[line.length - 1];
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

  /* ---- engine backends -------------------------------------------------- */

  function isCoach() { return els.mode.value === 'coach'; }

  /* 0 means nobody is played by the engine: two-player and coach both leave
     every stone to the user, coach just keeps the analysis running. */
  function engineColor() {
    var mode = els.mode.value;
    if (mode === 'ai-white') return WHITE;
    if (mode === 'ai-black') return BLACK;
    // Sparring: whoever is to move is the engine, so every check that compares
    // the two reads correctly without knowing about the mode at all.
    if (mode === 'demo') return state.turn;
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

  function askRapfi(color, timeoutMs, window) {
    return fetch('api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        engineColor: color,
        timeoutMs: timeoutMs,
        window: window
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      showAnalysis(data.info);
      return { cell: fromEngine(data.move.x, data.move.y), info: data.info };
    });
  }

  function askLocal(color, level) {
    var d = level || difficulty();
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ cell: board.bestMove(color, d.depth), info: null });
      }, 30);
    });
  }

  /* A level with a perception table is played by the bundled engine, on its own
     board so the live one keeps reading shapes truly for the coaching. */
  var novice = new G.Board();

  function noviceMove(color, level) {
    novice.reset();
    novice.perception = level.sees;
    for (var i = 0; i < board.history.length; i++) {
      novice.place(board.history[i], board.cells[board.history[i]]);
    }
    return novice.bestMove(color, level.depth);
  }

  /* Rapfi still reads the position even when it is not the one choosing, so the
     grading, the review line and the evaluation bar stay honest. The handicap is
     on who picks the move, never on what the coaching is allowed to know. */
  function readPosition(sideToMove) {
    return fetch('api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        sideToMove: sideToMove,
        timeoutMs: ANALYSIS_MS,
        count: 1
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      showAnalysis(data.info);
      return data.info;
    });
  }

  function askNovice(color, level) {
    var cell = noviceMove(color, level);
    if (backend.kind !== 'rapfi') return Promise.resolve({ cell: cell, info: null });
    return readPosition(color).then(function (info) {
      return { cell: cell, info: info };
    }, function () {
      return { cell: cell, info: null };
    });
  }

  function askForMove(color) {
    var d = levelFor(color);
    if (d.sees) return askNovice(color, d);
    if (backend.kind !== 'rapfi') return askLocal(color, d);
    return askRapfi(color, d.timeoutMs, d.window).catch(function (err) {
      // Rapfi went away mid-game: keep playing rather than stranding the user.
      setBackend({ kind: 'local', label: 'Built-in engine (Rapfi unreachable)' });
      return askLocal(color, d);
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
    if (isReplaying() || !isRenju() || backend.kind !== 'rapfi') {
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
    var m = state.metrics, arm = m.stone * 0.5, i, x, y;

    ctx.save();
    ctx.strokeStyle = COLOR.win;
    ctx.lineWidth = Math.max(1.5, m.step * 0.055);
    ctx.lineCap = 'round';
    for (i = 0; i < state.forbidden.length; i++) {
      x = px(colOf(state.forbidden[i])); y = px(rowOf(state.forbidden[i]));
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

  /* ---- finished games -----------------------------------------------------
     Every game that reaches a result is written to local storage, newest
     first, and can be replayed move by move. Colours are not stored because
     Black always opens: move i belongs to Black when i is even, which is also
     what the numbers drawn on the stones mean, 1 black, 2 white, 3 black.

     A replay takes the board over rather than drawing beside it, so the live
     game is put aside when one opens and handed back when it closes. */

  var HISTORY_KEY = 'gomoku.history';
  var TAB_KEY = 'gomoku.lefttab';
  var HISTORY_MAX = 50;

  var MODE_LABEL = {
    'ai-white': 'engine as White',
    'ai-black': 'engine as Black',
    'human': 'two players',
    'coach': 'tactics'
  };

  var RULE_LABEL = { freestyle: 'freestyle', standard: 'standard', renju: 'renju' };

  /* Games come back out of storage, so a row is built from the words in those
     two tables rather than from whatever the record happens to hold. */
  function gameMeta(game) {
    var meta = game.moves.length + ' moves';
    if (MODE_LABEL[game.mode]) meta += ' · ' + MODE_LABEL[game.mode];
    if (RULE_LABEL[game.rule]) meta += ' · ' + RULE_LABEL[game.rule];
    return meta;
  }

  function playerAt(index) { return index % 2 === 0 ? BLACK : WHITE; }

  function isReplaying() { return !!state.replay; }

  function loadGames() {
    var list;
    try { list = JSON.parse(recall(HISTORY_KEY) || '[]'); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    return list.filter(function (g) {
      return g && Array.isArray(g.moves) && g.moves.length;
    });
  }

  /* A long game on a nearly full store can go over the quota. Rather than lose
     the write, drop the oldest games until it fits. */
  function saveGames() {
    for (var n = state.games.length; n > 0; n--) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(state.games.slice(0, n)));
        state.games.length = n;      // whatever did not fit is gone for good
        return;
      } catch (e) { /* still too big: keep fewer */ }
    }
    // Nothing was written: either the list is empty, or there is no store at
    // all, in which case the games stay in memory for as long as the page does.
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* not available */ }
  }

  function sameMoves(a, b) {
    if (!a || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* Called the moment a game is decided. Taking the last move back and playing
     it again would otherwise file the same game twice, so an identical game at
     the top of the list is left alone. */
  function recordGame() {
    if (state.games.length && sameMoves(state.games[0].moves, board.history)) return;
    state.games.unshift({
      at: Date.now(),
      rule: els.rule.value,
      mode: els.mode.value,
      winner: state.winner,
      moves: board.history.slice(),
      grades: state.grades.slice(0, board.history.length)
    });
    if (state.games.length > HISTORY_MAX) state.games.length = HISTORY_MAX;
    saveGames();
  }

  function resultText(game) {
    return game.winner ? name(game.winner) + ' wins' : 'Draw';
  }

  function whenText(at) {
    var d = new Date(at);
    if (!at || isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /* Put the first `upto` moves on the board, naming the shape each one made as
     it lands: a shape depends on the stones already down, so the position has
     to be built up in order rather than dealt out at once. */
  function replayTo(moves, upto) {
    board.reset();
    state.shapes = [];
    for (var i = 0; i < upto; i++) {
      var player = playerAt(i);
      board.place(moves[i], player);
      state.shapes[i] = describeMove(moves[i], player);
    }
  }

  function openReplay(index) {
    var game = state.games[index];
    if (!game || state.thinking) return;

    if (!state.replay) {
      state.replay = {
        index: index,
        ply: 0,
        saved: {
          moves: board.history.slice(),
          turn: state.turn,
          over: state.over,
          winner: state.winner,
          winLine: state.winLine,
          grades: state.grades.slice(),
          shapes: state.shapes.slice(),
          prior: state.prior,
          whiteRate: state.whiteRate
        }
      };
      state.hint = -1;
      state.error = '';
      clearDemoTimer();
      clearCandidates();
      clearForbidden();
      clearAnalysis();
    }
    if (state.replay.index !== index) cancelReview();
    state.replay.index = index;
    setPly(game.moves.length);
  }

  /* Show the position after `n` moves. The stored valuations come along with
     it, so the move log, the review line and the evaluation bar all read as
     they did when the game was played. */
  function setPly(n) {
    var r = state.replay;
    if (!r) return;
    var game = state.games[r.index];
    if (!game) { closeReplay(); return; }

    r.ply = Math.max(0, Math.min(game.moves.length, n));
    replayTo(game.moves, r.ply);
    state.grades = (game.grades || []).slice(0, r.ply);
    state.turn = playerAt(r.ply);
    state.over = r.ply === game.moves.length;
    state.winner = state.over ? game.winner : 0;
    state.winLine = null;
    if (state.over && game.winner) {
      var last = game.moves[r.ply - 1];
      state.winLine = board.winningLineAt(last, exactFiveUnder(game.rule, game.winner));
    }

    var g = state.grades[r.ply - 1];
    // A grade is worth the position to whoever played that move.
    setWinRate(g && g.value != null ? g.value : null, playerAt(r.ply - 1));
    render();
  }

  function closeReplay() {
    var r = state.replay;
    if (!r) return;
    cancelReview();
    var saved = r.saved;
    state.replay = null;

    replayTo(saved.moves, saved.moves.length);
    state.shapes = saved.shapes;
    state.grades = saved.grades;
    state.turn = saved.turn;
    state.over = saved.over;
    state.winner = saved.winner;
    state.winLine = saved.winLine;
    state.prior = saved.prior;
    state.whiteRate = saved.whiteRate;
    state.hint = -1;
    state.error = '';
    render();
    settle();
  }

  function setTab(tab) {
    if (tab !== 'history') closeReplay();
    state.tab = tab;
    store(TAB_KEY, tab);
    render();
  }

  /* Wiping the list is a two-step button rather than a dialog: the first click
     arms it, the second does it, and moving off the button gives up. */
  var clearArmed = false;

  function armClear(on) {
    clearArmed = !!on;
    els.historyClear.textContent = clearArmed ? 'Clear all · sure?' : 'Clear history';
  }

  function clearHistory() {
    closeReplay();
    state.games = [];
    saveGames();
    render();
  }

  /* ---- exporting a record ------------------------------------------------
     The game written out rather than drawn: the notation a person reads, the
     engine coordinates a tool wants, and what the engine made of each move.
     Same shape whether it comes from the game in progress or one out of the
     history, so whatever is on screen is what lands in the file. */

  function sideName(player) { return player === BLACK ? 'black' : 'white'; }

  function gameRecord(moves, grades, shapes, meta) {
    return {
      app: 'rapfi-gomoku',
      savedAt: new Date().toISOString(),
      size: SIZE,
      rule: meta.rule,
      opponent: meta.mode,
      difficulty: meta.difficulty || null,
      result: meta.result,
      moves: moves.map(function (cell, i) {
        var point = toEngine(cell);
        var grade = grades ? grades[i] : null;
        var shape = shapes ? shapes[i] : null;
        var row = {
          n: i + 1,
          player: sideName(playerAt(i)),
          coord: G.toCoord(cell),
          x: point.x,
          y: point.y
        };
        if (grade) {
          row.eval = grade.value;
          row.grade = grade.grade;
          if (grade.bestCell >= 0 && grade.bestCell !== cell) {
            row.best = G.toCoord(grade.bestCell);
          }
          if (grade.bestShape) row.bestMakes = grade.bestShape;
          if (grade.bestLine) row.bestLine = grade.bestLine;
          if (grade.missedWin) row.missedWin = true;
          if (grade.winBefore != null) {
            row.winBefore = Math.round(grade.winBefore * 1000) / 1000;
            row.winAfter = Math.round(grade.winAfter * 1000) / 1000;
          }
        }
        if (shape) row.shape = shape.name;
        return row;
      })
    };
  }

  /* A replay has the board, so the game in progress is whatever it put aside. */
  function liveRecord() {
    var live = isReplaying() ? state.replay.saved : state;
    var moves = isReplaying() ? state.replay.saved.moves : board.history;
    return gameRecord(moves, live.grades, live.shapes, {
      rule: els.rule.value,
      mode: els.mode.value,
      difficulty: els.difficulty.value,
      result: live.over ? (live.winner ? sideName(live.winner) : 'draw') : 'unfinished'
    });
  }

  function savedRecord(game) {
    var record = gameRecord(game.moves, game.grades, null, {
      rule: game.rule,
      mode: game.mode,
      difficulty: null,
      result: game.winner ? sideName(game.winner) : 'draw'
    });
    if (game.review) record.review = game.review;
    return record;
  }

  function recordName(at) {
    var d = at ? new Date(at) : new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'gomoku-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
           '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
  }

  function downloadJson(name, data) {
    var url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Some browsers cancel the download if the URL goes away too soon.
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* One row per move, shared by the live log and the replay log. `current` is
     the move being shown, 1-based; anything after it is still to come. */
  function movelogHtml(moves, grades, current) {
    var html = '';
    for (var i = 0; i < moves.length; i++) {
      var g = grades ? grades[i] : null;
      var cls = i % 2 === 0 ? 'b' : 'w';
      if (i === current - 1) cls += ' last';
      if (i >= current) cls += ' ahead';
      if (g) cls += ' g-' + g.grade.toLowerCase();
      html += '<li class="' + cls + '" data-ply="' + (i + 1) + '">' +
              '<span class="n">' + (i + 1) + '</span>' +
              '<span class="sd">' + name(playerAt(i)).charAt(0) + '</span>' +
              '<span class="c">' + coordText(moves[i]) + '</span>' +
              '<span class="ev">' + (g ? formatValue(g.value) : '') + '</span>' +
              '<span class="q">' + (g ? g.grade : '') + '</span>' +
              '</li>';
    }
    return html;
  }

  function renderHistory() {
    var on = state.tab === 'history';
    els.history.hidden = !on;
    els.movelog.hidden = on;
    els.movesFoot.hidden = on;
    els.exportGame.disabled =
      !(isReplaying() ? state.replay.saved.moves : board.history).length;
    els.exportReplay.disabled = !isReplaying();
    els.tabMoves.setAttribute('aria-selected', on ? 'false' : 'true');
    els.tabHistory.setAttribute('aria-selected', on ? 'true' : 'false');
    if (!on) return;

    var html = '';
    for (var i = 0; i < state.games.length; i++) {
      var g = state.games[i];
      var dot = g.winner === WHITE ? 'stone-dot white'
        : (g.winner ? 'stone-dot' : 'stone-dot none');
      html += '<li class="' + (isReplaying() && state.replay.index === i ? 'current' : '') +
              '" data-game="' + i + '">' +
              '<span class="' + dot + '"></span>' +
              '<span class="g-text">' +
                '<span class="g-top">' +
                  '<span class="g-res">' + resultText(g) + '</span>' +
                  '<span class="g-when">' + whenText(g.at) + '</span>' +
                '</span>' +
                '<span class="g-meta">' + gameMeta(g) + '</span>' +
              '</span></li>';
    }
    els.gameList.innerHTML = html;
    els.historyClear.disabled = !state.games.length;
    if (!state.games.length && clearArmed) armClear(false);

    var r = state.replay;
    var game = r ? state.games[r.index] : null;
    els.replay.hidden = !game;
    if (!game) return;

    els.replayTitle.textContent = resultText(game) + ' · move ' + r.ply + ' of ' + game.moves.length;

    var rv = state.reviewing;
    els.reviewGame.disabled = backend.kind !== 'rapfi' || !!rv;
    els.reviewGame.textContent = rv ? 'Reviewing ' + rv.done + '/' + rv.total : 'Review';
    els.reviewSummary.innerHTML = reviewSummaryHtml(game);
    els.reviewSummary.hidden = !game.review;
    els.replayNote.innerHTML = reviewText(game.moves, game.grades || [], r.ply - 1, true);

    els.replayLog.innerHTML = movelogHtml(game.moves, game.grades, r.ply);
    var row = els.replayLog.querySelector ? els.replayLog.querySelector('li.last') : null;
    if (row) {
      // Keep the move being shown in view without scrolling the panel itself.
      els.replayLog.scrollTop = row.offsetTop - els.replayLog.clientHeight / 2 + row.offsetHeight;
    }
    els.replayStart.disabled = r.ply === 0;
    els.replayPrev.disabled = r.ply === 0;
    els.replayNext.disabled = r.ply === game.moves.length;
    els.replayEnd.disabled = r.ply === game.moves.length;
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
      bestCell: prior.bestCell,
      grade: playedBest ? 'Best' : gradeFor(loss)
    };
  }

  function requestAnalysis() {
    // Tactics mode analyses even when the option list is switched off.
    if (isReplaying()) { clearCandidates(); return; }    // the replay owns the board
    var count = Number(els.nbest.value) || (isCoach() && !SPECTATE ? 5 : 0)
                || (state.hintOn || state.evalBarOn ? 1 : 0);
    if (!count || backend.kind !== 'rapfi' || state.over || !isHumanTurn()) {
      clearCandidates();
      if (!state.hintOn || state.over) state.hint = -1;
      return;
    }
    var seq = ++state.candSeq;
    state.candPending = true;
    renderCandidates();

    // Keep analysis snappy: it queues ahead of the move the user is about to
    // make. Difficulty does not touch it - hints, scored options and the
    // evaluation bar are always the engine's real opinion.
    var timeoutMs = ANALYSIS_MS;

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

      var list = candidateList(data);
      var positionValue = data.info && data.info.eval != null
        ? evalToNumber(data.info.eval) : null;

      gradeLastMove(positionValue);
      setWinRate(positionValue, state.turn);

      state.prior = {
        moveCount: board.history.length,
        value: positionValue,
        bestCell: list.length ? list[0].cell : -1
      };

      state.candidates = list;
      state.candPending = false;
      if (state.hintOn && list.length) state.hint = list[0].cell;
      // If only the hint asked for this search, do not paint the option list.
      if (!Number(els.nbest.value) && (!isCoach() || SPECTATE)) state.candidates = [];
      render();
    }).catch(function () {
      if (seq !== state.candSeq) return;
      state.candPending = false;
      state.candidates = [];
      render();
    });
  }

  /* Rapfi's ranked list as cells, best first, for whatever position is on the
     board. A forced position can come back with a move but no ranked list. */
  function candidateList(data) {
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
    if (!list.length && data.best) {
      var cell = fromEngine(data.best.x, data.best.y);
      if (cell >= 0 && board.cells[cell] === EMPTY) {
        list = [{ cell: cell, score: '', value: 0, depth: '', pv: [] }];
      }
    }
    return list;
  }

  /* ---- game review ---------------------------------------------------------
     The engine reading a finished game back, the way a coach would: every
     position at full strength, and for every move what it cost, what would
     have been better, and what that would have made.

     The grades from live play are a running commentary, snatched from a short
     search in the gap before the next move, and they are noisy for the same
     reason. A review re-reads each position with a longer search and, where it
     can, scores the move actually played from the same search that scored the
     best one, so the two are comparable rather than two clocks stopped at
     different depths. The result replaces the game's grades and is stored with
     it, so a review is run once and then stepped through.

     The board walks through the game as it goes. That is not decoration: each
     position has to be on the board anyway for the engine to be asked about
     it, and for the shape a better move would have made to be worked out. */

  var REVIEW_MS = 800;
  var REVIEW_COUNT = 5;

  /* "would have made a four-three" is worth saying; "would have made a quiet
     move" is not, and for those the line falls back to naming the point. */
  var THREATS = ['five in a row', 'open four', 'double four', 'four-three',
                 'double three', 'four', 'open three', 'closed three'];

  /* What a stone at `cell` would make, without leaving it there. */
  function wouldMake(cell, player) {
    if (cell < 0 || board.cells[cell] !== EMPTY) return null;
    board.cells[cell] = player;
    var shape = describeMove(cell, player);
    board.cells[cell] = EMPTY;
    return shape;
  }

  function analyzeAt(sideToMove, count, timeoutMs) {
    return fetch('api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: SIZE,
        rule: els.rule.value,
        stones: stonesForEngine(),
        sideToMove: sideToMove,
        timeoutMs: timeoutMs,
        count: count
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      var list = candidateList(data);
      var value = data.info && data.info.eval != null ? evalToNumber(data.info.eval) : null;
      // The value of a position is the value of its best move, so when the
      // summary line is missing but the ranked list is not, the list will do.
      if (value === null && list.length && list[0].score !== '') value = list[0].value;
      return { value: value, list: list };
    });
  }

  function cancelReview() {
    state.reviewSeq++;
    state.reviewing = null;
  }

  /* The grade for move `index`, from the reading of the position before it
     (`prior`) and the reading of the position after (`now`). `winner` is set
     only for the final move of a decided game, which needs no second reading:
     it made five. */
  function gradeReviewed(moves, index, prior, now, winner) {
    var played = moves[index], mover = playerAt(index);
    // The move that made five is the best move there is, whatever the search
    // managed to say about the position before it.
    if (winner && winner === mover) {
      return {
        value: 999999, loss: 0, bestCell: played, grade: 'Best',
        winBefore: prior && prior.value !== null ? winRateFor(prior.value) : 1, winAfter: 1
      };
    }
    if (!prior || prior.value === null) return null;
    var before = prior.value, after, i;

    var same = null;
    for (i = 0; i < prior.list.length; i++) {
      if (prior.list[i].cell === played && prior.list[i].score !== '') same = prior.list[i];
    }
    if (winner) after = winner === mover ? 999999 : -999999;
    else if (same) after = same.value;               // same search as the best move
    else if (now && now.value !== null) after = -now.value;
    else return null;

    var loss = Math.max(0, before - after);
    var bestCell = prior.list.length ? prior.list[0].cell : -1;
    var playedBest = bestCell === played;
    var grade = {
      value: after,
      loss: loss,
      bestCell: bestCell,
      grade: playedBest ? 'Best' : gradeFor(loss),
      winBefore: winRateFor(before),
      winAfter: winRateFor(after)
    };
    if (before >= 1e5 && after < 1e5) grade.missedWin = true;
    if (!playedBest && bestCell >= 0 && (grade.grade !== 'Good' || grade.missedWin)) {
      if (prior.bestShape && THREATS.indexOf(prior.bestShape.name) >= 0) {
        grade.bestShape = prior.bestShape.name;
      }
      var pv = prior.list[0].pv;
      if (pv && pv.length > 1) grade.bestLine = pv.slice(0, 4);
    }
    return grade;
  }

  /* The verdict on the whole game. Accuracy is the mean, over a side's moves,
     of the win chance each move kept: a move that dropped its player from 60%
     to 40% scores 0.8, a move that gave nothing away scores 1. Win chance is
     Rapfi's own logistic of its evaluation, so this is scale-free and does
     not depend on the eval units. There is no standard for this number; that
     is what it is here. */
  function summarise(game, grades) {
    var drops = { 1: [], 2: [] }, counts = { 1: {}, 2: {} };
    var worst = null, missed = [];
    for (var i = 0; i < game.moves.length; i++) {
      var g = grades[i];
      if (!g) continue;
      var side = playerAt(i);
      var drop = Math.max(0, (g.winBefore || 0) - (g.winAfter || 0));
      drops[side].push(drop);
      counts[side][g.grade] = (counts[side][g.grade] || 0) + 1;
      if (!worst || drop > worst.drop) {
        worst = { ply: i + 1, side: side, drop: drop, from: g.winBefore, to: g.winAfter };
      }
      if (g.missedWin) missed.push({ ply: i + 1, cell: g.bestCell });
    }
    function accuracy(list) {
      if (!list.length) return null;
      var kept = 0;
      for (var k = 0; k < list.length; k++) kept += 1 - list[k];
      return Math.round(100 * kept / list.length);
    }
    return {
      at: Date.now(),
      accuracy: { black: accuracy(drops[1]), white: accuracy(drops[2]) },
      counts: { black: counts[1], white: counts[2] },
      turning: worst && worst.drop >= 0.15 ? worst : null,
      missed: missed.slice(0, 6)
    };
  }

  function reviewGame(index) {
    var game = state.games[index];
    if (!game || backend.kind !== 'rapfi' || state.reviewing) return;
    if (!isReplaying() || state.replay.index !== index) openReplay(index);
    if (!isReplaying()) return;

    var seq = ++state.reviewSeq;
    var moves = game.moves, total = moves.length;
    var grades = [], prior = null;
    state.reviewing = { index: index, done: 0, total: total };

    function stale() {
      return seq !== state.reviewSeq || !isReplaying() || state.replay.index !== index;
    }

    function step(i) {
      if (stale()) return;
      setPly(i);
      state.reviewing.done = i;
      render();

      var mover = playerAt(i);
      var decided = i === total;
      var read = decided ? Promise.resolve(null) : analyzeAt(mover, REVIEW_COUNT, REVIEW_MS);
      read.then(function (now) {
        if (stale()) return;
        /* Rapfi resolves a won position by force and reports no value for it
           at all. The position before the winning move is exactly that, and
           the record proves what it was worth: a win in one for the side to
           move. Filling it in is what lets the move that allowed it be graded. */
        if (now && now.value === null && game.winner && i === total - 1 && mover === game.winner) {
          now.value = 999999;
        }
        if (i > 0) grades[i - 1] = gradeReviewed(moves, i - 1, prior, now, decided ? game.winner : 0);
        if (now) now.bestShape = now.list.length ? wouldMake(now.list[0].cell, mover) : null;
        prior = now;
        if (i < total) step(i + 1); else finish();
      }, function () {
        // One search failing loses one grade, not the review.
        if (stale()) return;
        prior = null;
        if (i < total) step(i + 1); else finish();
      });
    }

    function finish() {
      game.grades = grades;
      game.review = summarise(game, grades);
      state.reviewing = null;
      saveGames();
      setPly(state.replay.ply);
    }

    step(0);
  }

  /* What the review has to say about the move being shown, as one line. Shared
     by the live review line and the note above the replay log. */
  function reviewText(moves, grades, index, asHtml) {
    var g = index >= 0 ? grades[index] : null;
    if (!g) return '';
    var played = coordText(moves[index]);
    var strong = function (t) { return asHtml ? '<b>' + t + '</b>' : t; };
    var text = 'Move ' + (index + 1) + ' ' + strong(played) + ' · ' + g.grade;
    if (g.grade === 'Best') return text;

    // A move that turns a playable position into a lost one shows a loss on
    // the mate scale, six digits of it, which says nothing. Name it instead.
    text += g.loss >= 1e5 ? ' · walked into a forced loss'
                          : ' · gave up ' + Math.round(g.loss);

    var alt = g.bestCell >= 0 && g.bestCell !== moves[index] ? coordText(g.bestCell) : '';
    if (alt) {
      if (g.missedWin) text += ' · ' + strong(alt) + ' was a forced win';
      else if (g.bestShape) text += ' · ' + strong(alt) + ' would have made ' + g.bestShape;
      else text += ' · best was ' + strong(alt);
      if (g.bestLine && g.bestLine.length > 1) text += ' (' + g.bestLine.join(' ') + ')';
    }
    return text;
  }

  function reviewSummaryHtml(game) {
    var rv = game.review;
    if (!rv) return '';
    var line = function (side, key) {
      var c = rv.counts[key] || {}, parts = [];
      ['Best', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'].forEach(function (grade) {
        if (c[grade]) parts.push(c[grade] + ' ' + grade.toLowerCase());
      });
      var acc = rv.accuracy[key];
      return '<div><b>' + name(side) + '</b> <span class="acc">' +
             (acc === null ? '–' : acc + '%') + '</span> accuracy' +
             (parts.length ? ' · ' + parts.join(', ') : '') + '</div>';
    };
    var html = line(BLACK, 'black') + line(WHITE, 'white');
    if (rv.turning) {
      var t = rv.turning;
      html += '<div>Turning point: <span data-ply="' + t.ply + '">' +
              'move ' + t.ply + '</span>, ' + name(t.side) +
              ' ' + coordText(game.moves[t.ply - 1]) + ' — win chance ' +
              Math.round(t.from * 100) + '% → ' + Math.round(t.to * 100) + '%</div>';
    }
    if (rv.missed.length) {
      html += '<div>Missed wins: ' + rv.missed.map(function (m) {
        return '<span data-ply="' + m.ply + '">move ' + m.ply +
               '</span> (' + coordText(m.cell) + ')';
      }).join(', ') + '</div>';
    }
    return html;
  }

  function renderReview() {
    els.review.textContent = reviewText(board.history, state.grades, board.history.length - 1, false);
  }

  function renderCandidates() {
    var html = '';
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      html += '<li class="' + (i === 0 ? 'top' : '') + '" data-cell="' + c.cell + '">' +
              '<span class="rank">' + (i + 1) + '</span>' +
              '<span class="mv">' + coordText(c.cell) + '</span>' +
              (c.depth ? '<span class="dp">d' + c.depth + '</span>' : '') +
              '<span class="sc">' + (c.score === '' ? 'forced' : formatEval(c.score)) + '</span>' +
              '</li>';
    }
    els.candList.innerHTML = html;
    els.candList.classList.toggle('pending', state.candPending);
  }

  function candidatesShown() {
    return state.candidates.length > 0 && !state.over;
  }

  function drawCandidates() {
    if (!candidatesShown()) return;
    var m = state.metrics, i, c, x, y;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < state.candidates.length; i++) {
      c = state.candidates[i];
      x = px(colOf(c.cell)); y = px(rowOf(c.cell));
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

  /* ---- point value map ---------------------------------------------------
     A dot on every empty point that is worth something, sized by how much: what
     a stone there would build for the side to move, plus what it would deny the
     other side. Both halves come from the bundled engine's pattern tables, so
     the map is instant, costs the engine nothing and works offline, but it is a
     reading of the shapes on the board rather than a search. It shows where the
     game is being decided; which move is actually best is what the engine's
     scored options are for, and the two can honestly disagree.

     Pattern values span six orders of magnitude, from a lone stone at 4 to a
     five in a row at five million, so a dot drawn in proportion to the raw
     number would leave everything but the hottest point invisible. Each point
     is sized by its share of the best point on the board, pulled together by a
     cube root: half the value is still four fifths of the width, a hundredth of
     it a fifth. So the dots compare with each other, not across positions - the
     biggest one is simply wherever the game is hottest right now. */

  var MAP_FLOOR = 0.16;      // below this share of the top point, not worth a dot
  var MAP_POINTS = 48;       // and no more than a boardful of the ones that are

  /* Dot radius as a share of a stone's. Even the hottest point stays well under
     half a stone: at anything close to one the dots start reading as pieces
     already on the board. Weight carries the alpha as well as the size, so the
     quiet end of the map fades out rather than crowding in. */
  var MAP_DOT_MIN = 0.12;
  var MAP_DOT_MAX = 0.45;

  function refreshValueMap() {
    state.valueMap = [];
    if (!state.valueMapOn || state.over) return;

    var list = board.influence(state.turn);
    if (!list.length || list[0].value <= 0) return;

    var top = list[0].value;
    for (var i = 0; i < list.length && state.valueMap.length < MAP_POINTS; i++) {
      var weight = Math.cbrt(Math.max(0, list[i].value) / top);
      if (weight < MAP_FLOOR) break;      // sorted, so nothing further down qualifies
      state.valueMap.push({ cell: list[i].cell, weight: weight });
    }
  }

  /* One mark to a point. Where the engine has scored a point itself, its ring
     and the evaluation written inside say more than a dot would, and read
     better without one behind them, so the map leaves those points to it and
     fills in the rest of the board around them. */
  function drawValueMap() {
    if (!state.valueMap.length) return;
    var m = state.metrics, i;

    var ranked = [];
    if (candidatesShown()) {
      for (i = 0; i < state.candidates.length; i++) ranked.push(state.candidates[i].cell);
    }

    ctx.save();
    ctx.fillStyle = COLOR.hint;
    for (i = 0; i < state.valueMap.length; i++) {
      var d = state.valueMap[i];
      if (ranked.indexOf(d.cell) >= 0) continue;
      ctx.globalAlpha = 0.15 + 0.45 * d.weight;
      ctx.beginPath();
      ctx.arc(px(colOf(d.cell)), px(rowOf(d.cell)),
              m.stone * (MAP_DOT_MIN + (MAP_DOT_MAX - MAP_DOT_MIN) * d.weight),
              0, Math.PI * 2);
      ctx.fill();
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

  /* ---- right-drag cursor -------------------------------------------------
     Holding the right button over the board shows a cross under the pointer
     that snaps to the nearest point. Letting go over the board plays there;
     letting go off the board plays nothing.

     In the spectator window the game being watched usually has the focus, so
     the page cannot see the mouse. spectate.bat's helper reads it instead and
     relays where the pointer is on screen, in physical pixels, as the right
     button goes down, while it is held and as it comes up. The page turns that
     into its own coordinates, so a drag behaves the same whichever window has
     the focus. A press that does not start over the board belongs to the other
     program and is ignored. */

  var cursor = { active: false, local: false, off: false, x: 0, y: 0, muteUntil: 0 };

  /* Where the page's viewport sits on screen, relative to the window's own
     position. Measured from any real mouse event over the page; until there
     has been one it is estimated from the size of the window frame. */
  var viewportOffset = null;

  function clientFromScreen(px, py) {
    var dpr = window.devicePixelRatio || 1;
    var frame = (window.outerWidth - window.innerWidth) / 2;
    var off = viewportOffset || { x: frame, y: window.outerHeight - window.innerHeight - frame };
    return { x: px / dpr - window.screenX - off.x, y: py / dpr - window.screenY - off.y };
  }

  function overBoard(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  function cursorCell() {
    var m = state.metrics;
    var col = Math.max(0, Math.min(SIZE - 1, Math.round((cursor.x - m.pad) / m.step)));
    var row = Math.max(0, Math.min(SIZE - 1, Math.round((cursor.y - m.pad) / m.step)));
    return row * SIZE + col;
  }

  function dragCursor(clientX, clientY) {
    if (!cursor.active) return;
    var r = canvas.getBoundingClientRect();
    cursor.x = clientX - r.left;
    cursor.y = clientY - r.top;
    cursor.off = !overBoard(clientX, clientY);
    state.hover = cursor.off ? -1 : cursorCell();
    draw();
  }

  function pressCursor(clientX, clientY, local) {
    if (!state.metrics || !overBoard(clientX, clientY)) return false;
    cursor.active = true;
    cursor.local = local;
    dragCursor(clientX, clientY);
    return true;
  }

  function releaseCursor(clientX, clientY) {
    if (!cursor.active) return;
    dragCursor(clientX, clientY);
    var off = cursor.off;
    cursor.active = false;
    cursor.local = false;
    state.hover = -1;
    if (!off && isHumanTurn() && !state.over && !isReplaying() && play(cursorCell())) {
      settle();
      return;
    }
    draw();
  }

  function remoteCursor(ev) {
    if (!ev) return;
    // A right-drag over this window reaches the page directly as well as
    // through the helper, and the relayed copy arrives later. The page's own
    // events win, so the copy is dropped until it has had time to catch up.
    if (cursor.local || Date.now() < cursor.muteUntil) return;
    var p = clientFromScreen(Number(ev.x), Number(ev.y));
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (ev.phase === 'down') pressCursor(p.x, p.y, false);
    else if (ev.phase === 'move') dragCursor(p.x, p.y);
    else if (ev.phase === 'up') releaseCursor(p.x, p.y);
  }

  if (SPECTATE) {
    window.addEventListener('mousemove', function (e) {
      viewportOffset = {
        x: e.screenX - e.clientX - window.screenX,
        y: e.screenY - e.clientY - window.screenY
      };
      if (cursor.local) dragCursor(e.clientX, e.clientY);
    });
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 2) return;
      e.preventDefault();
      pressCursor(e.clientX, e.clientY, true);
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button !== 2 || !cursor.local) return;
      cursor.muteUntil = Date.now() + 600;
      releaseCursor(e.clientX, e.clientY);
    });
  }

  function drawCursor() {
    if (!cursor.active || cursor.off) return;
    var r = state.metrics.step * 0.18;
    ctx.save();
    ctx.strokeStyle = COLOR.win;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursor.x - r, cursor.y); ctx.lineTo(cursor.x + r, cursor.y);
    ctx.moveTo(cursor.x, cursor.y - r); ctx.lineTo(cursor.x, cursor.y + r);
    ctx.stroke();
    ctx.restore();
  }

  function openEventStream() {
    if (!window.EventSource) return;
    var es = new EventSource('api/events');
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.kind === 'cursor') { if (SPECTATE) remoteCursor(msg.text); return; }
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
      state.error = coordText(cell) + ' is forbidden for Black: ' + forbiddenReason(cell);
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
    if (state.over) recordGame();
    render();
    return true;
  }

  /* Called whenever the position changes: either the engine owes a move, or
     the side to move is human and their options can be scored. */
  function settle() {
    if (isReplaying()) return;
    requestForbidden();
    var color = engineColor();
    if (!state.over && color && state.turn === color && !state.thinking) {
      // Sparring runs on a clock so the game can be followed, and stops dead
      // while it is paused.
      if (isDemo()) { if (!state.demoPaused) scheduleDemoMove(); }
      else maybeEngineMove();
    } else { requestAnalysis(); refreshHint(); }
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
          bestCell: -1
        };
      }
      /* Hold the board on a mistake before its answer is played, so there is
         a moment to look at the position and work out the punishment. The move
         just searched for is dropped and searched again on the way out, which
         costs one search and keeps the grading in step. */
      if (worthStopping()) {
        state.demoPaused = true;
        state.stoppedAt = board.history.length;
        clearDemoTimer();
        render();
        return;
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
    cancelReview();
    clearDemoTimer();
    state.demoPaused = false;
    state.stoppedAt = -1;
    // A replay is holding the board: drop it, the new game replaces it anyway.
    if (isReplaying()) { state.replay = null; state.tab = 'moves'; store(TAB_KEY, 'moves'); }
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

  /* Shared tail of undo and undo-all. Sparring holds after a takeback rather
     than charging straight back into the position just left. */
  function afterTakeback() {
    state.stoppedAt = -1;
    if (isDemo()) { clearDemoTimer(); state.demoPaused = true; }
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
    if (state.thinking || isReplaying() || !board.history.length) return;
    var color = engineColor();
    // Sparring has no side of its own to get back to, so it steps one move.
    var steps = isDemo() ? 1 : (color ? 2 : 1);
    // If the human moved last, one step is enough to get back to their turn.
    if (!isDemo() && color && board.cells[board.history[board.history.length - 1]] !== color) steps = 1;
    for (var i = 0; i < steps && board.history.length; i++) board.undo();
    afterTakeback();
  }

  function undoAll() {
    if (state.thinking || isReplaying() || !board.history.length) return;
    while (board.history.length) board.undo();
    afterTakeback();
  }

  /* ---- hold to undo all --------------------------------------------------
     Wiping the whole game is a press-and-hold rather than a click, so it
     cannot happen by accident. Letting go early abandons it. */

  var HOLD_MS = 1500;
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
    els.undoAll.textContent = 'Hold ' + ((HOLD_MS - elapsed) / 1000).toFixed(1);
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

  function toggleValueMap() {
    state.valueMapOn = !state.valueMapOn;
    store(VALUEMAP_KEY, state.valueMapOn ? 'on' : 'off');
    render();
  }

  /* With Rapfi the hint is the top scored option, so it rides along with the
     analysis already being requested. Offline it needs its own search. */
  function refreshHint() {
    if (!state.hintOn || state.over || isReplaying() || !isHumanTurn()) {
      state.hint = -1;
      return;
    }
    if (backend.kind === 'rapfi') return;   // comes back with the analysis
    var seq = ++state.candSeq;
    // Advice is always full strength: the difficulty setting handicaps the
    // engine as an opponent, not as a coach.
    askLocal(state.turn, DIFFICULTY.full).then(function (res) {
      if (seq !== state.candSeq || !state.hintOn) return;
      state.hint = res.cell;
      render();
    });
  }

  /* ---- panel ------------------------------------------------------------ */

  /* The rule the user has asked for, which is not always the one in force:
     renju needs Rapfi, and the page opens on the fallback engine for the moment
     it takes `api/status` to answer. Without remembering the choice, a default
     of renju would be knocked down to freestyle during that moment and never
     come back. */
  var wantedRule = els.rule.value;

  function paintBadge() {
    els.engineBadge.textContent = backend.label;
  }

  function setBackend(next) {
    backend = next;
    paintBadge();
    els.analysis.hidden = next.kind !== 'rapfi';

    // Renju needs the engine: its forbidden points come from YXSHOWFORBID, and
    // the fallback engine cannot work them out. It steps aside while there is no
    // engine and comes back as soon as there is one.
    if (els.renjuOption) {
      var canRenju = next.kind === 'rapfi';
      els.renjuOption.disabled = !canRenju;
      if (!canRenju && els.rule.value === 'renju') {
        els.rule.value = 'freestyle';
        clearForbidden();
      } else if (canRenju && wantedRule === 'renju' && els.rule.value !== 'renju') {
        els.rule.value = 'renju';
      }
    }
  }

  function renderPanel() {
    var text, dotClass;
    var replayed = isReplaying() ? state.games[state.replay.index] : null;
    if (replayed) {
      text = 'Replay · ' + resultText(replayed);
      dotClass = replayed.winner === WHITE ? 'stone-dot white'
        : (replayed.winner ? 'stone-dot' : 'stone-dot none');
    } else if (state.over) {
      text = state.winner ? name(state.winner) + ' wins' : 'Draw';
      dotClass = state.winner === WHITE ? 'stone-dot white'
        : (state.winner ? 'stone-dot' : 'stone-dot none');
    } else {
      text = state.thinking
        ? (state.analysing ? 'Analysing' : 'Engine is thinking')
        : name(state.turn) + ' to move';
      if (isDemo() && !state.thinking && state.demoPaused) {
        text = name(state.turn) + ' to play · held';
      }
      dotClass = state.turn === WHITE ? 'stone-dot white' : 'stone-dot';
    }
    els.statusText.textContent = text;
    els.turnDot.className = dotClass;

    var meta = 'Move ' + board.history.length;
    if (replayed) meta += ' of ' + replayed.moves.length;
    else if (isDemo()) meta += state.over ? '' : (state.demoPaused ? ' · holding' : ' · running');
    else if (!state.over && engineColor()) meta += ' · you are ' + name(3 - engineColor());
    els.statusMeta.textContent = state.error || meta;

    els.undo.disabled = state.thinking || isReplaying() || board.history.length === 0;
    els.undoAll.disabled = els.undo.disabled;
    if (els.undoAll.disabled) cancelHold();   // nothing left to wipe, drop the countdown
    if (!hold.active) els.undoAll.textContent = 'Undo all';
    els.hint.disabled = isReplaying();
    paintBadge();
    els.hint.textContent = state.hintOn ? 'Hint on' : 'Hint off';
    els.hint.setAttribute('aria-pressed', state.hintOn ? 'true' : 'false');
    els.demoControls.hidden = !isDemo();
    if (isDemo()) {
      els.demoNote.textContent = demoNoteText();
      els.demoPlay.textContent = state.demoPaused ? 'Play' : 'Pause';
      els.demoPlay.disabled = state.over;
      els.demoStep.disabled = state.over || state.thinking || !state.demoPaused;
      els.demoStopOnError.textContent = state.stopOnError ? 'Stop on mistakes' : 'Run without stopping';
      els.demoStopOnError.setAttribute('aria-pressed', state.stopOnError ? 'true' : 'false');
    }
    // A fixed matchup names both levels itself, so the Difficulty dial has
    // nothing to say and should not look as though it does.
    var dialIdle = isDemo() && !!matchup();
    els.difficulty.disabled = dialIdle;
    els.difficultyNote.textContent = dialIdle
      ? 'Not used while the matchup above sets both sides.'
      : (backend.kind === 'rapfi'
        ? DIFFICULTY_NOTE[els.difficulty.value]
        : 'Without Rapfi the built-in engine approximates this by search depth.');
    els.valueMap.textContent = state.valueMapOn ? 'Value map on' : 'Value map off';
    els.valueMap.setAttribute('aria-pressed', state.valueMapOn ? 'true' : 'false');
    els.evalBarToggle.textContent = state.evalBarOn ? 'Evaluation bar on' : 'Evaluation bar off';
    els.evalBarToggle.setAttribute('aria-pressed', state.evalBarOn ? 'true' : 'false');

    // A replay has the board, so the live log comes from what it put aside.
    var moves = isReplaying() ? state.replay.saved.moves : board.history;
    var grades = isReplaying() ? state.replay.saved.grades : state.grades;
    els.movelog.innerHTML = movelogHtml(moves, grades, moves.length);
    if (moves.length) els.movelog.scrollTop = els.movelog.scrollHeight;

    renderReview();

    canvas.classList.toggle('locked', state.over || isReplaying() || !isHumanTurn());

    if (SPECTATE) {
      var sides = els.spectateBar.querySelectorAll('button[data-mode]');
      for (var s = 0; s < sides.length; s++) {
        sides[s].setAttribute('aria-pressed', sides[s].getAttribute('data-mode') === els.mode.value ? 'true' : 'false');
        sides[s].disabled = state.thinking;
      }
      els.spectateUndo.disabled = els.undo.disabled;
    }
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
    moveEl.textContent = name(playerAt(index)).charAt(0) + " " + coordText(board.history[index]);
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
    refreshValueMap();
    draw();
    renderPanel();
    renderHistory();
    renderCandidates();
    renderCoach();
    renderEvalBar();
  }

  /* ---- events ------------------------------------------------------------ */

  canvas.addEventListener('mousemove', function (e) {
    if (cursor.active) return;
    var cell = cellFromPoint(e.clientX, e.clientY);
    if (cell !== state.hover) { state.hover = cell; draw(); }
  });

  canvas.addEventListener('mouseleave', function () {
    if (cursor.active) return;           // the right-drag cursor owns the hover
    if (state.hover !== -1) { state.hover = -1; draw(); }
  });

  // A right-drag over the spectator window drives the cursor, so the browser's
  // menu must not open on top of it.
  if (SPECTATE) document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('click', function (e) {
    if (!isHumanTurn() || state.over || isReplaying()) return;
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
  els.valueMap.addEventListener('click', toggleValueMap);

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

  /* Spectator window: picking a side hands the other one to the engine without
     clearing the board, so it can be changed partway through a game. If it is
     now the engine's turn, it moves straight away. */
  els.spectateUndo.addEventListener('click', undo);

  els.spectateBar.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-mode]') : null;
    if (!btn || state.thinking || btn.getAttribute('data-mode') === els.mode.value) return;
    els.mode.value = btn.getAttribute('data-mode');
    state.hint = -1;
    render();
    settle();
  });

  els.demoPlay.addEventListener('click', function () { setDemoPaused(!state.demoPaused); });
  els.demoStep.addEventListener('click', demoStep);
  els.demoStopOnError.addEventListener('click', function () {
    state.stopOnError = !state.stopOnError;
    store(STOPERR_KEY, state.stopOnError ? 'on' : 'off');
    render();
  });
  els.demoMatch.addEventListener('change', newGame);
  els.demoPace.addEventListener('change', function () {
    store(PACE_KEY, els.demoPace.value);
    render();
  });

  els.tabMoves.addEventListener('click', function () { setTab('moves'); });
  els.tabHistory.addEventListener('click', function () { setTab('history'); });

  els.gameList.addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('li[data-game]') : null;
    if (li) openReplay(Number(li.getAttribute('data-game')));
  });

  /* Any move in the replay log is a place to jump to. */
  els.replayLog.addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('li[data-ply]') : null;
    if (li) setPly(Number(li.getAttribute('data-ply')));
  });

  els.replayStart.addEventListener('click', function () { setPly(0); });
  els.replayPrev.addEventListener('click', function () { setPly(state.replay ? state.replay.ply - 1 : 0); });
  els.replayNext.addEventListener('click', function () { setPly(state.replay ? state.replay.ply + 1 : 0); });
  els.replayEnd.addEventListener('click', function () {
    if (state.replay) setPly(state.games[state.replay.index].moves.length);
  });
  els.replayClose.addEventListener('click', closeReplay);

  els.reviewGame.addEventListener('click', function () {
    if (isReplaying()) reviewGame(state.replay.index);
  });

  /* A move named in the verdict is a place to jump to. */
  els.reviewSummary.addEventListener('click', function (e) {
    var at = e.target.closest ? e.target.closest('[data-ply]') : null;
    if (at && isReplaying()) setPly(Number(at.getAttribute('data-ply')));
  });

  els.exportGame.addEventListener('click', function () {
    downloadJson(recordName(), liveRecord());
  });

  els.exportReplay.addEventListener('click', function () {
    if (!isReplaying()) return;
    var game = state.games[state.replay.index];
    if (game) downloadJson(recordName(game.at), savedRecord(game));
  });

  els.historyClear.addEventListener('click', function () {
    if (!clearArmed) { armClear(true); return; }
    armClear(false);
    clearHistory();
  });
  els.historyClear.addEventListener('mouseleave', function () { armClear(false); });
  els.historyClear.addEventListener('blur', function () { armClear(false); });

  els.rule.addEventListener('change', function () {
    wantedRule = els.rule.value;
    newGame();
  });
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
  els.difficulty.addEventListener('change', function () {
    store(DIFFICULTY_KEY, els.difficulty.value);
    state.hint = -1;
    render();
  });

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (e.target.tagName === 'SELECT') return;
    if (isReplaying() && (k === 'arrowleft' || k === 'arrowright')) {
      e.preventDefault();
      setPly(state.replay.ply + (k === 'arrowright' ? 1 : -1));
      return;
    }
    if (k === 'n') { e.preventDefault(); newGame(); }
    else if (k === 'u') {
      e.preventDefault();
      // Shift+U has to be held too; key repeat is ignored while it counts down.
      if (e.shiftKey) startHold();
      else undo();
    } else if (k === 'h') { e.preventDefault(); toggleHint(); }
    else if (k === 'v') { e.preventDefault(); toggleValueMap(); }
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
  var VALUEMAP_KEY = 'gomoku.valuemap';
  var DIFFICULTY_KEY = 'gomoku.difficulty';
  var FOLD_KEY = 'gomoku.folds';
  var STOPERR_KEY = 'gomoku.stoponerror';
  var PACE_KEY = 'gomoku.pace';
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

  /* Each fold remembers whether it was left open. One key holds them all,
     as a list of the ones that are open. */
  function foldsOpen() {
    var open = [];
    if (els.engineFold.open) open.push('engine');
    if (els.keysFold.open) open.push('keys');
    return open.join(',');
  }

  [els.engineFold, els.keysFold].forEach(function (fold) {
    fold.addEventListener('toggle', function () { store(FOLD_KEY, foldsOpen()); });
  });

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

  if (SPECTATE) document.title = SPECTATE_TITLE;
  initTheme();
  state.evalBarOn = recall(EVALBAR_KEY) !== 'off';
  state.valueMapOn = recall(VALUEMAP_KEY) === 'on';
  if (DIFFICULTY[recall(DIFFICULTY_KEY)]) els.difficulty.value = recall(DIFFICULTY_KEY);
  state.stopOnError = recall(STOPERR_KEY) !== 'off';
  var folds = (recall(FOLD_KEY) || '').split(',');
  els.engineFold.open = folds.indexOf('engine') >= 0;
  els.keysFold.open = folds.indexOf('keys') >= 0;
  if (recall(PACE_KEY) !== null) els.demoPace.value = recall(PACE_KEY);
  state.games = loadGames();
  state.tab = recall(TAB_KEY) === 'history' ? 'history' : 'moves';
  state.panelOpen = recall(PANEL_KEY) !== 'closed';
  state.leftOpen = recall(LEFT_KEY) !== 'closed';
  applyPanelState();
  if (SPECTATE) {
    // Set for this window only: nothing here is stored, so the normal board
    // keeps its own settings.
    document.documentElement.classList.add('spectate');
    els.mode.value = 'coach';
    els.nbest.value = '0';
    state.hintOn = true;
    state.evalBarOn = false;
    state.valueMapOn = false;
  }
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
