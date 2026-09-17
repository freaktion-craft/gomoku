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
get-engine.cmd      Windows
./get-engine.sh     macOS and Linux
```

It downloads release 250615 from the Rapfi project and unpacks the build for
your platform, the NNUE weights and `config.toml` into `engine/`. Without it the
page still runs, but falls back to the small built-in engine.

## Running it

There is one launcher per platform and they take the same four words. Double-click
`windows_play.bat`, or run `./mac_play.sh`. Either one starts the bridge, waits for
the port to answer and opens the board as a tab in the Chrome you already have
open, falling back to your default browser if Chrome is not installed.

```
windows_play.bat            start the bridge and open the board in a Chrome tab
windows_play.bat stop       stop a running bridge
windows_play.bat rescan     forget the cached CPU build and probe again
windows_play.bat chrome     show which Chrome would be used, without opening it

./mac_play.sh               the same four, on macOS
```

The board is an ordinary tab in your own profile, with your extensions and
bookmarks, not a separate app window: Chrome hands a plain URL to the instance
that is already running rather than starting a second one, and on macOS the
launcher goes through `open -a` so it does. `./mac_play.sh chrome` prints which
Chrome that would be. Its Linux paths are there too, though Linux is not what
it is tested on.

Or run `node server.js` yourself and open <http://127.0.0.1:8787>. Use
`PORT=9000 node server.js` for a different port. The server binds to `127.0.0.1`
only, so nothing is exposed to the network.

`RAPFI_THREADS=N node server.js` sets how many search threads Rapfi uses, from 1
(the default) to 16. More threads search deeper, but they take CPU from
everything else running on the machine.

Rapfi 0.43.01 has a bug with two or more threads: after a rule change in the
same process it keeps searching with the first rule's network, so a renju game
after a freestyle one would use the freestyle net. The bridge works around it by
dropping to one thread and back before each `START`.
`node test/rule-switch.js` checks this. It starts the bridge with two threads on
port 8791, analyses a position under each rule in turn, and checks that the
right weight file loads every time.

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
windows_play.bat  launcher, Windows
mac_play.sh       launcher, macOS
engine/           Rapfi 0.43.01, from release 250615
```

