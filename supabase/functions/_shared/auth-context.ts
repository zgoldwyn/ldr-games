// Request auth-context helpers for Edge Functions.
//
// Infrastructure scaffolding (not domain logic). Extracts the caller's bearer
// token and resolves the authenticated account id from it. Functions guarded by
// `verify_jwt = true` already reject unsigned/expired tokens at the edge; these
// helpers additionally surface the account id (= `auth.users.id`) that owns the
// request, and let a function fail closed (deny + route to sign-in, Req 2.5)
// when no valid session is present.
import { type SupabaseClient } from "@supabase/supabase-js";

/** Extract the raw bearer token from an `Authorization` header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Resolve the authenticated account id from the request's bearer token, or null
 * when the token is missing or invalid. Callers translate a null into a 401 so
 * a request without a valid session is denied access (Req 2.5).
 */
export async function authenticatedAccountId(
  client: SupabaseClient,
  req: Request,
): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}
