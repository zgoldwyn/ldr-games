import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  callFunction,
  createPairing,
  createServiceClient,
  functionsRuntimeReachable,
  getIntegrationConfig,
  newCredentials,
  type FunctionErrorBody,
  type IntegrationConfig,
} from './supabase.js';

// Integration tests for the authentication Edge Functions (task 12.4):
// `register` (task 12.1) and `auth-login` (tasks 12.2, 12.3).
//
// These cover the four properties that can only be observed end to end, because
// each depends on state Supabase owns (the auth.users uniqueness index, GoTrue's
// bcrypt check, the account_session epoch registry, and the RLS epoch guard)
// rather than on any pure helper:
//
//   Property 3 — duplicate email rejection                      (Req 1.2)
//   Property 5 — correct/incorrect credential outcomes          (Req 2.1)
//   Property 6 — failures are indistinguishable                 (Req 2.2)
//   Property 8 — a second login displaces the first, and a
//                stale-epoch token is denied                    (Req 2.7-2.9)
//
// The suite is GATED twice over. It skips itself without SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY (no stack), and it fails loudly with an actionable
// message if the stack is up but the Edge Functions runtime is not, since that
// runtime is a SEPARATE process (`npm run supabase:functions`) and a connection
// error there is otherwise cryptic.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** Registration must complete well inside the 5-second budget (Req 1.1). */
const REGISTRATION_BUDGET_MS = 5_000;

interface RegisterOk {
  readonly ok: true;
  readonly data: { readonly accountId: string; readonly pairingId: string | null };
}

interface LoginOk {
  readonly epoch: number;
  readonly session: { readonly access_token: string; readonly refresh_token: string };
  readonly user: { readonly id: string };
}

