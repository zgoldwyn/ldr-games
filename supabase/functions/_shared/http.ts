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
      return 404;
    case "INVITATION_EXPIRED":
      return 410;
    case "ALREADY_PAIRED":
    case "INVITATION_ALREADY_CONSUMED":
    case "NOT_PAIRED":
      return 409;
    case "MISSING_REQUIRED_FIELD":
      return 400;
    default:
      return 400;
  }
}
