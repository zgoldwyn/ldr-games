# Word games roadmap

## Product shape

Word games live behind the full-width **Word games** section on Play. The
section is a small library rather than a bottom tab, matching Card games and
leaving room for several different rhythms of play.

The first playable game is **Word Chain**, a competitive live two-player game
for linked partners. The opener must be 2–5 letters. Players then alternate
valid, unused English words that begin with the previous word's final letter
and grow by exactly one or two letters. The active player gives up when they
cannot continue, and their partner wins. The shared rules are pure TypeScript
so the mobile client and the authoritative Supabase real-time function make the
same decisions.

## Delivery stages

1. Ship the Word games library and a complete Word Chain session flow using the
   existing invite, join, move, broadcast, pause, rejoin, and delete lifecycle.
2. Play-test chain growth, concession timing, vocabulary feedback, and
   accessibility on two simulators/devices.
3. Keep the generated SCOWL-derived lexicon versioned with the ruleset. Word
   normalization and validation stay behind the domain API so clients always
   render the authoritative server decision.
4. Add a second mode with a different cadence (for example an asynchronous daily
   prompt or a cooperative timed word grid) instead of reskinning Word Chain.

## Architecture guardrails

- Keep rules deterministic and free of network or clock reads.
- The server remains authoritative; the client submits intents and renders the
  latest session state.
- Do not introduce a second live-game backend while the shared real-time session
  system already provides the required partner lifecycle.
- Word-game presentation helpers should be independently unit-tested so copy and
  status behavior do not leak into the rules engine.
- A future large dictionary should be versioned with the ruleset. Both clients
  must render the server's decision instead of relying on a device-local list.
