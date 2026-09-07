// Shared Supabase client helpers for Edge Functions.
//
// Infrastructure scaffolding (not domain logic). Two client flavors are used by
// server-authoritative functions:
//
//   * a **service-role** client (BYPASSRLS) for the authoritative writes and
//     transactional RPCs that only Edge Functions are allowed to perform, and
//   * a short-lived **caller-scoped** client that carries the request's
//     Authorization header so `auth.getUser()` resolves the authenticated
//     account behind the verified JWT.
//
// See design.md "Key Design Decisions" (Edge Functions run with the service
// role and are the only path allowed to perform sensitive writes).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Supabase project URL, injected into the edge runtime. */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
/** Anon key, used only to construct the caller-scoped client. */
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
/** Service-role key (BYPASSRLS) for authoritative writes. */
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

/**
 * A service-role client. Never persists a session and never auto-refreshes; it
 * is created per request and used only for the function's authoritative work.
 */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolves the authenticated account id from the request's `Authorization`
 * header. Returns `null` when the header is missing or the token does not
 * resolve to a user, so callers can respond with `UNAUTHENTICATED`.
 */
export async function authenticatedAccountId(
  req: Request,
): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const scoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await scoped.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

/** Read the already-verified JWT's integer application-session epoch claim. */
export function tokenEpoch(req: Request): number | null {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const encodedPayload = token?.split(".")[1];
  if (!encodedPayload) return null;

  try {
    const normalized = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const nested = payload.app_metadata;
    const raw = payload.epoch ?? (
      nested && typeof nested === "object"
        ? (nested as Record<string, unknown>).epoch
        : undefined
    );
    return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
  } catch {
    return null;
  }
}
