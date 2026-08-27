// Session activity + inactivity-expiry Edge Function (Req 2.5, 2.6).
//
// Clients call this on authenticated activity to keep their session alive. It
// enforces the 30-day inactivity window: if the session has been idle for 30
// consecutive days it is invalidated (its epoch is bumped and tokens revoked)
// and a 401 is returned so the user must sign in again (Req 2.6); otherwise
// `last_activity_at` is advanced to now and a 200 is returned. A request
// without a valid session is denied (Req 2.5).
//
// Setup type definitions for built-in Supabase Runtime APIs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  authenticatedAccountId,
  bearerToken,
  createAdminClient,
} from "../_shared/supabase-admin.ts";
import { enforceInactivity } from "../_shared/auth-store.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const admin = createAdminClient();
  const accountId = await authenticatedAccountId(admin, req);
  if (!accountId) {
    // No valid session — deny access and direct to sign-in (Req 2.5).
    return json({ error: "no_active_session" }, 401);
  }

  try {
    const result = await enforceInactivity(
      admin,
      accountId,
      Date.now(),
      bearerToken(req),
    );
    if (!result.valid) {
      // Expired after 30 days of inactivity — require a fresh sign-in (Req 2.6).
      return json({ error: "session_expired" }, 401);
    }
    return json({ status: "active", lastActivityAt: result.lastActivityAt }, 200);
  } catch {
    return json({ error: "activity_update_failed" }, 500);
  }
});

/* To invoke locally once the stack is running:

  curl -i --location --request POST \
    'http://127.0.0.1:54321/functions/v1/auth-activity' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>'
*/
