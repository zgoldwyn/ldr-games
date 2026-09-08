import { randomUUID } from 'node:crypto';

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

// Account deletion integration tests (task 21A.4, Requirement 12).
//
// These drive the real Edge Function because the guarantees cross Postgres,
// Storage, Auth, and the single-session epoch mechanism. Pure tests cannot prove
// that cascades remove actual rows, an email is released, or image bytes vanish.

const cfg = getIntegrationConfig();
const DELETION_BUDGET_MS = 30_000;
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DeleteAccountOk {
  readonly deleted: boolean;
  readonly confirmed?: boolean;
  readonly accountId?: string;
  readonly pairingIds?: readonly string[];
}

describe.skipIf(cfg === null)('Account deletion (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const createdAccounts = new Set<string>();
  const storageKeys = new Set<string>();

  async function member(): Promise<{
    account: TestAccount;
    token: string;
  }> {
    const account = await createTestAccount(admin);
    createdAccounts.add(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, token };
  }

  async function createPairing(memberA: string, memberB: string): Promise<string> {
    const { data, error } = await admin
      .from('pairings')
      .insert({ member_a: memberA, member_b: memberB, status: 'active' })
      .select('id')
      .single();
    expect(error).toBeNull();
    const pairingId = data?.id as string;
    const update = await admin
      .from('accounts')
      .update({ pairing_id: pairingId })
      .in('id', [memberA, memberB]);
    expect(update.error).toBeNull();
    return pairingId;
  }

  async function rowCount(table: string, column: string, value: string): Promise<number> {
    const { count, error } = await admin
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, value);
    expect(error).toBeNull();
    return count ?? 0;
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
    if (storageKeys.size > 0) {
      await admin.storage
        .from('drawings')
        .remove([...storageKeys])
        .catch(() => undefined);
    }
    await Promise.all(
      [...createdAccounts].map((id) => deleteTestAccount(admin, id).catch(() => undefined)),
    );
  });

  // Feature: ldr-companion-app, Property 42: Account deletion leaves no trace of the account
  it('removes an unpaired account and releases its email for registration (Property 42)', async () => {
    const deleted = await member();

    const response = await callFunction<DeleteAccountOk>(
      config,
      'delete-account',
      { confirmed: true },
      deleted.token,
    );
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);

    expect(await rowCount('accounts', 'id', deleted.account.id)).toBe(0);
    expect(await rowCount('account_session', 'account_id', deleted.account.id)).toBe(0);
    expect(await rowCount('notifications', 'recipient_account_id', deleted.account.id)).toBe(0);

    const authLookup = await admin.auth.admin.getUserById(deleted.account.id);
    expect(authLookup.data.user).toBeNull();
    expect(authLookup.error).not.toBeNull();

    const registeredAgain = await callFunction<{ data: { accountId: string } }>(
      config,
      'register',
      { email: deleted.account.email, password: deleted.account.password },
    );
    expect(registeredAgain.status).toBe(201);
    createdAccounts.add(registeredAgain.body.data.accountId);
  });

  // Feature: ldr-companion-app, Property 43: Account deletion leaves the remaining partner consistent
  it('dissolves first, removes pairing data/images, and leaves the partner consistent (Property 43)', async () => {
    const departing = await member();
    const remaining = await member();
    const formerPartner = await member();

    // Keep one historical pairing to pin Requirement 12.6's "any Pairing that
    // Account belonged to" wording. Deletion must clean this old Storage prefix
    // as well as the current pairing's prefix.
    const historicalPairingId = await createPairing(departing.account.id, formerPartner.account.id);
    const dissolveHistorical = await admin
      .from('pairings')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
      .eq('id', historicalPairingId);
    expect(dissolveHistorical.error).toBeNull();
    const clearHistorical = await admin
      .from('accounts')
      .update({ pairing_id: null })
      .in('id', [departing.account.id, formerPartner.account.id]);
    expect(clearHistorical.error).toBeNull();

    const pairingId = await createPairing(departing.account.id, remaining.account.id);

    const rt = await admin
      .from('rt_sessions')
      .insert({ pairing_id: pairingId, game_id: 'tic-tac-toe', state: 'active' })
      .select('id')
      .single();
    expect(rt.error).toBeNull();
    const asyncGame = await admin
      .from('async_sessions')
      .insert({
        pairing_id: pairingId,
        game_id: 'battleship',
        state: 'active',
        active_turn_holder: departing.account.id,
      })
      .select('id')
      .single();
    expect(asyncGame.error).toBeNull();
    const date = await admin
      .from('relationship_dates')
      .insert({ pairing_id: pairingId, title: 'First hello', date: '2024-02-29' })
      .select('id')
      .single();
    expect(date.error).toBeNull();
    const reminder = await admin.from('reminders').insert({
      date_id: date.data?.id,
      pairing_id: pairingId,
      lead_time_ms: 3_600_000,
      next_trigger_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(reminder.error).toBeNull();
    const ownNotification = await admin.from('notifications').insert({
      recipient_account_id: departing.account.id,
      category: 'system',
      payload: { private: true },
      dedupe_key: `delete-owned-${randomUUID()}`,
    });
    expect(ownNotification.error).toBeNull();
    expect(
      (
        await admin.from('auth_attempts').insert({
          account_id: departing.account.id,
          failed_count: 2,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.from('notification_settings').insert({
          account_id: departing.account.id,
          disabled_categories: ['quiz'],
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.from('invitations').insert({
          code: `DEL${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`,
          inviter_account_id: departing.account.id,
        })
      ).error,
    ).toBeNull();

    const imageKey = `${pairingId}/${asyncGame.data?.id}/${randomUUID()}.png`;
    storageKeys.add(imageKey);
    const upload = await admin.storage
      .from('drawings')
      .upload(imageKey, PNG_BYTES, { contentType: 'image/png' });
    expect(upload.error).toBeNull();
    const historicalImageKey = `${historicalPairingId}/legacy/${randomUUID()}.png`;
    storageKeys.add(historicalImageKey);
    const historicalUpload = await admin.storage
      .from('drawings')
      .upload(historicalImageKey, PNG_BYTES, { contentType: 'image/png' });
    expect(historicalUpload.error).toBeNull();

    const started = Date.now();
    const response = await callFunction<DeleteAccountOk>(
      config,
      'delete-account',
      { confirmed: true },
      departing.token,
    );
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
    expect(response.body.pairingIds).toContain(pairingId);
    expect(response.body.pairingIds).toContain(historicalPairingId);
    expect(elapsed).toBeLessThan(DELETION_BUDGET_MS);

    const partner = await admin
      .from('accounts')
      .select('pairing_id')
      .eq('id', remaining.account.id)
      .single();
    expect(partner.error).toBeNull();
    expect(partner.data?.pairing_id).toBeNull();

    for (const [table, column] of [
      ['pairings', 'id'],
      ['rt_sessions', 'pairing_id'],
      ['async_sessions', 'pairing_id'],
      ['relationship_dates', 'pairing_id'],
      ['reminders', 'pairing_id'],
    ] as const) {
      expect(await rowCount(table, column, pairingId), `${table} survived deletion`).toBe(0);
    }
    expect(await rowCount('notifications', 'recipient_account_id', departing.account.id)).toBe(0);
    expect(await rowCount('account_session', 'account_id', departing.account.id)).toBe(0);
    expect(await rowCount('auth_attempts', 'account_id', departing.account.id)).toBe(0);
    expect(await rowCount('invitations', 'inviter_account_id', departing.account.id)).toBe(0);
    expect(await rowCount('notification_settings', 'account_id', departing.account.id)).toBe(0);
    expect(await rowCount('pairings', 'id', historicalPairingId)).toBe(0);

    const partnerNotifications = await admin
      .from('notifications')
      .select('category, payload')
      .eq('recipient_account_id', remaining.account.id);
    expect(partnerNotifications.error).toBeNull();
    expect(partnerNotifications.data ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'pairing',
          payload: expect.objectContaining({ type: 'pairing_ended', pairingId }),
        }),
      ]),
    );

    const stored = await admin.storage.from('drawings').list(`${pairingId}/${asyncGame.data?.id}`);
    expect(stored.error).toBeNull();
    expect(stored.data ?? []).toHaveLength(0);
    storageKeys.delete(imageKey);
    const historicalStored = await admin.storage
      .from('drawings')
      .list(`${historicalPairingId}/legacy`);
    expect(historicalStored.error).toBeNull();
    expect(historicalStored.data ?? []).toHaveLength(0);
    storageKeys.delete(historicalImageKey);

    // The credential is gone, so its previously issued token is refused.
    const staleAfterDelete = await callFunction<FunctionErrorBody>(
      config,
      'delete-account',
      { confirmed: true },
      departing.token,
    );
    expect(staleAfterDelete.status).toBe(401);
  });

  it('rejects a displaced token before any privileged deletion (Req 12.5)', async () => {
    const target = await member();
    const bump = await admin
      .from('account_session')
      .update({ epoch: 1, updated_at: new Date().toISOString() })
      .eq('account_id', target.account.id);
    expect(bump.error).toBeNull();

    const response = await callFunction<FunctionErrorBody>(
      config,
      'delete-account',
      { confirmed: true },
      target.token,
    );
    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('SESSION_SUPERSEDED');
    expect(await rowCount('accounts', 'id', target.account.id)).toBe(1);
  });

  // Feature: ldr-companion-app, Property 44: An unconfirmed deletion changes nothing
  it('makes no change when confirmation is absent or false (Property 44)', async () => {
    const target = await member();
    const beforeAccount = await admin
      .from('accounts')
      .select('*')
      .eq('id', target.account.id)
      .single();
    const beforeSession = await admin
      .from('account_session')
      .select('*')
      .eq('account_id', target.account.id)
      .single();

    const response = await callFunction<DeleteAccountOk>(
      config,
      'delete-account',
      { confirmed: false },
      target.token,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: false, confirmed: false });

    const afterAccount = await admin
      .from('accounts')
      .select('*')
      .eq('id', target.account.id)
      .single();
    const afterSession = await admin
      .from('account_session')
      .select('*')
      .eq('account_id', target.account.id)
      .single();
    expect(afterAccount.data).toEqual(beforeAccount.data);
    expect(afterSession.data).toEqual(beforeSession.data);
    expect((await admin.auth.admin.getUserById(target.account.id)).data.user?.id).toBe(
      target.account.id,
    );
  });
});
