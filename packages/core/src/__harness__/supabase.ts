// Integration-test harness for the Supabase stack.
//
// This module provides the shared plumbing used by `*.integration.test.ts`
// suites that exercise the deployed RLS policies, Edge Functions, Realtime, and
// Storage against a running Supabase stack (`supabase start`) or an ephemeral
// project. It is intentionally NOT a test file (no `.test.ts` suffix) so it is
// compiled by `tsc --build` and gives the harness type coverage even in
// environments where the stack cannot run.
//
// Gating: integration suites call `getIntegrationConfig()` and skip themselves
// when the required environment variables are absent (see the smoke test in
// `harness.smoke.integration.test.ts`). This keeps the suite green in CI/dev
// machines without a local stack while still running end to end wherever a
// Supabase URL + keys are provided.
//
// Required environment variables (printed by `supabase status`):
//   SUPABASE_URL                (optional; defaults to the local API URL)
//   SUPABASE_ANON_KEY           (the `anon` publishable key)
//   SUPABASE_SERVICE_ROLE_KEY   (the `service_role` secret key; BYPASSRLS)

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Resolved connection details for the local/ephemeral Supabase stack. */
export interface IntegrationConfig {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

/** Default local API URL used when `SUPABASE_URL` is not provided. */
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:54321';

/**
 * Reads the Supabase connection details from the environment. Returns `null`
 * when the stack is not configured (missing anon or service-role key), which
 * integration suites use to skip themselves rather than fail.
 */
export function getIntegrationConfig(): IntegrationConfig | null {
  const url = process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL ?? DEFAULT_LOCAL_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_TEST_ANON_KEY;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

  if (!anonKey || !serviceRoleKey) {
    return null;
  }
  return { url, anonKey, serviceRoleKey };
}

/**
 * A `service_role` client. It has BYPASSRLS and is used only for test setup and
 * teardown (creating accounts, pairings, and seed rows) — never for the
 * assertions themselves, which run through RLS-scoped authenticated clients.
 */
export function createServiceClient(cfg: IntegrationConfig): SupabaseClient {
  return createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A fresh unauthenticated `anon` client (used to sign a test user in). */
export function createAnonClient(cfg: IntegrationConfig): SupabaseClient {
  return createClient(cfg.url, cfg.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A test account plus the credentials needed to sign it in. */
export interface TestAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Creates a confirmed auth user together with its application `accounts` row and
 * a single-session `account_session` registry row at epoch 0.
 *
 * The `app_metadata.epoch` claim is set to 0 so that a freshly signed-in token
 * carries an epoch matching `account_session.epoch`, satisfying the RLS epoch
 * guard (`app.session_epoch_ok`). This mirrors what the login Edge Function /
 * custom access-token hook will do once implemented (task 12.2); the harness
 * seeds it directly so pairing-scoped reads are reachable in the meantime.
 */
export async function createTestAccount(admin: SupabaseClient): Promise<TestAccount> {
  const email = `rls-${randomUUID()}@example.test`;
  const password = `Aa1!${randomUUID()}`;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { epoch: 0 },
  });
  if (error || !data.user) {
    throw new Error(`createUser failed: ${error?.message ?? 'no user returned'}`);
  }
  const id = data.user.id;

  const { error: accErr } = await admin.from('accounts').insert({ id });
  if (accErr) {
    throw new Error(`accounts insert failed: ${accErr.message}`);
  }

  const { error: sesErr } = await admin
    .from('account_session')
    .insert({ account_id: id, epoch: 0 });
  if (sesErr) {
    throw new Error(`account_session insert failed: ${sesErr.message}`);
  }

  return { id, email, password };
}

/**
 * Signs a test account in on a fresh anon client and returns the authenticated,
 * RLS-scoped client. The returned client's requests run as the `authenticated`
 * role with the account's JWT (including the `app_metadata.epoch` claim).
 */
export async function signIn(cfg: IntegrationConfig, account: TestAccount): Promise<SupabaseClient> {
  const client = createAnonClient(cfg);
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) {
    throw new Error(`signIn failed for ${account.email}: ${error.message}`);
  }
  return client;
}

/**
 * Creates an active pairing between two accounts and points both accounts'
 * `pairing_id` at it. Returns the new pairing id.
 */
export async function createPairing(
  admin: SupabaseClient,
  memberA: string,
  memberB: string,
): Promise<string> {
  const { data, error } = await admin
    .from('pairings')
    .insert({ member_a: memberA, member_b: memberB, status: 'active' })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`pairings insert failed: ${error?.message ?? 'no row returned'}`);
  }
  const pairingId = data.id as string;

  const { error: updErr } = await admin
    .from('accounts')
    .update({ pairing_id: pairingId })
    .in('id', [memberA, memberB]);
  if (updErr) {
    throw new Error(`accounts pairing_id update failed: ${updErr.message}`);
  }
  return pairingId;
}

