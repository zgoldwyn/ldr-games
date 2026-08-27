// Sign-out Edge Function (Req 2.4, 2.5).
//
// Terminates the Authenticated_Session for the calling client: it bumps the
// account's session epoch (making the presented token stale under the epoch
// guard) and revokes the underlying Supabase tokens. After this the account has
// no valid session, so shared features are denied and the client routes to
// sign-in (Req 2.5). The termination path is well under the 3-second budget of
// Req 2.4 — it is a single indexed row update plus a best-effort token revoke.
//
// Setup type definitions for built-in Supabase Runtime APIs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  authenticatedAccountId,
  bearerToken,
  createAdminClient,
} from "../_shared/supabase-admin.ts";
import { terminateSession } from "../_shared/auth-store.ts";

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
    // No valid session to terminate — deny and direct to sign-in (Req 2.5).
    return json({ error: "no_active_session" }, 401);
  }

  try {
    await terminateSession(admin, accountId, Date.now(), bearerToken(req));
  } catch {
    return json({ error: "sign_out_failed" }, 500);
  }

  return json({ status: "signed_out" }, 200);
});

/* To invoke locally once the stack is running:

  curl -i --location --request POST \
    'http://127.0.0.1:54321/functions/v1/auth-signout' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>'
*/