describe.skipIf(cfg === null)('Authentication Edge Functions (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  /** Auth users created here, torn down at the end. */
  const createdAccountIds: string[] = [];

  /** Registers a fresh account through the Edge Function, asserting success. */
  async function register(credentials: { email: string; password: string }): Promise<string> {
    const res = await callFunction<RegisterOk>(config, 'register', credentials);
    expect(res.status).toBe(201);
    const accountId = res.body.data.accountId;
    createdAccountIds.push(accountId);
    return accountId;
  }

  /** An RLS-scoped client that presents `accessToken` on every request. */
  function clientWithToken(accessToken: string): SupabaseClient {
    return createClient(config.url, config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  beforeAll(async () => {
    admin = createServiceClient(config);

    const reachable = await functionsRuntimeReachable(config);
    if (!reachable) {
      throw new Error(
        'The Supabase stack is configured but the Edge Functions runtime is not ' +
          'reachable. Start it with `npm run supabase:functions` (it runs ' +
          'separately from `supabase start`).',
      );
    }
  });

  afterAll(async () => {
    // Deleting the auth user cascades to the app-owned rows.
    await Promise.all(
      createdAccountIds.map((id) => admin.auth.admin.deleteUser(id).catch(() => undefined)),
    );
  });

  // -------------------------------------------------------------------------
  // Property 3 — duplicate email rejection (Req 1.2)
  // -------------------------------------------------------------------------
  it('rejects a duplicate email and creates no second account (Property 3)', async () => {
    const credentials = newCredentials();

    const started = Date.now();
    const accountId = await register(credentials);
    // Req 1.1: registration returns within 5 seconds.
    expect(Date.now() - started).toBeLessThan(REGISTRATION_BUDGET_MS);

    // Same email again -> rejected with the stable code, no account created.
    const duplicate = await callFunction<FunctionErrorBody>(config, 'register', credentials);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('EMAIL_ALREADY_REGISTERED');

    // The rejection must not have produced a second `accounts` row.
    const { data, error } = await admin
      .from('accounts')
      .select('id')
      .eq('id', accountId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);

    // Casing is not a loophole: emails are unique case-insensitively, so the
    // upper-cased address must not create a parallel account either.
    const upper = await callFunction<FunctionErrorBody>(config, 'register', {
      email: credentials.email.toUpperCase(),
      password: credentials.password,
    });
    expect(upper.status).toBe(409);
    expect(upper.body.error?.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  // -------------------------------------------------------------------------
  // Property 5 — correct vs incorrect credentials (Req 2.1)
  // -------------------------------------------------------------------------
  it('authenticates correct credentials and refuses incorrect ones (Property 5)', async () => {
    const credentials = newCredentials();
    const accountId = await register(credentials);

    // Correct credentials -> a session for exactly this account.
    const ok = await callFunction<LoginOk>(config, 'auth-login', credentials);
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(accountId);
    expect(ok.body.session.access_token.length).toBeGreaterThan(0);

    // Wrong password -> refused, no session issued.
    const wrong = await callFunction<FunctionErrorBody & Partial<LoginOk>>(
      config,
      'auth-login',
      { email: credentials.email, password: `${credentials.password}x` },
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('AUTH_FAILED');
    expect(wrong.body.session).toBeUndefined();

    // The correct password still works afterward: a failed attempt must not
    // invalidate the credential.
    const again = await callFunction<LoginOk>(config, 'auth-login', credentials);
    expect(again.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Property 6 — indistinguishable failures (Req 2.2)
  // -------------------------------------------------------------------------
  it('returns an identical error for a wrong password and an unknown email (Property 6)', async () => {
    const credentials = newCredentials();
    await register(credentials);

    // Registered address, wrong password.
    const wrongPassword = await callFunction<FunctionErrorBody>(config, 'auth-login', {
      email: credentials.email,
      password: 'DefinitelyWrong1!',
    });

    // Address that was never registered, same wrong password.
    const unknownEmail = await callFunction<FunctionErrorBody>(config, 'auth-login', {
      email: newCredentials().email,
      password: 'DefinitelyWrong1!',
    });

    // Status, code and message must all match, so neither response reveals
    // whether the account exists.
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body.error?.code).toBe(wrongPassword.body.error?.code);
    expect(unknownEmail.body.error?.message).toBe(wrongPassword.body.error?.message);

    // And the message must not name the field that was wrong.
    const message = wrongPassword.body.error?.message ?? '';
    expect(message).not.toMatch(/not found|no such|unknown|does not exist|incorrect password/i);
  });

  // -------------------------------------------------------------------------
  // Property 8 — single active session: a second login displaces the first
  // (Req 2.7, 2.8, 2.9)
  // -------------------------------------------------------------------------
  it('displaces the prior session and denies its stale-epoch token (Property 8)', async () => {
    // Two paired accounts, so there is pairing-scoped data whose RLS policy
    // includes the epoch guard to read.
    const credsA = newCredentials();
    const credsB = newCredentials();
    const accountA = await register(credsA);
    const accountB = await register(credsB);
    const pairing = await createPairing(admin, accountA, accountB);

    const seeded = await admin
      .from('relationship_dates')
      .insert({ pairing_id: pairing, title: 'Anniversary', date: '2020-06-15' })
      .select('id')
      .single();
    expect(seeded.error).toBeNull();
    const dateId = seeded.data?.id as string;

    // --- first sign-in ----------------------------------------------------
    const first = await callFunction<LoginOk>(config, 'auth-login', credsA);
    expect(first.status).toBe(200);
    const firstToken = first.body.session.access_token;
    const firstEpoch = first.body.epoch;

    // The first session can read its pairing's data.
    const beforeDisplacement = await clientWithToken(firstToken)
      .from('relationship_dates')
      .select('id')
      .eq('id', dateId);
    expect(beforeDisplacement.error).toBeNull();
    expect((beforeDisplacement.data ?? []).map((r) => r.id as string)).toContain(dateId);

    // --- second sign-in displaces the first -------------------------------
    const second = await callFunction<LoginOk>(config, 'auth-login', credsA);
    expect(second.status).toBe(200);
    const secondToken = second.body.session.access_token;

    // Req 2.7: the epoch advanced, so every previously issued token is stale.
    expect(second.body.epoch).toBeGreaterThan(firstEpoch);

    // The registry holds exactly one row, at the newest epoch — one active
    // session per account, not a set of them.
    const registry = await admin
      .from('account_session')
      .select('account_id, epoch')
      .eq('account_id', accountA);
    expect(registry.error).toBeNull();
    expect(registry.data ?? []).toHaveLength(1);
    expect(registry.data?.[0]?.epoch).toBe(second.body.epoch);

    // Req 2.8: the stale token is denied. The guard is part of the RLS
    // predicate, so a filtered read returns NO rows rather than an error.
    const afterDisplacement = await clientWithToken(firstToken)
      .from('relationship_dates')
      .select('id')
      .eq('id', dateId);
    expect(afterDisplacement.error).toBeNull();
    expect(afterDisplacement.data ?? []).toHaveLength(0);

    // The newest token is the one that works, so displacement replaced the
    // session rather than locking the account out entirely.
    const newSession = await clientWithToken(secondToken)
      .from('relationship_dates')
      .select('id')
      .eq('id', dateId);
    expect(newSession.error).toBeNull();
    expect((newSession.data ?? []).map((r) => r.id as string)).toContain(dateId);

    // Scope check: the epoch guard withholds SHARED features (Req 2.9), not the
    // account's own rows. A displaced client must still be able to read its own
    // session state, otherwise it could never observe that it was displaced and
    // route itself to sign-in — which is exactly what Req 2.9 asks it to do.
    // Migration 20260826062549 omits the guard on `account_session` for this
    // reason; `accounts` likewise carries only a self predicate.
    const staleSelfRead = await clientWithToken(firstToken)
      .from('account_session')
      .select('account_id, epoch')
      .eq('account_id', accountA);
    expect(staleSelfRead.error).toBeNull();
    expect(staleSelfRead.data ?? []).toHaveLength(1);
    // And what it reads is the NEW epoch, which is the signal that its own token
    // is stale and it must sign out.
    expect(staleSelfRead.data?.[0]?.epoch).toBe(second.body.epoch);
  });
});
