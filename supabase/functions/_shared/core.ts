// Barrel for the pure, property-tested auth evaluators the server-side store
// depends on (task 12.3).
//
// The lockout policy (Req 2.3) and the inactivity policy (Req 2.6) each live in
// their own Deno-compatible port that mirrors the shared `@ldr/core` source of
// truth (`auth-lockout.ts` / `session-inactivity.ts`). `auth-store.ts` imports
// them through this single module so the wiring code has one dependency surface
// and the two ports stay the authoritative decision logic. Both ports export a
// `Timestamp` alias; it is re-exported once here (from `auth-lockout.ts`) to
// avoid a duplicate-export collision.
export {
  type AuthAttemptEvent,
  computeLockout,
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  type LockoutStatus,
  type Timestamp,
} from "./auth-lockout.ts";

export {
  INACTIVITY_LIMIT_MS,
  isWithinInactivityWindow,
} from "./session-inactivity.ts";
