// Shared Supabase client factories for Edge Functions.
//
// Infrastructure scaffolding (not domain logic). Server-authoritative functions
// use one of two clients:
//
//   * the ANON client to exercise the same public Auth surface a real client
//     would (e.g. `signInWithPassword`), so credential verification and the
//     access-token hook behave exactly as in production; and
//   * the SERVICE-ROLE client for privileged writes / RPCs that must bypass RLS
//     (e.g. bumping the single-session epoch).
//
// The URL and keys are provided to every Edge Function by the Supabase runtime
// as environment variables, so no secrets are hard-coded here.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Reads a required environment variable or throws a clear configuration error. */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The Supabase project URL injected into the edge runtime. */
export function supabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

/**
 * A client bound to the public `anon` key with session persistence disabled
 * (Edge Functions are stateless). Use this to call the same Auth endpoints a
 * real client calls, such as `signInWithPassword` / `refreshSession`.
 */
export function createAnonClient(): SupabaseClient {
  return createClient(supabaseUrl(), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A client bound to the `service_role` key (BYPASSRLS). Use this only for
 * server-authoritative writes and RPCs. Never expose the returned client or its
 * key to a response.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(
    supabaseUrl(),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
