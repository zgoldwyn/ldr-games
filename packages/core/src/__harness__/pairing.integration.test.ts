import type { SupabaseClient } from '@supabase/supabase-js';

import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  type FunctionErrorBody,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for the pairing Edge Functions (task 13.3):
// `create-invitation` / `accept-invitation` (task 13.1) and `unlink` (task 13.2).
//
// These assert the three properties that only hold because of DATABASE
// mechanisms, and so cannot be established by the pure domain tests alone:
//
//   Property 10 — pairing exclusivity under concurrency  (Req 3.3, 3.4, 3.6, 3.7)
//                 guaranteed by the partial UNIQUE indexes on active membership
//   Property 13 — an invitation is single-use            (Req 3.8)
//                 guaranteed by SELECT ... FOR UPDATE on the invitation row
//   Property 15 — unlink terminates active sessions      (Req 4.6, plus 4.1-4.5)
//                 guaranteed by the dissolve_pairing transaction
//
// The suite is GATED: it skips itself without SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY, and fails with an actionable message if the
// database is up but the Edge Functions runtime is not.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

interface InvitationOk {
  readonly invitation: {
    readonly code: string;
    readonly inviterAccountId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly status: string;
  };
}

interface PairingOk {
  readonly pairing: {
    readonly id: string;
    readonly memberA: string;
    readonly memberB: string;
    readonly status: string;
  };
}

interface UnlinkOk {
  readonly pairing: { readonly id: string; readonly status: string };
  readonly terminatedSessions: readonly string[];
  readonly notifications: number;
}

/** 72 hours in milliseconds — the invitation validity window (Req 3.1). */
const INVITATION_WINDOW_MS = 72 * 60 * 60 * 1000;