`engine/` was extracted from `Rapfi-engine.7z` (35.1 MB) on the
[250615 release](https://github.com/dhbloo/rapfi/releases/tag/250615). That archive
carries five Windows builds, five Linux builds and one macOS build, plus the NNUE
weights (`mix9svq*.bin.lz4`), the classical weights (`model210901.bin`) and
`config.toml`. The fetch scripts take only the builds for the platform they run
on. Rapfi needs the weights and config beside the executable, so keep the folder
together.

## Instruction-set builds

On x86 Rapfi ships one binary per instruction set. `server.js` tries them
strongest first (AVX512VNNI, AVX512, AVXVNNI, AVX2, SSE), and a build the CPU
cannot run exits immediately, which is how the choice gets made. The winner is
cached in `engine/selected-build.json`; delete that file, or run the launcher's
`rescan`, to probe again after a hardware change.

On this machine (i7-13700K) the AVX-512 builds fail, as they should on
consumer Raptor Lake, and **avxvnni** is selected.

macOS is simpler: the release has a single `pbrain-rapfi-macos-apple-silicon`
binary, so there is nothing to probe and it is used as-is. It is arm64 only —
an Intel Mac has to build Rapfi from source or fall back to `local-engine.js`.

## Controls

| | |
|---|---|
| Opponent | which colour Rapfi plays, two-player hotseat, or tactics |
| Difficulty | how close to its best move the engine will settle for; see below |
| Rule | renju (the default), freestyle (five or more), or standard (exactly five) |
| Board | 19 × 19 (the default) or 15 × 15; changing it starts a new game |
| Score my options | rank the best placements for the side to move, with an evaluation on each |
| Tactics | the engine never plays a stone: you make every move for both sides and it scores each position as you go |
| Sparring | the engine plays itself, paced so you can follow, holding on every mistake |
| Hint | a switch: while it is on, the engine’s choice for the side to move is ringed, and it follows play |
| Value map | a switch: a dot on every empty point that is worth something, sized by how much |
| Theme | System, Light or Dark; the board follows the panel |
| Evaluation bar | the vertical gauge beside the board; switch it off in the engine section |
| History | the left panel’s second tab: every finished game, replayed on a numbered board |
| Review | in the History tab: the engine reads a finished game back and says what each move cost and what would have been better |
| Export JSON | writes the game out as a record: notation, engine coordinates, evaluation and grade per move |
| Hide | collapses a panel; a tab on that edge of the window brings it back |

`N` new game, `U` undo, `H` hint on or off, `V` value map on or off, `←` `→`
step through a replay. Undo
takes back both plies when playing the engine. Scored options are drawn on the board and listed in the panel, and
clicking one plays it.

**Undo all** wipes the whole game, so it is a press-and-hold rather than a
click: hold the button (or `Shift+U`) for a second and a half and it fills up
as it counts down. A plain click does nothing, and releasing early or dragging off
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

Both cards have a fixed width and height, so neither resizes as the wording
under it changes and nothing on the board shifts around. The sizes come from
measuring the tallest wording each card can hold: 80px for the current card at
300px wide and 65px for the previous one, each given a line of headroom. On a
narrower pane the note needs more lines, so there is a second pair of fixed
sizes rather than letting the cards resize themselves.

The previous card is deliberately quieter: smaller text, dimmed, and on the
page background rather than the panel white, so it sits behind the current
card. It disappears on the opening move, when there is nothing before it, and
the current card is right-anchored so it does not move when the other appears.
Below 860px wide only the current card is shown.

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

## History

Every game that reaches a result is kept, win or draw, and the left panel’s
**History** tab lists them newest first:

```
  ● Black wins                    Sep 10 01:39 PM
    31 moves · engine as White · freestyle
```

Pick one and it is replayed on the board with the moves numbered in the order
they were played — 1 Black, 2 White, 3 Black — so a finished game can be read
off the board at a glance rather than reconstructed from a list:

```
        ⑤
    ①  ③
  ②  ④
```

**Start**, **Back**, **Next** and **End** walk through it, `←` and `→` do the
same from the keyboard, and clicking any move in the log jumps straight to it.
The move being shown is ringed on the board and the moves still to come are
dimmed in the log. The valuations are stored with the game, so the grades, the
review line and the evaluation bar read as they did while it was played, and
the card above the board still names the shape each move made.

A replay takes the board over rather than drawing beside it. The game in
progress is put aside when a replay opens and handed straight back when it
closes, down to the grades and whose turn it is, so looking something up costs
nothing. **New game** ends a replay the same way. While one is open the board
is read-only and the engine is left alone.

Games live in the browser’s local storage, fifty of them, oldest dropped
first. Taking a move back and playing it again does not file the game twice.
**Clear history** wipes the list and asks once before it does.

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

Coordinates follow Gomocup notation: columns from `A` with `I` included (not Go
notation), rows from 1 at the bottom - `A` to `S` and 1 to 19 on the 19 × 19
board, `A` to `O` and 1 to 15 on the 15 × 15 one. They are drawn once each,
letters along the bottom edge and numbers down the right. This is what Rapfi
prints in its PV (checked at 19 × 19: the last column comes out as `S`), so the
move list and the engine output read the same way.

## Board size

**19 × 19 is the default**, because that is the board most games here are played
on: renju on a Go board. 15 × 15, the official renju board, is the other
choice. The size is remembered in this browser, and changing it starts a new
game. The marked points follow the board: the nine of a Go board on 19 × 19,
the five of a renju board on 15 × 15.

Rapfi itself is not tied to 15 × 15, but its neural networks are. The renju
networks shipped with the release only accept 15 × 15, so on 19 × 19 Rapfi prints
`Evaluator mix9svq disabled: no compatible weight config found` and plays on its
classical evaluator. Everything works; it is simply not as strong there as on
15 × 15 until a 19 × 19 renju network exists.

A saved game keeps the size it was played at, and a replay puts the board at
that size while it is open, handing the live game back at its own size when it
closes. Games saved before the size was a setting carry no size and are read as
15 × 15, which is what they all were.

The built-in engine behind Beginner and Casual reads shapes along each line, so
its perception tables mean the same thing on either board. Checked by replaying
the same positions on both sizes, offset to the middle of the 19 × 19 board:
the top four candidates matched in all but 43 of about 3,200 positions, and every
one of those had a stone near the edge of the 15 × 15 board, where the larger
board genuinely has more room. A move takes about a fifth longer on 19 × 19.

## Rules

Three rule sets, chosen in the Rule selector. **Renju is the default**, which
means a fresh page opens on the tournament rule with Black restricted.

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
to the built-in engine, which cannot work forbidden points out. Because it is
also the default, the page holds the choice while `api/status` is still in
flight and restores it the moment Rapfi answers - otherwise the brief spell on
the fallback engine at startup would silently drop every session to freestyle.

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

## Difficulty

The ladder is built two different ways, because one way does not reach the
bottom of it.

**Club and above are Rapfi**, handicapped by a `window`: how far below its own
best move, in Rapfi's eval units, the move it plays may be. Every level searches
at full strength for a real length of time; the window only decides which of
what it found it settles for.

| Difficulty | mechanism | think time |
|---|---|---|
| Beginner | perception table | 0.3 s |
| Casual | perception table | 0.3 s |
| Club | window 400 | 0.5 s |
| Strong | window 100 | 0.8 s |
| Full | window 0 — always the best move | 1.5 s |

### Why a window cannot make a beginner

It shuts exactly where the game is decided. When a four has to be blocked every
other reply is worse by thousands, so the block is the only move inside any
window and every level finds it. Measured, that made Beginner answer an open
three 20/20 and a live four 20/20 — identical to Full.

Nor does search depth, which is how chess engines do this. [Stockfish's Skill
Level](https://github.com/official-stockfish/Stockfish/commit/ef4822aa8d5945d490acca674eb1db8c3c38e9d5)
commits its move from the search at depth `1 + level`, then biases among MultiPV
candidates. That works in chess. It does not work here: measured, **Rapfi answers
an open three at `max_depth 1` exactly as it does at full depth**, because in
gomoku the shape is visible in the static evaluation without any search at all.

And randomly discarding the best move — which this did for a while — produces an
opponent that plays well and then twitches. The errors land anywhere, which is
not how a person is wrong. [KataGo's human-SL
docs](https://github.com/lightvector/KataGo/releases/tag/v1.15.0) put the general
version plainly: search with many visits and the engine "will still be stronger
because the search will probably solve a lot of tactics that players of a weaker
rank would not solve". The weakening has to be in what the player *sees*, not in
what is done to the answer afterwards.

### The perception table

Beginner and Casual are the bundled engine reading the board through a table of
what it takes each shape to be worth:

| shape | true | Beginner reads it as |
|---|---|---|
| five | 5,000,000 | unchanged |
| open four | 200,000 | ×0.05 |
| four | 20,000 | unchanged |
| open three | 8,000 | ×0.25 |
| closed three | 900 | ×0.40 |
| open two | 220 | ×0.60 |

The load-bearing entry is **open four**, which is not obvious. Blocking an open
three is worth what the opponent would gain by taking that point — and what they
gain is an open *four*. So underrating open fours is what stops a player
foreseeing that a three becomes one, which is precisely the beginner's blind
spot. A four is still answered, because that is measured against a five, and
`five` stays true for everyone: it is the one shape nobody fails to see.

Measured over 40 tries per level:

| | Beginner | Casual | Club and up |
|---|---|---|---|
| answers an open three | 0% | 48% | 100% |
| answers a live four | 100% | 100% | 100% |
| takes its own win in one | 100% | 100% | 100% |

The mistake is a property of the position rather than of a roll of the dice: the
same board draws the same error. Rapfi still reads every position even when it is
not choosing the move, so the grading, the review line and the evaluation bar
stay honest — the handicap is on who picks, never on what the coaching knows.

Without Rapfi the same tables run offline unchanged; only the Rapfi levels fall
back to plain search depth.

## Sparring

The engine playing itself, for watching rather than for playing. The obvious
version of this is useless: two copies at full strength trade a long balanced
game where nothing ever goes wrong, so there is nothing to see and no reason a
move was good. What teaches is a mistake and its answer, one after the other.

So a **Matchup** names a level for each side, and none of them is full against
full:

| Matchup | what you watch |
|---|---|
| Full vs Club | the stronger side punishes every slip - the clearest way to see why a move was bad |
| Club vs Club | both sides err, so it comes from either direction |
| Casual vs Casual | loose throughout, so the mistakes are easy to spot before they are answered |
| Difficulty setting, both sides | the escape hatch; it says so if you point it at Full vs Full |

**Pace** sets the gap between moves. **Stop on mistakes** holds the game the
moment a side plays a Mistake or a Blunder - and holds it *before* the answer is
played, so there is a moment to look at the position and work out the punishment
yourself. **Step** then plays the answer alone; **Play** carries on.

The grade for a move is only known once the next search comes back, so the stop
runs a move late by nature, which is exactly what is wanted here. The ply it
stopped on is remembered: the grade that caused the stop is still sitting there
afterwards, and without that memory carrying on would trip the same stop again
and the game could never be resumed past a mistake.

While a fixed matchup is set, the Difficulty dial has nothing to say and is
disabled, rather than sitting there looking as though it still applies.

## Game review

Open a finished game in the History tab and press **Review**. The engine reads
every position of the game back at full strength, the board walks through the
game as it goes, and when it is done there is a verdict above the replay log and
a line of commentary for whichever move is being shown:

> Move 6 G10 · Blunder · walked into a forced loss · J8 would have made an open
> three (J8 H11 H9 J10)

That is: what the move cost, the point that was better, what a stone there would
have made, and the line the engine expected to follow. Where a move threw away a
forced win the line says so. A point named anywhere in the verdict is a place to
jump to.

The grades from live play are a running commentary, snatched from a short search
in the gap before your next move, and they are noisy for the same reason. A
review re-reads each position with a longer search, and where it can it scores
the move you played from the *same* search that scored the best move, so the two
are comparable rather than two clocks stopped at different depths. The result
replaces the game's grades and is stored with it, so a review runs once and is
then stepped through; it goes into the JSON export too.

The verdict gives each side an **accuracy**, the counts of each grade, the
**turning point** and any **missed wins**. There is no standard for an accuracy
number, so here is what this one is: the mean, over a side's moves, of the win
chance each move kept. A move that dropped its player from 60% to 40% scores
0.8, a move that gave nothing away scores 1. Win chance is Rapfi's own logistic
of its evaluation, so the number does not depend on the eval units. The turning
point is the single largest drop in win chance, which is a different thing from
the worst grade: once a side is already at 4%, even a blunder cannot drop it
far, so the turning point tends to land on the move that first let the game go
rather than the one that finally lost it.

One thing the engine cannot tell you: Rapfi resolves a won position by force and
reports no value for it at all. The position before the winning move is exactly
that. The record proves what it was worth - a win in one for the side to move -
so the review fills it in, which is what lets the move that allowed it be graded.

## Exporting a game

**Export JSON** under the move list writes the game in progress. The same button
in the History tab writes whichever saved game is open below it, under that game's
own timestamp rather than the time you pressed it.

The record carries the notation a person reads and the engine coordinates a tool
wants, so it can go either way:

```json
{ "app": "rapfi-gomoku", "size": 19, "rule": "renju",
  "opponent": "ai-white", "difficulty": "full", "result": "unfinished",
  "moves": [
    { "n": 3, "player": "black", "coord": "J6", "x": 9, "y": 5,
      "eval": 62, "grade": "Inaccuracy", "best": "I8", "shape": "open two" }
  ] }
```

`size` is the board the game was played on, and the coordinates only mean
something together with it.

`coord` is always gomoku notation and `grade` is always the plain name: the file
is a record, not a screenshot.

## Value map

The **Value map** switch puts a dot on every empty point that is worth
something, sized by how much: what a stone there would build for the side to
move, plus what it would deny the other side. It answers a different question
from the scored options. Those rank moves; this shows the shape of the whole
position, so the eye lands on the part of the board where the game is being
decided before it worries about which point in it to take.

Both halves are read off `local-engine.js`'s pattern tables, the same ones that
order its search, so the map costs Rapfi nothing, redraws instantly and works
with no engine at all. It is a count of shapes rather than a search, so it does
not see a combination coming and can disagree with the engine's own choice. When
it does, the disagreement is worth looking at: usually the engine has read
something the shapes alone do not show.

Pattern values run from 4 for a lone stone to five million for a five in a row,
so a dot drawn in proportion to the raw number would leave everything but the
hottest point invisible. Each point is sized by its share of the best point on
the board, pulled together by a cube root: half the value is still four fifths
of the width, a hundredth of it a fifth. Points worth less than a sixth of the
top one are left off. So the dots compare with each other and not across
positions: the biggest dot is wherever the game is hottest right now, whether
that is a five waiting to be played or a quiet opening. In a sharp position only
a handful survive, which is itself the point being made.

## Layout

Three columns: the move list on the left at 252px, the board in the middle,
the controls on the right. The move list moved out of the right panel because that
panel was growing long enough to push the page around. The left panel has two
tabs, the moves of the game in progress and the history of finished ones, so
the second list costs no width.

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

The board takes a share of the room it could have rather than filling it. The
room available is whichever runs out first, the board pane's width or the
window's height; `--board-fill` in `styles.css` is how much of that the board
takes, and at 0.75 a 1512x777 window gives a 547px board. That one number is
what to change to make the board bigger or smaller.

It is then clamped at both ends: never past `--board-max` (990px), and never
below 300px, where the pane scrolls instead. One custom property drives both the
board and the evaluation bar beside it, so they always match.

The panel keeps its full width, and under 760px wide it moves below the board.
Past the floor the page scrolls rather than squeezing everything into nothing,
so dragging the window around cannot leave it in an unusable state.

## Spectator window

`spectate.bat` opens the board on its own in a small Chrome app window that
stays on top of other windows, for following a game being played somewhere
else. It starts the bridge in a minimised window if it is not already running,
then loads `index.html?spectate`: tactics mode, hint on, no panels, no
coaching cards and no evaluation bar, with the board filling the window however
small it is dragged. Nothing it sets is stored, so the normal board keeps its
own settings. Place the stones for both sides as they are played; U undoes,
N starts a new game and H turns the hint off and on.

A strip down the right edge picks your side. **Both** is the tactics mode
above. **Black** or **White** hands the other colour to the engine, which moves
at once if it is already its turn. Switching does not clear the board, so it can
change partway through a game. **Undo** below them does what U does. Against
the engine it takes back its reply as well, so it is your turn again.

The board can also be played by right-dragging, and this works the same
whether or not the window has the focus, so there is no need to click away
from the game you are watching. Hold the right button over the board and a red
cross appears under the pointer, snapping to the nearest point. Let go over the
board and a stone is played there. Let go off the board and nothing is played.
A right press that does not start over the board is left alone, so right clicks
in the other program are unaffected. That program still receives the drag as
well.

The page cannot see the mouse while another program has the focus, so the
watcher registers a hidden window for raw mouse input, which still arrives in
the background. On each button change, and about every 20ms while the button is
held, it posts the pointer's screen position in physical pixels to
`/api/cursor`. The bridge relays that to the page on its event stream, and the
page converts it to its own coordinates. To do that, the page learns where its
viewport sits on screen from the first real mouse event over the window, and
estimates it from the window frame until then. When the window itself has the
focus, the page takes the drag straight from its own mouse events and ignores
the relayed copy, which arrives a moment later. Games that lock and hide the
pointer while the camera turns leave it in one place, so the cross stays put
too.

The window runs under its own Chrome profile in
`%LocalAppData%\RapfiGomoku\spectator`, so it is a separate process from your
own browser. Chrome has no always-on-top switch, so a hidden PowerShell watcher
at the end of the batch file sets the flag through `SetWindowPos`. Chrome only
keeps that flag when its window has focus as it is set, so the watcher brings
the window forward once and pins it again whenever it has focus and has lost the
flag. The watcher quits when the window closes. A game running in exclusive
fullscreen still covers it; borderless windowed does not.

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
