// Barrel for the pure real-time game logic the rt-move Edge Function depends on
// (task 15.1).
//
// The authoritative decisions are NOT reimplemented server-side: this module
// simply re-exports the shared, property-tested `@ldr/core` logic so the Edge
// Function is thin I/O around it:
//
//   * `applyMove` — the pure move engine (Req 6.4, 6.11). A valid move yields a
//     brand-new state; an invalid one yields `Err(INVALID_MOVE)` with the input
//     state untouched, which is exactly what the function persists / refuses to
//     persist.
//   * `joinSession` — the `pending -> active` transition inside the 60s join
//     window, seeding one identical initial state for both partners (Req 6.3).
//   * `requirePairing` — the shared guard rejecting a session start by an
//     unpaired account (Req 6.5).
//   * `listRulesets` / `getRuleset` — the real-time game catalog (Req 6.1) and
//     per-game terminal/outcome derivation (Req 6.8).
//
// Importing `@ldr/core/rt-tic-tac-toe` for its side effect is what populates the
// ruleset registry: each concrete game self-registers on import, so the engine
// can dispatch on a state's `game` discriminator. Additional real-time games are
// enabled server-side by adding their import here.
import "@ldr/core/rt-tic-tac-toe";

export { applyMove, getRuleset, listRulesets } from "@ldr/core/rt-engine";

export { joinSession } from "@ldr/core/rt-session";

export { requirePairing } from "@ldr/core/pairing-logic";

// Branded-id casting helpers (pure casts) used to hand raw uuids/text from
// Postgres to the branded domain signatures.
export {
  accountId,
  gameId,
  pairingId,
  sessionId,
} from "@ldr/core/common";