/**
 * Dissolves a pairing: marks the pairing row `dissolved` and clears both former
 * members' `pairing_id`. After this, `app.current_pairing()` returns NULL for
 * both accounts, so every former-pairing row becomes unreachable (Req 4.4).
 */
export async function dissolvePairing(
  admin: SupabaseClient,
  pairingId: string,
  memberIds: readonly string[],
): Promise<void> {
  const { error: pErr } = await admin
    .from('pairings')
    .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
    .eq('id', pairingId);
  if (pErr) {
    throw new Error(`pairing dissolve failed: ${pErr.message}`);
  }

  const { error: aErr } = await admin
    .from('accounts')
    .update({ pairing_id: null })
    .in('id', [...memberIds]);
  if (aErr) {
    throw new Error(`accounts unpair failed: ${aErr.message}`);
  }
}

/** Best-effort teardown: deleting the auth user cascades to app-owned rows. */
export async function deleteTestAccount(admin: SupabaseClient, id: string): Promise<void> {
  await admin.auth.admin.deleteUser(id);
}

// ---------------------------------------------------------------------------
// Edge Function invocation
// ---------------------------------------------------------------------------
//
// Suites that exercise the server-authoritative Edge Functions call them over
// HTTP rather than through `supabase.functions.invoke`, because the tests need
// the raw status code and error envelope (the client wrapper collapses non-2xx
// responses into a generic FunctionsHttpError). A running functions runtime is
// required: `npm run supabase:functions`.

/** A decoded Edge Function response: HTTP status plus parsed JSON body. */
export interface FunctionResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/** The `{ error: { code, message, details } }` envelope the functions emit. */
export interface FunctionErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
  };
  readonly ok?: boolean;
}

/**
 * POSTs a JSON body to an Edge Function and returns its status + parsed body.
 *
 * `accessToken` sets the Authorization header. Functions declared with
 * `verify_jwt = true` in config.toml reject a request without a valid one, so
 * omitting it is how a suite asserts that gating. The `apikey` header always
 * carries the anon key, which the gateway requires to route the request at all.
 */
export async function callFunction<T = unknown>(
  cfg: IntegrationConfig,
  name: string,
  body: unknown,
  accessToken?: string,
): Promise<FunctionResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: cfg.anonKey,
  };
  if (accessToken !== undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${cfg.url}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // A function may return an empty body (or non-JSON on a gateway error); treat
  // that as an empty object so callers can assert on status alone.
  const text = await res.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: res.status, body: parsed as T };
}

/**
 * Whether the Edge Functions runtime is reachable. Suites that need it call this
 * in `beforeAll` and fail with an actionable message instead of a confusing
 * connection error, since the runtime is a SEPARATE process from the database
 * (`supabase functions serve`, not `supabase start`).
 */
export async function functionsRuntimeReachable(cfg: IntegrationConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.url}/functions/v1/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
      body: '{}',
    });
    // Any HTTP answer proves the runtime is serving; the status itself is
    // irrelevant (health may 404 if not deployed, which still means "reachable").
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Generates credentials for an account that does NOT exist yet, for suites that
 * must register through the Edge Function rather than seed the tables directly
 * (Requirement 1.2's duplicate-email rejection, for instance, can only be
 * observed through the registration path).
 *
 * The password deliberately satisfies the policy from Requirement 1.1: >= 12
 * characters with an upper, a lower, a digit and a non-alphanumeric character.
 */
export function newCredentials(): { email: string; password: string } {
  return {
    email: `auth-${randomUUID()}@example.test`,
    password: `Aa1!${randomUUID()}`,
  };
}
