import type { SupabaseClient } from '@supabase/supabase-js';

import { accountId as toAccountId } from '../domain/common.js';
import type { Notification } from '../domain/notification.js';
import { NOTIFICATION_RETENTION_MS } from '../domain/notification-delivery.js';
import type { DataChange } from '../domain/sync.js';
import { createNotificationModule } from '../notifications/notification-module.js';
import { createSupabaseNotificationPorts } from '../notifications/supabase-ports.js';
import { createSupabaseSyncPorts } from '../sync/supabase-ports.js';
import { createSyncModule } from '../sync/sync-module.js';
import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  withRealtimeRetry,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for in-app notification reads and acknowledgement
// (task 19.3, MVP slice — Req 11.1, 11.2, 11.3, 11.6).
//
// The unit tests already cover the eligibility rules against stub ports. What
// only a live stack can establish is that RLS really scopes a recipient to their
// OWN notifications, that a real game invite arrives over Realtime inside the 5s
// budget, and that acknowledgement is durable rather than client-side state.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** Req 11.1 / 11.2 budget. */
const NOTIFY_BUDGET_MS = 5_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

interface LoginResponse {
  readonly epoch: number;
  readonly session: { readonly access_token: string };
  readonly user: { readonly id: string };
}

interface FunctionErrorResponse {
  readonly error?: { readonly code?: string; readonly message?: string };
}

