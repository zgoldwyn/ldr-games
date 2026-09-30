# Draw Together — Product and Technical Specification

**Status:** Approved for implementation
**Game id:** `draw-together`
**Mode:** Two-player, real-time, fully cooperative

## Product goal

Draw Together is a fast cooperative drawing-and-guessing game for an active
pairing. The couple shares one score and tries to beat its previous best for the
selected match duration. There is no individual winner, individual score, or
negative score.

The old asynchronous drawing-gallery ruleset remains available to historical
data but is not exposed by the mobile game library. Draw Together is a separate
real-time game because live strokes, guesses, clocks, and role handoffs require
both partners to be present.

## Match setup

- The inviter chooses a 3-, 5-, or 10-minute match. Five minutes is the default.
- Both partners must join the real-time session before play begins.
- The inviter draws first. Drawer and guesser alternate after every attempted
  word.
- A match-level deadline is issued by the server. Clients render the countdown
  locally from that deadline; they do not write a database row every second.
- Best scores are stored separately for each duration.

## Turn flow

1. The drawer receives three private choices: one easy, one medium, and one
   hard word.
2. The drawer has 8 seconds to choose. If no choice arrives, the medium word is
   selected automatically.
3. Only the drawer receives the selected word. It must never appear in shared
   session state, a shared Broadcast payload, logs, or the guesser's client.
4. The drawing phase lasts at most 60 seconds and never extends beyond the
   match deadline.
5. The drawer draws while the guesser submits text guesses. Guess comparison is
   case-insensitive and ignores surrounding whitespace, punctuation, and simple
   singular/plural differences.
6. A correct guess immediately awards shared points and ends the turn. A turn
   timeout awards zero points. Either result switches roles after a short reveal.
7. When the match deadline expires, the active word counts as unsolved and the
   game ends immediately.

Words offered but never selected do not count as attempted or unsolved. A word
selected before drawing begins does count as attempted.

## Scoring

Every correct answer earns a single shared score:

```text
(100 base points + 0–100 whole speed points) × difficulty multiplier
```

- Speed points are the floor of `100 × remaining turn time / 60 seconds`.
- Easy multiplier: `1.0`
- Medium multiplier: `1.25`
- Hard multiplier: `1.5`
- The final result is rounded to the nearest whole point.
- A timeout or match-expiry miss earns zero. Lost time is the penalty; the game
  never subtracts points.

The primary performance measure is shared score. The result also reports words
solved so couples can understand whether a score came from speed, difficulty,
or volume.

## End screen

The result screen presents:

- shared score;
- words solved;
- previous best and new-best state for the selected duration;
- fastest correct guess;
- hardest successful word;
- longest solved streak; and
- **Words We Missed**, containing every selected word that was not solved.

Each missed-word entry includes the word, drawer, difficulty, time spent, and
the final drawing thumbnail when one is available. The active word at match
expiry is included. Offered-but-unselected words are excluded.

## Realtime drawing transport

- The drawing canvas updates locally on the UI thread without waiting for the
  network.
- Points are normalized to the canvas bounds and batched for Broadcast roughly
  every 30–50 ms. The receiver interpolates adjacent points.
- Broadcast is the live path; Postgres is not written for every point.
- A compact recovery snapshot is produced after each completed stroke and at a
  low fixed cadence while drawing. A reconnecting guesser requests the latest
  snapshot after subscribing.
- Stroke payloads carry a monotonically increasing sequence number. Receivers
  ignore duplicates and request a snapshot when a gap cannot be repaired.
- Completed-turn metadata and the final thumbnail are durable. Raw live stroke
  events are ephemeral and are not retained after their recovery window.

## Server authority and privacy

- The server selects the word choices from a versioned catalog and stores the
  active answer in a private table that clients cannot select through RLS.
- Word choices are delivered only to the drawer's account channel or returned
  directly to the drawer's authenticated request.
- Guesses are normalized and validated server-side. The server alone awards
  points, advances roles, records solved/missed words, and terminates the match.
- Public session state may contain timers, roles, score, counts, difficulty,
  masked word length, and result summaries, but never an active answer.
- The server uses its own receipt time for scoring. Client clocks are display
  aids and cannot award points.

## Accessibility and motion

- Drawing uses Gesture Handler and a UI-thread canvas implementation; it must
  not call React state setters per pointer update.
- Canvas controls have accessible names, minimum 44-point targets, and non-color
  indicators for the selected tool.
- The guesser receives an accessible textual description of connection, timer,
  and turn state. Live strokes themselves are decorative to screen readers.
- Timer and result changes use concise announcements. Reduced Motion removes
  nonessential transforms while preserving state changes.
- Haptics occur once for a correct guess, timeout, and committed tool change;
  they are never the only feedback.

## Initial release boundaries

- Pen with a small fixed palette, three stroke widths, undo-last-stroke, and
  clear-canvas are included.
- Eraser, fill, shapes, chat, custom words, public rooms, and drawing replay are
  deferred.
- One shared pre-selection reroll may be added later. It is not part of the
  initial rules because the word catalog must first prove that it needs one.

## Acceptance criteria

- The same server-issued deadline yields equivalent remaining time on both
  devices within normal network delay.
- The guesser sees live drawing without database-per-point writes.
- The active answer is absent from all guesser-readable rows and payloads.
- Duplicate or late stroke batches do not corrupt the canvas.
- Correct guesses award the deterministic score defined above exactly once.
- A timeout and match expiry record a miss exactly once and award zero.
- Roles alternate after every attempted word.
- Results contain every selected-but-unsolved word, including the word active at
  match expiry, and exclude unselected choices.
- Best scores do not compare different duration modes.