describe.skipIf(cfg === null)('Pairing Edge Functions (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  /** A fresh unpaired account plus an authenticated token for it. */
  async function account(): Promise<{ id: string; token: string }> {
    const test: TestAccount = await createTestAccount(admin);
    created.push(test.id);
    const client = await signIn(config, test);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no access token for ${test.email}`);
    return { id: test.id, token };
  }

  /** Creates an invitation as `token`'s account, asserting success. */
  async function invite(token: string): Promise<string> {
    const res = await callFunction<InvitationOk>(config, 'create-invitation', {}, token);
    expect(res.status).toBe(201);
    return res.body.invitation.code;
  }

  /** The account's current pairing_id straight from the table. */
  async function pairingIdOf(id: string): Promise<string | null> {
    const { data, error } = await admin
      .from('accounts')
      .select('pairing_id')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return (data?.pairing_id as string | null) ?? null;
  }

  beforeAll(async () => {
    admin = createServiceClient(config);
    if (!(await functionsRuntimeReachable(config))) {
      throw new Error(
        'The Supabase stack is configured but the Edge Functions runtime is not ' +
          'reachable. Start it with `npm run supabase:functions`.',
      );
    }
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  // -------------------------------------------------------------------------
  // Property 13 — single-use invitation (Req 3.8)
  // -------------------------------------------------------------------------
  it('consumes an invitation exactly once (Property 13)', async () => {
    const inviter = await account();
    const first = await account();
    const second = await account();

    const code = await invite(inviter.token);

    // First acceptance pairs the two accounts.
    const accepted = await callFunction<PairingOk>(
      config,
      'accept-invitation',
      { code },
      first.token,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.pairing.status).toBe('active');

    // A DIFFERENT account cannot reuse the same code.
    const reuse = await callFunction<FunctionErrorBody>(
      config,
      'accept-invitation',
      { code },
      second.token,
    );
    expect(reuse.status).toBe(409);
    expect(reuse.body.error?.code).toBe('INVITATION_ALREADY_CONSUMED');

    // The reuse attempt left the third account unpaired, and the original
    // pairing untouched.
    expect(await pairingIdOf(second.id)).toBeNull();
    expect(await pairingIdOf(inviter.id)).toBe(accepted.body.pairing.id);
    expect(await pairingIdOf(first.id)).toBe(accepted.body.pairing.id);

    // The invitation row itself is marked consumed, so single-use is durable
    // rather than merely observed through the response.
    const { data: invRow } = await admin
      .from('invitations')
      .select('status, consumed_at')
      .eq('code', code)
      .single();
    expect(invRow?.status).toBe('consumed');
    expect(invRow?.consumed_at).not.toBeNull();

    // Exactly one pairing exists for the inviter.
    const { data: pairings } = await admin
      .from('pairings')
      .select('id, status')
      .or(`member_a.eq.${inviter.id},member_b.eq.${inviter.id}`);
    expect(pairings ?? []).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Property 10 — exclusivity: a concurrent double-accept cannot both succeed
  // (Req 3.6)
  // -------------------------------------------------------------------------
  it('cannot pair one inviter with two invitees concurrently (Property 10)', async () => {
    const inviter = await account();
    const j1 = await account();
    const j2 = await account();

    const code = await invite(inviter.token);

    // Both invitees race on the SAME invitation. Whichever transaction reaches
    // the locked invitation row first wins; the other must be rejected.
    const [r1, r2] = await Promise.all([
      callFunction<PairingOk & FunctionErrorBody>(
        config,
        'accept-invitation',
        { code },
        j1.token,
      ),
      callFunction<PairingOk & FunctionErrorBody>(
        config,
        'accept-invitation',
        { code },
        j2.token,
      ),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(201);
    // The loser is rejected with a stable exclusivity/consumption code, never a
    // 500 — a race must be a defined outcome, not a crash.
    expect([409]).toContain(statuses[1]);

    const loser = r1.status === 201 ? r2 : r1;
    expect(['INVITATION_ALREADY_CONSUMED', 'ALREADY_PAIRED']).toContain(
      loser.body.error?.code,
    );

    // The invariant: the inviter ends up in exactly ONE active pairing.
    const { data: pairings } = await admin
      .from('pairings')
      .select('id, member_a, member_b, status')
      .or(`member_a.eq.${inviter.id},member_b.eq.${inviter.id}`)
      .eq('status', 'active');
    expect(pairings ?? []).toHaveLength(1);

    // And exactly one of the two invitees is paired; the other is untouched.
    const paired = [await pairingIdOf(j1.id), await pairingIdOf(j2.id)];
    const nonNull = paired.filter((p) => p !== null);
    expect(nonNull).toHaveLength(1);
    expect(nonNull[0]).toBe(pairings?.[0]?.id);
  });

  // -------------------------------------------------------------------------
  // Property 10 (cont.) — the DATABASE guard, with the pure pre-check bypassed
  // (Req 3.6)
  // -------------------------------------------------------------------------
  //
  // The test above drives the race through the Edge Function, which runs the
  // pure `acceptInvitation` pre-check first. That pre-check is a read-then-write,
  // so it happens to reject the loser in practice and MASKS whether the database
  // guard works at all: with the partial UNIQUE indexes dropped and the RPC's
  // locking removed, that test still passed.
  //
  // Exclusivity must not depend on the pre-check winning a race. This test calls
  // the `accept_invitation` RPC directly, so the transaction's row locks and the
  // partial UNIQUE indexes are the ONLY thing preventing a double pairing —
  // exactly the mechanism Property 10 claims.
  it('serializes concurrent accept transactions at the database (Property 10)', async () => {
    const inviter = await account();
    const j1 = await account();
    const j2 = await account();
    const code = await invite(inviter.token);

    // Two transactions racing on the same invitation, with no pure pre-check in
    // front of either.
    const [r1, r2] = await Promise.all([
      admin.rpc('accept_invitation', { p_code: code, p_invitee: j1.id }),
      admin.rpc('accept_invitation', { p_code: code, p_invitee: j2.id }),
    ]);

    const codes = [r1, r2].map((r) => {
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return (row as { result_code?: string } | null)?.result_code ?? `ERROR:${r.error?.message}`;
    });

    // Exactly one transaction may report OK.
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
    // The loser reports a defined exclusivity/consumption outcome.
    const loserCode = codes.find((c) => c !== 'OK');
    expect(['ALREADY_PAIRED', 'INVITATION_ALREADY_CONSUMED']).toContain(loserCode);

    // The invariant that actually matters: one active pairing, one paired invitee.
    const { data: pairings } = await admin
      .from('pairings')
      .select('id')
      .or(`member_a.eq.${inviter.id},member_b.eq.${inviter.id}`)
      .eq('status', 'active');
    expect(pairings ?? []).toHaveLength(1);

    const paired = [await pairingIdOf(j1.id), await pairingIdOf(j2.id)].filter(
      (p) => p !== null,
    );
    expect(paired).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Property 10 (cont.) — an already-paired account is refused (Req 3.3, 3.7)
  // -------------------------------------------------------------------------
  it('refuses invitation creation and acceptance by a paired account (Property 10)', async () => {
    const a = await account();
    const b = await account();
    const outsider = await account();

    const code = await invite(a.token);
    const paired = await callFunction<PairingOk>(config, 'accept-invitation', { code }, b.token);
    expect(paired.status).toBe(201);
    const pairingId = paired.body.pairing.id;

    // Req 3.7: a paired account cannot create a new invitation.
    const reInvite = await callFunction<FunctionErrorBody>(
      config,
      'create-invitation',
      {},
      a.token,
    );
    expect(reInvite.status).toBe(409);
    expect(reInvite.body.error?.code).toBe('ALREADY_PAIRED');

    // Req 3.3: a paired account cannot accept someone else's invitation, and the
    // attempt leaves both the existing pairing and the outsider unchanged.
    const outsiderCode = await invite(outsider.token);
    const crossAccept = await callFunction<FunctionErrorBody>(
      config,
      'accept-invitation',
      { code: outsiderCode },
      a.token,
    );
    expect(crossAccept.status).toBe(409);
    expect(crossAccept.body.error?.code).toBe('ALREADY_PAIRED');

    expect(await pairingIdOf(a.id)).toBe(pairingId);
    expect(await pairingIdOf(outsider.id)).toBeNull();

    // The outsider's invitation was NOT consumed by the failed attempt, so it
    // remains usable — a rejected accept must not burn the invitation.
    const { data: invRow } = await admin
      .from('invitations')
      .select('status')
      .eq('code', outsiderCode)
      .single();
    expect(invRow?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Req 3.1 — the invitation is valid for 72 hours
  // -------------------------------------------------------------------------
  it('issues invitations that expire 72 hours after creation (Req 3.1)', async () => {
    const inviter = await account();
    const res = await callFunction<InvitationOk>(config, 'create-invitation', {}, inviter.token);
    expect(res.status).toBe(201);

    const createdAt = Date.parse(res.body.invitation.createdAt);
    const expiresAt = Date.parse(res.body.invitation.expiresAt);
    expect(expiresAt - createdAt).toBe(INVITATION_WINDOW_MS);
    expect(res.body.invitation.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Property 15 — unlink terminates active sessions and notifies both partners
  // (Req 4.1-4.6)
  // -------------------------------------------------------------------------
  it('terminates active sessions and notifies both partners on unlink (Property 15)', async () => {
    const a = await account();
    const b = await account();

    const code = await invite(a.token);
    const paired = await callFunction<PairingOk>(config, 'accept-invitation', { code }, b.token);
    expect(paired.status).toBe(201);
    const pairingId = paired.body.pairing.id;

    // Seed one active session of each game kind.
    const rt = await admin
      .from('rt_sessions')
      .insert({ pairing_id: pairingId, game_id: 'tic-tac-toe', state: 'active' })
      .select('id')
      .single();
    expect(rt.error).toBeNull();
    const async_ = await admin
      .from('async_sessions')
      .insert({
        pairing_id: pairingId,
        game_id: 'battleship',
        state: 'active',
        active_turn_holder: a.id,
      })
      .select('id')
      .single();
    expect(async_.error).toBeNull();

    const rtId = rt.data?.id as string;
    const asyncId = async_.data?.id as string;

    // --- unlink, confirmed by one partner (Req 4.1) ------------------------
    const res = await callFunction<UnlinkOk>(config, 'unlink', {}, a.token);
    expect(res.status).toBe(200);
    expect(res.body.pairing.status).toBe('dissolved');

    // Req 4.6: both active sessions were terminated.
    expect([...res.body.terminatedSessions].sort()).toEqual([rtId, asyncId].sort());

    const { data: rtAfter } = await admin
      .from('rt_sessions')
      .select('state, outcome')
      .eq('id', rtId)
      .single();
    expect(rtAfter?.state).toBe('terminal');
    // Terminated by dissolution rather than by play, so no winner is recorded.
    expect(rtAfter?.outcome).toMatchObject({ reason: 'pairing_dissolved' });

    const { data: asyncAfter } = await admin
      .from('async_sessions')
      .select('state')
      .eq('id', asyncId)
      .single();
    expect(asyncAfter?.state).toBe('terminal');

    // Req 4.1/4.3: the pairing is dissolved and both accounts are unpaired.
    const { data: pairingAfter } = await admin
      .from('pairings')
      .select('status, dissolved_at')
      .eq('id', pairingId)
      .single();
    expect(pairingAfter?.status).toBe('dissolved');
    expect(pairingAfter?.dissolved_at).not.toBeNull();
    expect(await pairingIdOf(a.id)).toBeNull();
    expect(await pairingIdOf(b.id)).toBeNull();

    // Req 4.2/4.5: BOTH partners get a pairing-ended notification, undelivered
    // so an offline partner receives it on next sign-in.
    const { data: notes } = await admin
      .from('notifications')
      .select('recipient_account_id, category, payload, delivered_at')
      .in('recipient_account_id', [a.id, b.id]);

    const pairingEnded = (notes ?? []).filter(
      (n) => (n.payload as { type?: string })?.type === 'pairing_ended',
    );
    expect(pairingEnded).toHaveLength(2);
    expect(new Set(pairingEnded.map((n) => n.recipient_account_id))).toEqual(
      new Set([a.id, b.id]),
    );
    for (const note of pairingEnded) {
      expect(note.delivered_at).toBeNull();
    }

    // Each terminated session is announced to both partners too (Req 4.6), so a
    // partner mid-game learns why it ended.
    const sessionEnded = (notes ?? []).filter(
      (n) => (n.payload as { type?: string })?.type === 'session_ended',
    );
    expect(sessionEnded).toHaveLength(4); // 2 sessions x 2 recipients
    for (const sessionId of [rtId, asyncId]) {
      const forSession = sessionEnded.filter(
        (n) => (n.payload as { sessionId?: string })?.sessionId === sessionId,
      );
      expect(new Set(forSession.map((n) => n.recipient_account_id))).toEqual(
        new Set([a.id, b.id]),
      );
    }

    // Req 4.4 (a former partner losing read access to pairing data) is asserted
    // in rls.integration.test.ts, which owns the RLS boundary. This suite stops
    // at the server-side effects of the dissolution transaction.

    // Unlinking again is refused: there is no longer a pairing to dissolve.
    const again = await callFunction<FunctionErrorBody>(config, 'unlink', {}, a.token);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOT_PAIRED');
  });
});
