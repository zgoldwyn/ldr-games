// Registration Edge Function (Requirement 1).
//
// Server-authoritative account creation. This is the only path that creates an
// account, so credential policy is re-validated here even though the client
// validates first. The flow mirrors the design's "Authentication Module"
// mapping:
//
//   1. Reject empty/absent email or password, naming each missing field (1.5).
//   2. Reject a syntactically invalid email format (1.4).
//   3. Reject a password that violates the length/character-class policy,
//      describing each unmet criterion (1.3, and the policy side of 1.1).
//   4. Call Supabase Auth admin `createUser`, which enforces email uniqueness
//      (1.2) and stores only a bcrypt hash, never plaintext (1.6).
//   5. Place the new account in an unpaired state and return a success
//      confirmation. The handler does minimal work (pure validation + a single
//      admin call) so it comfortably returns within 5 seconds (1.1).
//
// The plaintext password is never logged, echoed, or returned (1.6).
//
// Setup type definitions for built-in Supabase Runtime APIs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "@supabase/supabase-js";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  validateEmailFormat,
  validatePasswordPolicy,
} from "../_shared/auth-validation.ts";
import {
  type RegistrationError,
  REGISTRATION_ERROR_CODES,
} from "../_shared/errors.ts";

/** Shape of the JSON request body this function accepts. */
interface RegisterRequest {
  email?: unknown;
  password?: unknown;
}

/** JSON helper: success response with an unpaired account (1.1). */
function jsonOk(accountId: string): Response {
  return new Response(
    JSON.stringify({ ok: true, data: { accountId, pairingId: null } }),
    {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

/** JSON helper: failure response carrying a stable error envelope. */
function jsonError(status: number, error: RegistrationError): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * JSON helper: 500 for server-side failures (misconfiguration or an
 * unexpected error while creating the account). The message is intentionally
 * generic so no configuration or internal detail leaks to the caller.
 */
function jsonInternalError(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Could not create the account.",
      },
    }),
    {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Browsers preflight cross-origin requests; short-circuit those.
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonError(405, {
      code: REGISTRATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
      message: "Registration requires a POST request with a JSON body.",
    });
  }

  // Parse the body defensively; malformed JSON is treated as missing fields.
  let body: RegisterRequest;
  try {
    body = (await req.json()) as RegisterRequest;
  } catch {
    return jsonError(400, {
      code: REGISTRATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
      message: "Request body must be valid JSON with 'email' and 'password'.",
      details: { fields: ["email", "password"] },
    });
  }

  const rawEmail = typeof body?.email === "string" ? body.email : "";
  const rawPassword = typeof body?.password === "string" ? body.password : "";

  // Email is trimmed (surrounding whitespace is never significant); the
  // password is used exactly as provided since whitespace can be a valid
  // password character.
  const email = rawEmail.trim();
  const password = rawPassword;

  // (1.5) Reject empty/absent required fields, identifying each one.
  const missingFields: string[] = [];
  if (email.length === 0) missingFields.push("email");
  if (password.length === 0) missingFields.push("password");
  if (missingFields.length > 0) {
    return jsonError(400, {
      code: REGISTRATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
      message: "Email and password are required.",
      details: { fields: missingFields },
    });
  }

  // (1.4) Reject a syntactically invalid email format.
  if (!validateEmailFormat(email)) {
    return jsonError(400, {
      code: REGISTRATION_ERROR_CODES.INVALID_EMAIL_FORMAT,
      message: "The email address format is invalid.",
    });
  }

  // (1.3 / policy side of 1.1) Reject a non-conforming password, describing each
  // unmet criterion so the caller can surface every failing rule.
  const passwordValidation = validatePasswordPolicy(password);
  if (!passwordValidation.valid) {
    return jsonError(400, {
      code: REGISTRATION_ERROR_CODES.INVALID_PASSWORD,
      message: "The password does not meet the required policy.",
      details: { unmetCriteria: passwordValidation.unmetCriteria },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    // Misconfiguration, not a client error: surface a 500 without leaking
    // configuration details.
    return jsonInternalError();
  }

  // Service-role client: the admin API bypasses RLS and is only ever used from
  // this trusted server context.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // (1.2 email uniqueness + 1.6 bcrypt hashing) are both enforced by Supabase
  // Auth. `email_confirm: true` provisions a usable account immediately; the
  // account starts unpaired (no pairing) per 1.1.
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { pairing_id: null },
  });

  if (error) {
    // Supabase reports a duplicate email as `email_exists` (HTTP 422). Map that
    // to the stable already-registered code (1.2); no account is created.
    const code = (error as { code?: string }).code;
    const status = (error as { status?: number }).status;
    const isDuplicate =
      code === "email_exists" ||
      status === 422 ||
      /already/i.test(error.message ?? "");

    if (isDuplicate) {
      return jsonError(409, {
        code: REGISTRATION_ERROR_CODES.EMAIL_ALREADY_REGISTERED,
        message: "That email address is already registered.",
      });
    }

    // Any other auth error is an unexpected server-side failure.
    return jsonInternalError();
  }

  const accountId = data.user?.id;
  if (!accountId) {
    return jsonInternalError();
  }

  // Create the application `accounts` row in an unpaired state (Req 1.1).
  //
  // Supabase Auth owns the credential record in `auth.users` (email uniqueness
  // + bcrypt). The `accounts` table is the application mirror, keyed 1:1 to
  // `auth.users.id`, and is the anchor every later feature depends on: the
  // single-session `account_session` row and `pairings` membership both carry
  // foreign keys to `accounts.id`, and RLS pairing-scope reads
  // `accounts.pairing_id`. No database trigger provisions this row, so the
  // registration function (the only account-creation path) does it here.
  //
  // `pairing_id` is left NULL, which is exactly the "unpaired state" the
  // account must start in (Req 1.1); the column defaults are handled by the
  // migration for `created_at`.
  const { error: accountRowError } = await supabase
    .from("accounts")
    .insert({ id: accountId, pairing_id: null });

  if (accountRowError) {
    // The credential exists but the application account row could not be
    // written. Roll back the auth user so we never leave an orphaned
    // credential with no `accounts` row (which would make the email
    // permanently unusable while appearing "already registered"). Best-effort:
    // if cleanup fails the guard is idempotent — the same email can be retried.
    try {
      await supabase.auth.admin.deleteUser(accountId);
    } catch {
      // Swallow: surface the original failure as a generic internal error.
    }
    return jsonInternalError();
  }

  // (1.1) Success: a new unpaired account. The password is never returned.
  return jsonOk(accountId);
});

/* To invoke locally once the stack is running:

  1. Run `npm run supabase:start` (wraps `supabase start`, requires Docker)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/register' \
    --header 'Content-Type: application/json' \
    --data '{ "email": "zoe@example.com", "password": "Sup3r!Secret42" }'
*/
