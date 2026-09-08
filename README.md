# Rapfi Gomoku

A browser board for [Rapfi](https://github.com/dhbloo/rapfi), dhbloo's open-source
NNUE gomoku engine. Rapfi is a native program that speaks the Piskvork/Gomocup
protocol over stdin/stdout, so a small Node bridge sits between the page and the
engine process.

## Getting the engine

The Rapfi binaries are not in this repository. They are a 51 MB third-party
release under GPL-3.0, so the project fetches them instead of redistributing
them. Run this once after cloning:

```
get-engine.cmd
```

It downloads release 250615 from the Rapfi project and unpacks the Windows
builds, the NNUE weights and `config.toml` into `engine/`. Without it the page
still runs, but falls back to the small built-in engine.

## Running it

Double-click `play.bat`. It starts the bridge, waits for the port to answer and
opens the board in Chrome as an app window (no tab strip or address bar), falling
back to your default browser if Chrome is not installed.

```
play.bat            start the bridge and open the board in Chrome
play.bat stop       stop a running bridge
play.bat rescan     forget the cached CPU build and probe again
play.bat chrome     show which Chrome would be used, without opening it
```

Or run `node server.js` yourself and open <http://127.0.0.1:8787>. Use
`PORT=9000 node server.js` for a different port. The server binds to `127.0.0.1`
only, so nothing is exposed to the network.

Opening `index.html` directly as a file also works, but with no bridge there is
no Rapfi: the page falls back to the small JavaScript engine in
`local-engine.js`, which is far weaker.

## What is here

```
index.html        board page
styles.css
app.js            canvas rendering, input, game flow
local-engine.js   fallback engine used when the bridge is not running
server.js         static server + Piskvork protocol bridge to Rapfi
play.bat          launcher
engine/           Rapfi 0.43.01, from release 250615
```

`engine/` was extracted from `Rapfi-engine.7z` (35.1 MB) on the
[250615 release](https://github.com/dhbloo/rapfi/releases/tag/250615). It holds the
five Windows builds, the NNUE weights (`mix9svq*.bin.lz4`), the classical weights
(`model210901.bin`) and `config.toml`. Rapfi needs the weights and config beside
the executable, so keep the folder together.

## Instruction-set builds

Rapfi ships one binary per instruction set. `server.js` tries them strongest
first (AVX512VNNI, AVX512, AVXVNNI, AVX2, SSE), and a build the CPU cannot run
exits immediately, which is how the choice gets made. The winner is cached in
`engine/selected-build.json`; delete that file to probe again after a hardware
change.

On this machine (i7-13700K) the AVX-512 builds fail, as they should on
consumer Raptor Lake, and **avxvnni** is selected.

## Controls

| | |
|---|---|
| Opponent | which colour Rapfi plays, two-player hotseat, or tactics |
| Strength | Rapfi's `INFO strength`, 0-100 |
| Think time | per-move limit, `INFO timeout_turn` |
| Rule | freestyle (five or more), standard (exactly five), or renju |
| Score my options | rank the best placements for the side to move, with an evaluation on each |
| Tactics | the engine never plays a stone: you make every move for both sides and it scores each position as you go |
| Hint | a switch: while it is on, the engine’s choice for the side to move is ringed, and it follows play |
| Theme | System, Light or Dark; the board follows the panel |
| Evaluation bar | the vertical gauge beside the board; switch it off in the engine section |
| Hide | collapses a panel; a tab on that edge of the window brings it back |

`N` new game, `U` undo, `H` hint on or off. Undo takes back both plies when playing the
engine. Scored options are drawn on the board and listed in the panel, and
clicking one plays it.

**Undo all** wipes the whole game, so it is a press-and-hold rather than a
click: hold the button (or `Shift+U`) for three seconds and it fills up as it
counts down. A plain click does nothing, and releasing early or dragging off
the button abandons it. It clears the board without touching your settings, and
lets the engine re-open if it has Black.

The engine panel shows depth, evaluation, node count and the principal
variation, streamed live over server-sent events while Rapfi searches.

## Learning the game

Gomoku has no settled opening, middle game and endgame the way chess does.
Games are short and there is no material, so the vocabulary is about threats
instead, and that is what the board teaches.

Two small cards sit in the top right corner of the board section, inset to line
up with the pane’s own padding. The right one names what the move just played
made; the left one is a separate card holding the move before it, so you can
see what the reply answered:

```
  Previous          Attack
  W A15             B H8
  quiet move        four-three
                    a fork: the four must be answered,
                    then the three wins
```

The previous card is dimmed and disappears on the opening move, when there is
nothing before it. The current card stays put either way, so it does not jump
when the other one appears. Below 520px wide only the current card is shown.

The terms are the real ones. A **four** has one point that would complete
five, so it forces a reply. An **open four** has two such points and cannot be
blocked at all. An **open three** becomes an open four if left alone, so it has
to be answered. A **fork** is one move making two threats at once, which wins
because only one can be answered: **four-three**, **double four** and **double
three** are the usual kinds. An **overline** is six or more in a row. Chaining
forcing moves into a win is called **VCF** when it uses only fours and **VCT**
when it uses threes as well.

The full list is in the glossary at the bottom of the panel.

Each shape is worked out by asking what one more stone could do, which is how
the terms are defined in the first place: count the points that would complete
five (two means an open four, one means a four), and if there are none, ask
whether one more stone would create an open four (an open three) or a plain
four (a closed three). It runs locally, so it still works with the bridge off.

The phase word on the card is descriptive rather than canonical: opening for
the first few stones, attack once the last move made a three or better, and
middle game otherwise.

## Tactics mode and the move log

Pick **Tactics** as the opponent and the engine stops playing. You place every
stone yourself, for both colours, and after each one Rapfi scores the position
and paints the options for whoever is to move. Option scoring switches itself
on in this mode even if the list is set to Off.

Every move gets a valuation in the move log:

```
 1  B  H8
 2  W  J6      -619   Good
 3  B  I8      +533   Best
 4  W  B2      -M21   Blunder
 5  B  G8      +M14   Best
```

The number is what the position is worth to the player who just moved, so a
positive number means the move left them better off. The grade is how much
worse the move was than the engine’s own choice, and the review line under
the options spells the last one out: how much it gave up, and what the engine
preferred instead.

Grading compares the value the engine saw before a move with the value it sees
after, both from the point of view of the side to move at the time, so the loss
to the mover is just the sum of the two. The thresholds come from measuring
real play rather than guesswork: replaying the engine’s own choice still shows
a loss near 100, because the two searches stop at different depths; the
tenth-best move in a balanced position costs about 430; a wasted move in the
corner about 1200. Best is under 150, then Good, Inaccuracy, Mistake, and
Blunder past 1000.

The first move of a game is not graded, because an empty board gives the engine
nothing to evaluate against. Tactics mode needs the bridge running, since the
fallback engine cannot produce these numbers.

The theme switch sits next to the title. System follows the operating system
setting; Light and Dark override it and are remembered in this browser. The
board is drawn from the same CSS variables as the panel, so the grid, stones
and markers all move with the theme rather than needing a second palette.

Coordinates follow Gomocup notation: columns `A` to `O` with `I` included (not Go
notation), rows 1 to 15 from the bottom. This is what Rapfi prints in its PV, so the
move list and the engine output read the same way.

## Rules

Three rule sets, chosen in the Rule selector.

**Freestyle** is plain gomoku: five or more in a row wins, for either side.

**Standard** requires exactly five from both players, so an overline of six or
more is not a win.

**Renju** is the tournament rule, and it restricts Black only. Black may not
play a double three, a double four, or an overline; White has no restrictions
at all and wins with five or more. Black must make exactly five.

Renju forbidden points are marked on the board with a cross, and Black simply
cannot place there: the click is refused and the status line names the rule
that was broken, for instance `H8 is forbidden for Black: double three`. White
can play those same points freely.

The forbidden points come from the engine rather than from logic written here.
A renju three only counts if the move completing it into an open four is itself
legal for Black, so the definition is recursive and easy to get subtly wrong.
Rapfi already implements it, and its Yixin extension exposes the answer:
`YXSHOWFORBID` returns the points as concatenated four-digit `xxyy` groups. It
reports Black's forbidden points whoever is to move, so the page applies them
on Black's turn only.

One consequence worth knowing: a move that completes five is never forbidden,
even when it would otherwise be a double three or a double four. Verified: a
black four in a row reports no forbidden point at its fifth, while adding a
stone that would make six does report one.

Renju needs the bridge running. The option is disabled when the page falls back
to the built-in engine, which cannot work forbidden points out.

## Evaluation bar

A vertical gauge stands to the left of the board. White fills from the bottom,
Black holds the rest, a dashed line marks even, and each side keeps its
percentage at its own end. Switch it off with the button in the engine section
of the panel; the choice is remembered.

The percentages are not invented. Rapfi converts a score to a win rate with

```
winRate = 1 / (1 + exp(-eval / ScalingFactor))
```

from `Rapfi/eval/scoretables.h`, where `ScalingFactor` defaults to 200 in
`Rapfi/config.cpp`. Mate scores clamp to a certainty. So an eval of 200 reads as
73%, 615 as 96%, and a found mate pins the bar. Note that the guide shipped
with the engine says the scaling factor is 2.0; the source sets 200.0, and the
`config.toml` here does not override it.

Scores come back from the point of view of the side to move, so the bar flips
them into White’s share before drawing. Gomoku evaluations saturate quickly,
so expect the gauge to swing hard once someone gets a real threat: that is the
engine being decisive, not the bar being broken. An empty board leaves it
blank, because Rapfi returns no evaluation before the first stone.

## Layout

Three columns: the move list on the left at 252px, the board in the middle,
the controls on the right. The move list moved out of the right panel because that
panel was growing long enough to push the page around.

The app is pinned to the viewport height, so each panel scrolls inside itself
and the page as a whole never scrolls. Two things were needed for that: the
flex children need `min-height: 0` before they will shrink below their
content, and the panel sections need `flex-shrink: 0` or they squash to fit
instead of letting the panel scroll. Without the second one the right panel
silently compressed its own contents.

## Collapsing the panels

Either panel folds away. Hide next to the theme selector collapses the right
panel; Hide above the move list collapses the left one. A vertical tab appears
on that edge of the window to bring it back, and both states are remembered
between sessions. The coaching card shifts left while the right panel is
collapsed so the tab never covers it.

## Window size

The board is clamped at both ends rather than tracking the window without
limit. It never grows past `--board-max`, which is 990px in `styles.css` and is the
one value to change if you want it bigger or smaller, and it never shrinks
below 300px, where the pane scrolls instead. One custom property drives both
the board and the evaluation bar beside it, so they always match.

The panel keeps its full width, and under 760px wide it moves below the board.
Past the floor the page scrolls rather than squeezing everything into nothing,
so dragging the window around cannot leave it in an unusable state.

A side effect of the ceiling: on a large window there is now real clearance
around the board, so the coaching card in the corner of the pane no longer
sits over it.

## Licensing

Rapfi is by dhbloo and is licensed GPL-3.0. It is not included here; 
get-engine.cmd downloads it from the project’s own releases.

The code in this repository talks to Rapfi as a separate process over its
stdin and stdout using the published Piskvork protocol. It does not link
against it or include any of its code.

## Protocol notes

The bridge keeps one engine process alive so the transposition table survives
between moves, and sends the whole position as a `BOARD … DONE` block for every
move rather than incremental `TURN` commands, so the page stays authoritative and
the two can never drift apart. Move requests are serialised, since the protocol
is a single request/response stream.

Scored options use the Yixin extension: `YXBOARD ... DONE` sets the position
without asking for a move, then `YXNBEST n` runs a multi-PV search reporting each
candidate as `MESSAGE (rank) <eval> | <depth> | <pv>` before printing its own
best move.

Two things about that output matter. The rank order lags the scores when the
clock stops mid-iteration, so the list is re-sorted by score in the UI - given
enough think time the top of that order is the move the engine itself returns.
And a forced position (an open four to block, say) comes back with a move but no
ranked list at all, which shows as a single `forced` entry.

Scores are from the point of view of the side to move, so a bigger number is
better for whoever is about to play. Mates read as `M12`.

Endpoints: `GET /api/status`, `POST /api/move`, `POST /api/analyze`,
`POST /api/forbidden`, `POST /api/newgame`, `GET /api/events` (SSE).
