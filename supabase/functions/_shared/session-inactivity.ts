// Session inactivity evaluator for the auth Edge Functions (Requirement 2.6).
//
// Deno-compatible port of the pure inactivity helper that lives in the shared
// core package at `packages/core/src/domain/session-epoch.ts`
// (`isWithinInactivityWindow` / `INACTIVITY_LIMIT_MS`). It is kept equivalent to
// that source of truth so the property-tested rule (Property 9, task 3.8) and
// this server-side enforcement never disagree.
//
// Why a port rather than an import: the `@ldr/core` package ships as an
// ESM/Node build the Deno edge runtime cannot resolve directly (see
// `auth-validation.ts`). The evaluator is pure and dependency-free, so porting
// keeps the edge bundle self-contained. If the core policy changes, update both
// files together.

/** Epoch milliseconds (mirrors `@ldr/core` `Timestamp`). */
export type Timestamp = number;

/** The inactivity limit after which a session expires (30 days). */
export const INACTIVITY_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a session is still within the inactivity window: valid iff the delta
 * between `now` and the last activity time is strictly less than 30 days
 * (Req 2.6).
 */
export function isWithinInactivityWindow(
  lastActivityAt: Timestamp,
  now: Timestamp,
): boolean {
  return now - lastActivityAt < INACTIVITY_LIMIT_MS;
}