describe.skipIf(cfg === null)('In-app notifications (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  async function member(): Promise<{
    account: TestAccount;
    id: string;
    token: string;
    client: SupabaseClient;
  }> {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, id: account.id, token, client };
  }

  async function pair(aToken: string, bToken: string): Promise<string> {
    const inv = await callFunction<{ invitation: { code: string } }>(
      config,
      'create-invitation',
      {},
      aToken,
    );
    expect(inv.status).toBe(201);
    const accepted = await callFunction<{ pairing: { id: string } }>(
      config,
      'accept-invitation',
      { code: inv.body.invitation.code },
      bToken,
    );
    expect(accepted.status).toBe(201);
    return accepted.body.pairing.id;
  }

  /** Seed a notification directly, for cases a real flow cannot easily produce. */
  async function seed(
    recipient: string,
    overrides: Partial<{
      category: string;
      payload: unknown;
      dedupe_key: string;
      created_at: string;
      acknowledged_at: string | null;
    }> = {},
  ): Promise<string> {
    const { data, error } = await admin
      .from('notifications')
      .insert({
        recipient_account_id: recipient,
        category: overrides.category ?? 'async_turn',
        payload: overrides.payload ?? { kind: 'your_turn' },
        dedupe_key: overrides.dedupe_key ?? `seed-${Math.random().toString(36).slice(2)}`,
        ...(overrides.created_at === undefined ? {} : { created_at: overrides.created_at }),
        ...(overrides.acknowledged_at === undefined
          ? {}
          : { acknowledged_at: overrides.acknowledged_at }),
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    return data?.id as string;
  }

  function settingsChange(
    account: string,
    disabledCategories: readonly string[],
    physical = Date.now(),
    counter = 0,
  ): DataChange {
    const originAccountId = toAccountId(account);
    return {
      itemId: account,
      itemType: 'notification_settings',
      payload: { disabled_categories: [...disabledCategories] },
      hlc: { physical, counter, originAccountId },
      originAccountId,
    };
  }

  beforeAll(async () => {
    admin = createServiceClient(config);
    if (!(await functionsRuntimeReachable(config))) {
      throw new Error(
        'Stack is configured but the Edge Functions runtime is unreachable. ' +
          'Start it with `npm run supabase:functions`.',
      );
    }
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  // -------------------------------------------------------------------------
  // RLS scoping — the thing only a live stack proves
  // -------------------------------------------------------------------------
  it('reads only the caller’s own notifications (Req 11.1)', async () => {
    const a = await member();
    const b = await member();

    const mine = await seed(a.id, { dedupe_key: 'mine' });
    await seed(b.id, { dedupe_key: 'theirs' });

    const moduleA = createNotificationModule(createSupabaseNotificationPorts(a.client));
    const listed = await moduleA.list(toAccountId(a.id));
    expect(listed.map((n) => n.id)).toEqual([mine]);

    // The assertion above passes even with RLS wide open, because the adapter adds
    // a client-side `.eq('recipient_account_id', ...)` filter. So it proves the
    // module behaves, NOT that the database enforces anything. Probe the table
    // directly, with no recipient filter, so RLS is the only thing standing —
    // the same reason the pairing suite drives its RPC directly.
    const unfiltered = await a.client.from('notifications').select('id, recipient_account_id');
    expect(unfiltered.error).toBeNull();
    expect(
      (unfiltered.data ?? []).map((r) => r.id),
      'RLS must scope an unfiltered read to the caller’s own notifications',
    ).toEqual([mine]);

    // And B cannot acknowledge A's notification even by asking directly.
    const moduleB = createNotificationModule(createSupabaseNotificationPorts(b.client));
    expect(await moduleB.acknowledge(mine as never)).toBeNull();

    // A's notification is untouched by that attempt.
    const { data } = await admin
      .from('notifications')
      .select('acknowledged_at')
      .eq('id', mine)
      .single();
    expect(data?.acknowledged_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Req 11.2 — a real game invite arrives live within 5 seconds
  // -------------------------------------------------------------------------
  it('delivers a real game-invite notification within 5 seconds (Req 11.2)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    // Warm-up outside the budget, retried with a FRESH subscription. Two reasons,
    // same as the sync suite: SUBSCRIBED does not mean the binding is attached
    // (and Req 11.2's 5s is about delivery, not setup), and the first
    // subscription after the replication slot is recreated is dead — only a new
    // one recovers, so waiting longer on it would not help.
    const { moduleB, arrivals } = await withRealtimeRetry(async () => {
      const captured: Notification[] = [];
      const candidate = createNotificationModule(
        createSupabaseNotificationPorts(b.client),
        { onNotification: (n) => captured.push(n) },
      );
      candidate.subscribe(toAccountId(b.id));

      await seed(b.id, { dedupe_key: `warm-up-${Math.random().toString(36).slice(2)}` });
      const deadline = Date.now() + 6_000;
      while (captured.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (captured.length === 0) {
        candidate.unsubscribe();
        return null;
      }
      return { moduleB: candidate, arrivals: captured };
    });

    arrivals.length = 0;

    // A real invite through rt-move, not a seeded row.
    const started = Date.now();
    const invited = await callFunction<{ session: { id: string } }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );
    expect(invited.status).toBe(201);

    while (arrivals.length === 0 && Date.now() - started < NOTIFY_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(arrivals.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(NOTIFY_BUDGET_MS);
    expect(arrivals[0]?.category).toBe('game_invite');
    expect((arrivals[0]?.payload as { sessionId?: string })?.sessionId).toBe(
      invited.body.session.id,
    );

    moduleB.unsubscribe();
  }, SUBSCRIBE_TIMEOUT_MS + 40_000);

  // -------------------------------------------------------------------------
  // Req 11.6 — acknowledgement is durable across sessions
  // -------------------------------------------------------------------------
  it('withholds an acknowledged notification from a NEW session (Req 11.6)', async () => {
    const a = await member();
    const id = await seed(a.id, { dedupe_key: 'ack-durable' });

    const module = createNotificationModule(createSupabaseNotificationPorts(a.client));
    expect((await module.list(toAccountId(a.id))).map((n) => n.id)).toContain(id);

    const acked = await module.acknowledge(id as never);
    expect(acked).not.toBeNull();
    expect(acked?.acknowledgedAt).not.toBeNull();
    // Req 11.6 says acknowledging marks it DELIVERED too.
    expect(acked?.deliveredAt).not.toBeNull();

    // A genuinely new session: sign out, sign back in, fresh client with no
    // cached state. This is what "subsequent Authenticated_Sessions" means.
    await a.client.auth.signOut();
    const reborn = await signIn(config, a.account);
    const rebornModule = createNotificationModule(createSupabaseNotificationPorts(reborn));
    expect((await rebornModule.list(toAccountId(a.id))).map((n) => n.id)).not.toContain(id);
  });

  it('does not re-acknowledge, so a retry cannot rewrite the timestamp (Req 11.6)', async () => {
    const a = await member();
    const id = await seed(a.id, { dedupe_key: 'ack-idempotent' });

    const module = createNotificationModule(createSupabaseNotificationPorts(a.client));
    const first = await module.acknowledge(id as never);
    expect(first).not.toBeNull();

    const second = await module.acknowledge(id as never);
    expect(second).toBeNull();

    const { data } = await admin
      .from('notifications')
      .select('acknowledged_at')
      .eq('id', id)
      .single();
    expect(Date.parse(data?.acknowledged_at as string)).toBe(first?.acknowledgedAt);
  });

  // -------------------------------------------------------------------------
  // Task 19.1b / Req 11.3 — settings RLS and the module write path
  // -------------------------------------------------------------------------
  it('denies direct settings mutations for the owner and another account (Task 19.1b)', async () => {
    const a = await member();
    const b = await member();

    const seeded = await admin
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['game_invite'] })
      .select('account_id, disabled_categories')
      .single();
    expect(seeded.error).toBeNull();

    // Authenticated clients may read their own row, but direct INSERT/UPDATE
    // are revoked: settings mutations must carry an HLC through sync-write.
    const ownerRead = await a.client
      .from('notification_settings')
      .select('account_id, disabled_categories');
    expect(ownerRead.error).toBeNull();
    expect(ownerRead.data ?? []).toHaveLength(1);

    const ownerInsert = await a.client
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['quiz'] });
    expect(ownerInsert.error).not.toBeNull();

    const ownerUpdate = await a.client
      .from('notification_settings')
      .update({ disabled_categories: ['reminder'] })
      .select('account_id, disabled_categories');
    expect(ownerUpdate.error).not.toBeNull();
    expect(ownerUpdate.data ?? []).toEqual([]);

    // These are deliberately unfiltered probes. The adapter's account filter
    // cannot make this assertion pass: only notification_settings RLS can hide
    // A's row from B.
    const otherRead = await b.client
      .from('notification_settings')
      .select('account_id, disabled_categories');
    expect(otherRead.error).toBeNull();
    expect(otherRead.data ?? []).toEqual([]);

    const otherInsert = await b.client
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['quiz'] });
    expect(otherInsert.error).not.toBeNull();

    // UPDATE may be represented by PostgREST as an empty successful result
    // rather than an error when USING hides the target. Either way, the row
    // must not change; the service-role read is only an observation oracle.
    const otherUpdate = await b.client
      .from('notification_settings')
      .update({ disabled_categories: ['quiz'] })
      .select('account_id, disabled_categories');
    expect(otherUpdate.error).not.toBeNull();
    expect(otherUpdate.data ?? []).toEqual([]);

    const afterDeniedWrite = await admin
      .from('notification_settings')
      .select('account_id, disabled_categories')
      .eq('account_id', a.id)
      .single();
    expect(afterDeniedWrite.error).toBeNull();
    expect(afterDeniedWrite.data?.disabled_categories).toEqual(['game_invite']);
  });

  it('denies a displaced token for settings reads and writes (Task 19.1b)', async () => {
    const a = await member();

    const seeded = await admin
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['game_invite'] })
      .select('account_id, disabled_categories')
      .single();
    expect(seeded.error).toBeNull();

    const first = await a.client
      .from('notification_settings')
      .select('account_id, disabled_categories');
    expect(first.error).toBeNull();
    expect(first.data ?? []).toHaveLength(1);

    // auth-login bumps the account epoch and returns a token carrying the new
    // epoch. `a.client` deliberately keeps the original access token, making
    // every probe below a genuine stale-token request.
    const displaced = await callFunction<LoginResponse>(config, 'auth-login', {
      email: a.account.email,
      password: a.account.password,
    });
    expect(displaced.status).toBe(200);
    expect(displaced.body.user.id).toBe(a.id);
    expect(displaced.body.epoch).toBeGreaterThan(0);

    const staleRead = await a.client
      .from('notification_settings')
      .select('account_id, disabled_categories');
    expect(staleRead.error).toBeNull();
    expect(staleRead.data ?? []).toEqual([]);

    const staleInsert = await a.client
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['quiz'] });
    expect(staleInsert.error).not.toBeNull();

    const staleUpdate = await a.client
      .from('notification_settings')
      .update({ disabled_categories: ['quiz'] })
      .select('account_id, disabled_categories');
    expect(staleUpdate.error).not.toBeNull();
    expect(staleUpdate.data ?? []).toEqual([]);

    // Direct writes are not the only bypass to close: sync-write uses the
    // service role, so it must independently reject this stale JWT epoch.
    const staleSync = await callFunction<FunctionErrorResponse>(
      config,
      'sync-write',
      {
        change: settingsChange(a.id, ['quiz'], Date.now() + 1_000),
      },
      a.token,
    );
    expect(staleSync.status).toBe(401);
    expect(staleSync.body.error?.code).toBe('SESSION_SUPERSEDED');

    const afterDisplacement = await admin
      .from('notification_settings')
      .select('account_id, disabled_categories')
      .eq('account_id', a.id)
      .single();
    expect(afterDisplacement.error).toBeNull();
    expect(afterDisplacement.data?.disabled_categories).toEqual(['game_invite']);
  });

  it('disables and re-enables a category through NotificationModule (Req 11.3)', async () => {
    const a = await member();
    await seed(a.id, { category: 'async_turn', dedupe_key: 'turn' });
    await seed(a.id, { category: 'game_invite', dedupe_key: 'invite' });

    const sync = createSyncModule(createSupabaseSyncPorts(a.client));
    sync.observe({ kind: 'network', online: true });
    const notificationPorts = createSupabaseNotificationPorts(a.client);
    // The real Sync Module is the only writer collaborator. Direct table
    // writes are revoked by Task 19.1b's migration.
    const module = createNotificationModule(notificationPorts, {}, undefined, sync);
    const accountId = toAccountId(a.id);

    const disabled = await module.setCategoryEnabled(accountId, 'game_invite', false);
    expect(disabled?.disabledCategories).toEqual(['game_invite']);
    expect((await module.list(accountId)).map((n) => n.category)).toEqual(['async_turn']);

    // A lower HLC is accepted as a sync decision but reported superseded, and
    // must not clobber the canonical disabled-category row.
    const stale = await sync.applyChange(settingsChange(accountId, ['quiz'], 0));
    expect(stale.kind).toBe('applied');
    if (stale.kind === 'applied') expect(stale.applied.superseded).toBe(true);
    const afterStale = await admin
      .from('notification_settings')
      .select('disabled_categories')
      .eq('account_id', a.id)
      .single();
    expect(afterStale.data?.disabled_categories).toEqual(['game_invite']);

    const enabled = await module.setCategoryEnabled(accountId, 'game_invite', true);
    expect(enabled?.disabledCategories).toEqual([]);
    expect((await module.list(accountId)).map((n) => n.category)).toEqual(
      expect.arrayContaining(['async_turn', 'game_invite']),
    );
    expect(await module.list(accountId)).toHaveLength(2);
  });

  it('withholds a notification past the 30-day window (Req 11.4)', async () => {
    const a = await member();
    const inside = await seed(a.id, {
      dedupe_key: 'inside',
      created_at: new Date(Date.now() - NOTIFICATION_RETENTION_MS + 60_000).toISOString(),
    });
    await seed(a.id, {
      dedupe_key: 'outside',
      created_at: new Date(Date.now() - NOTIFICATION_RETENTION_MS - 60_000).toISOString(),
    });

    const module = createNotificationModule(createSupabaseNotificationPorts(a.client));
    // Brackets the window, so a wrong retention constant fails rather than just
    // "old things are hidden". Note the 30-day DISCARD job is task 20.2 and is
    // deferred, so the expired row is still present in the table — the client
    // must not surface it regardless.
    expect((await module.list(toAccountId(a.id))).map((n) => n.id)).toEqual([inside]);
  });

  it('retains an undelivered notification for an offline recipient (Req 11.4)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    // B is signed OUT when the invite is sent, so nothing can be pushed to them.
    await b.client.auth.signOut();

    const invited = await callFunction<{ session: { id: string } }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );
    expect(invited.status).toBe(201);

    // On their next session the notification is waiting — the durable row is what
    // makes Req 11.4 hold, independent of Realtime.
    const reborn = await signIn(config, b.account);
    const module = createNotificationModule(createSupabaseNotificationPorts(reborn));
    const listed = await module.list(toAccountId(b.id));
    expect(
      listed.some(
        (n) => (n.payload as { sessionId?: string })?.sessionId === invited.body.session.id,
      ),
    ).toBe(true);
  });
});
