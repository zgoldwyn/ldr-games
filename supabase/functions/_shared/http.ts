// Shared HTTP helpers for Edge Functions.
//
// Infrastructure scaffolding (not domain logic): consistent JSON success/error
// responses with CORS headers, and a mapping from the shared `@ldr/core` error
// vocabulary (see packages/core/src/errors.ts) to HTTP status codes so every
// server-authoritative function reports failures uniformly to the mobile and
// desktop shells.

import { corsHeaders } from "./cors.ts";

/** JSON response with CORS headers applied. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Error response carrying the stable machine-readable `code` plus a
 * developer-facing `message` and optional structured `details`, matching the
 * `AppError` envelope used across the domain core.
 */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: { code, message, details } }, status);
}

/**
 * Maps a `@ldr/core` error code to the HTTP status the Edge Functions return.
 * Unknown codes fall back to 400 (client error) so a new domain code never
 * accidentally surfaces as a 200.
 */
export function statusForErrorCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
    case "SESSION_EXPIRED":
    case "SESSION_SUPERSEDED":
      return 401;
    case "INVITATION_NOT_FOUND":
    case "SESSION_NOT_FOUND":
    case "GAME_NOT_FOUND":
    case "QUIZ_NOT_FOUND":
    case "QUESTION_NOT_FOUND":
    // A sync change addressed to a shared row that does not exist (and whose
    // item type is created by its own flow, not the write path).
    case "ITEM_NOT_FOUND":
      return 404;
    // Sync write path (Req 5.2, 5.5, 5.6): the change is stamped by another
    // account, or targets a row outside the caller's pairing.
    case "ORIGIN_MISMATCH":
    case "PAIRING_SCOPE_VIOLATION":
      return 403;
    // A drained offline queue exceeded the per-request change limit (Req 5.5).
    case "BATCH_TOO_LARGE":
      return 413;
    case "INVITATION_EXPIRED":
    // The 60s join window (Req 6.9) and the 5-minute rejoin window (Req 6.10)
    // are gone-for-good deadlines, like an expired invitation.
    case "JOIN_WINDOW_EXPIRED":
    case "REJOIN_WINDOW_EXPIRED":
      return 410;
    case "ALREADY_PAIRED":
    case "INVITATION_ALREADY_CONSUMED":
    case "NOT_PAIRED":
    // A session start / move requires a pairing (Req 6.5, 7.9, 8.10) and an
    // action must match the session's current lifecycle state.
    case "PAIRING_REQUIRED":
    case "INVALID_SESSION_STATE":
    case "QUIZ_SESSION_IN_PROGRESS":
    case "WRONG_PHASE":
    // Only the Active_Turn_Holder may take the next turn; another partner's
    // attempt conflicts with the session's current ownership (Req 7.7).
    case "NOT_YOUR_TURN":
      return 409;
    // A rejected move or turn is a client error; the authoritative state is
    // unchanged (Req 6.11, 7.8).
    case "INVALID_MOVE":
    case "INVALID_TURN":
      return 400;
    case "MISSING_REQUIRED_FIELD":
      return 400;
    default:
      return 400;
  }
}
