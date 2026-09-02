import type { SupabaseClient } from '@supabase/supabase-js';

import { accountId as toAccountId } from '../domain/common.js';
import type { Notification } from '../domain/notification.js';
import { NOTIFICATION_RETENTION_MS } from '../domain/notification-delivery.js';
import { createNotificationModule } from '../notifications/notification-module.js';
import { createSupabaseNotificationPorts } from '../notifications/supabase-ports.js';
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
  // Req 11.3 / 11.4 — settings and retention against real rows
  // -------------------------------------------------------------------------
  it('withholds a disabled category (Req 11.3)', async () => {
    const a = await member();
    await seed(a.id, { category: 'async_turn', dedupe_key: 'turn' });
    await seed(a.id, { category: 'game_invite', dedupe_key: 'invite' });

    // The settings WRITE path is task 19.1b; the row is seeded here so the READ
    // path's filtering is exercised now rather than being bolted on later.
    const { error } = await admin
      .from('notification_settings')
      .insert({ account_id: a.id, disabled_categories: ['game_invite'] });
    expect(error).toBeNull();

    const module = createNotificationModule(createSupabaseNotificationPorts(a.client));
    const listed = await module.list(toAccountId(a.id));
    expect(listed.map((n) => n.category)).toEqual(['async_turn']);
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
