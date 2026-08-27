// Admin-client + request auth-context surface for the session-lifecycle Edge
// Functions (task 12.3).
//
// The sign-out (Req 2.4, 2.5) and activity/inactivity (Req 2.5, 2.6) functions
// need two things: a service-role client to perform the authoritative writes
// (epoch bump, token revoke, `last_activity_at` update) that bypass RLS, and a
// way to resolve the caller's account id from their bearer token. Rather than
// introduce a third client convention, this module re-exports the existing
// factories/helpers under the names those functions expect, keeping a single
// source of truth for client construction (`clients.ts`) and token parsing
// (`auth-context.ts`).
export {
  authenticatedAccountId,
  bearerToken,
} from "./auth-context.ts";

// The service-role client (BYPASSRLS) is the "admin" client these functions use
// for their authoritative session-registry writes.
export { createServiceClient as createAdminClient } from "./clients.ts";
