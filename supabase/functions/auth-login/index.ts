// Login Edge Function: single-session enforcement (the "login epoch hook").
//
// Server-authoritative sign-in for the LDR Companion App. On a successful
// credential check it enforces the single-active-session invariant (Req 2.7-2.9)
// end to end:
//
//   1. Verify the email/password via GoTrue `signInWithPassword` (bcrypt, Req
//      1.6). Any failure returns a UNIFORM, non-revealing error so a caller
//      cannot tell whether the email or the password was wrong (Req 2.2).
//   2. Atomically increment the account's `account_session.epoch` (service-role
//      RPC `bump_session_epoch`). The new epoch is what makes every previously
//      issued token stale (Req 2.7, 2.8).
//   3. Broadcast a `revoke` on the per-account Realtime channel `account:{id}`
//      so a still-connected prior client signs out within ~5s (Req 2.9).
//   4. Re-mint the token via `refreshSession` so the returned access token
//      carries the NEW epoch claim (embedded by the custom access-token hook,
//      migration 20260826062551). The epoch guard (app.session_epoch_ok, already
//      defined in migration 20260826062549) then denies any stale-epoch request.
//
// The epoch semantics mirror the pure helpers in
// packages/core/src/domain/session-epoch.ts (isEpochCurrent / evaluateSession):
// only the account's latest epoch is valid; lower epochs are superseded.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleCors } from "../_shared/cors.ts";
import { createAnonClient, createServiceClient } from "../_shared/clients.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import { broadcast } from "../_shared/realtime.ts";
import {
  readLockout,
  recordFailedAttempt,
  resetAuthAttempts,
} from "../_shared/auth-store.ts";

/** Stable error codes (subset of packages/core `errors.ts` AuthErrorCode). */
const AUTH_FAILED = "AUTH_FAILED";
const ACCOUNT_LOCKED = "ACCOUNT_LOCKED";
const MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD";

/** Uniform, non-revealing failure copy (Req 2.2). */
const AUTH_FAILED_MESSAGE = "Invalid email or password.";
/** Lockout copy — deliberately distinct from the uniform failure (Req 2.3). */
const ACCOUNT_LOCKED_MESSAGE =
  "This account is temporarily locked after too many failed sign-in attempts. Try again later.";

/**
 * Resolve an email to its account id via the service-role-only lookup RPC
 * (migration 20260826062552) so failures can be attributed to an account for
 * lockout recording (Req 2.3). Returns null for an unknown email or on error,
 * which the caller treats as an un-attributable attempt.
 */
async function accountIdForEmail(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<string | null> {
  const { data, error } = await service.rpc("account_id_for_email", {
    p_email: email,
  });
  if (error || typeof data !== "string") return null;
  return data;
}

/** Non-revealing lockout error carrying the expiry for client-side messaging. */
function lockedResponse(lockedUntil: number | null): Response {
  return errorResponse(ACCOUNT_LOCKED, ACCOUNT_LOCKED_MESSAGE, 429, {
    lockedUntil: lockedUntil === null ? null : new Date(lockedUntil).toISOString(),
  });
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
  /** Optional ClientInfo (platform/device) recorded on the session row. */
  client?: Record<string, unknown>;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(AUTH_FAILED, "Method not allowed.", 405);
  }

  // ---- Parse + validate input -------------------------------------------
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return errorResponse(MISSING_REQUIRED_FIELD, "Request body must be JSON.", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const missing: string[] = [];
  if (email.length === 0) missing.push("email");
  if (password.length === 0) missing.push("password");
  if (missing.length > 0) {
    return jsonResponse(
      {
        error: {
          code: MISSING_REQUIRED_FIELD,
          message: "Email and password are required.",
          details: { fields: missing },
        },
      },
      400,
    );
  }

  // ---- 1. Enforce lockout BEFORE verifying credentials (Req 2.3) ---------
  // Resolve the account so failures/locks can be attributed to it. An unknown
  // email yields null and simply skips lockout, still returning uniform errors.
  const service = createServiceClient();
  const now = Date.now();
  const accountId = await accountIdForEmail(service, email);

  if (accountId) {
    const lockout = await readLockout(service, accountId, now);
    if (lockout.locked) {
      // 5 consecutive failures within 15 minutes locked the account (Req 2.3).
      return lockedResponse(lockout.lockedUntil);
    }
  }

  // ---- 2. Verify credentials (uniform failure on any error, Req 2.2) -----
  const anon = createAnonClient();
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session || !signIn.data.user) {
    // Record the failure against the account and lock it once the policy is met
    // (Req 2.3). If this attempt tripped the lock, surface the locked error;
    // otherwise keep the uniform, non-revealing failure (Req 2.2).
    if (accountId) {
      const status = await recordFailedAttempt(service, accountId, now);
      if (status.locked) return lockedResponse(status.lockedUntil);
    }
    return errorResponse(AUTH_FAILED, AUTH_FAILED_MESSAGE, 401);
  }

  const userId = signIn.data.user.id;
  const refreshToken = signIn.data.session.refresh_token;

  // A successful sign-in clears the consecutive-failure streak and any lock
  // (Req 2.3 — failures must be *consecutive*).
  await resetAuthAttempts(service, userId, now);

  // ---- 3. Bump the single-session epoch (displaces prior tokens) ---------
  const bump = await service.rpc("bump_session_epoch", {
    uid: userId,
    p_client: body.client ?? {},
  });
  if (bump.error || typeof bump.data !== "number") {
    // The credentials were valid but we could not establish the single-session
    // invariant; fail closed rather than issue a token that would bypass it.
    return errorResponse(AUTH_FAILED, AUTH_FAILED_MESSAGE, 500);
  }
  const newEpoch = bump.data as number;

  // ---- 4. Displace the prior client via the per-account revoke signal ----
  // Best-effort: a missed signal is still covered by the epoch guard, which
  // rejects the now-stale token on its next request (Req 2.8, 2.9).
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    await broadcast(serviceRoleKey, [
      {
        topic: `account:${userId}`,
        event: "revoke",
        // Clients holding an epoch below this value must sign out locally.
        payload: { epoch: newEpoch, reason: "superseded" },
      },
    ]);
  } catch {
    // Swallow: the epoch guard is the source of truth for displacement.
  }

  // ---- 5. Re-mint so the returned token carries the NEW epoch claim ------
  const refreshed = await anon.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshed.error || !refreshed.data.session) {
    return errorResponse(AUTH_FAILED, AUTH_FAILED_MESSAGE, 500);
  }
  const session = refreshed.data.session;

  return jsonResponse({
    epoch: newEpoch,
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
    },
    user: { id: userId },
  });
});

/* To invoke locally once the stack is running:

  1. Run `npm run supabase:start` (wraps `supabase start`, requires Docker)
  2. Serve functions: `npm run supabase:functions`
  3. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/auth-login' \
    --header 'Content-Type: application/json' \
    --data '{ "email": "user@example.com", "password": "Sup3rSecret!!" }'
*/
