import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

import { accountId as toAccountId, pairingId as toPairingId } from '../domain/common.js';
import type { AppliedChange, DataChange, HLCTimestamp } from '../domain/sync.js';
import { createSyncModule, type RemoteChange } from '../sync/sync-module.js';
import { createSupabaseSyncPorts } from '../sync/supabase-ports.js';
import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for the sync path (task 14.3): the `sync-write` Edge Function
// (14.1) plus the client Sync Module and Postgres Changes subscription (14.2).
//
//   Req 5.3       a partner receives a committed change within 5 seconds
//   Req 5.5       a drained offline queue is synchronized within 10 seconds,
//                 with conflicts resolved last-write-wins SERVER-side
//   Property 16   a committed change is present in a NEW session
//                 (Req 5.2 — durability across sessions)
//
// These assert the things the unit tests deliberately cannot: real Realtime
// delivery and latency, and real HLC conflict resolution in Postgres.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** Req 5.3 budget. */
const PROPAGATION_BUDGET_MS = 5_000;
/** Req 5.5 budget. */
const DRAIN_BUDGET_MS = 10_000;
/** Headroom for a subscription to become SUBSCRIBED before we measure. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;

interface SyncWriteResponse {
  readonly results: readonly AppliedChange[];
}

describe.skipIf(cfg === null)('Sync path (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  /** A test account with credentials, an access token and an RLS-scoped client. */
  async function member(): Promise<{
    account: TestAccount;
    token: string;
    client: SupabaseClient;
  }> {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, token, client };
  }

  /** Pairs two accounts through the real invitation flow. */
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

  function hlc(physical: number, origin: string, counter = 0): HLCTimestamp {
    return { physical, counter, originAccountId: toAccountId(origin) };
  }

  function dateChange(
    itemId: string,
    origin: string,
    physical: number,
    payload: Record<string, unknown>,
  ): DataChange {
    return {
      itemId,
      itemType: 'relationship_date',
      payload,
      hlc: hlc(physical, origin),
      originAccountId: toAccountId(origin),
    };
  }

  /** POST straight to the write path, asserting a 200. */
  async function write(
    token: string,
    body: unknown,
  ): Promise<readonly AppliedChange[]> {
    const res = await callFunction<SyncWriteResponse>(config, 'sync-write', body, token);
    expect(res.status).toBe(200);
    return res.body.results;
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
  // Req 5.3 — a partner receives a committed change within 5 seconds
  // -------------------------------------------------------------------------
  it("delivers a partner's committed change within 5 seconds (Req 5.3)", async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);

    // B subscribes through the real client Sync Module, exactly as a shell would.
    const received: RemoteChange[] = [];
    const partner = createSyncModule(createSupabaseSyncPorts(b.client), {
      onRemoteChange: (change) => received.push(change),
    });

    const online = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('subscription never reached SUBSCRIBED')),
        SUBSCRIBE_TIMEOUT_MS,
      );
      const poll = setInterval(() => {
        if (partner.connectivity().status === 'online') {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });

    partner.subscribe(toPairingId(pairing));
    await online;

    // The connectivity indicator must be hidden once subscribed (Req 5.4).
    expect(partner.connectivity().indicatorVisible).toBe(false);

    // WARM-UP, outside the budget. `SUBSCRIBED` means the channel is joined, but
    // the first event still pays whatever one-off cost Realtime has in attaching
    // the binding. Req 5.3 is about propagating a change to an ESTABLISHED
    // session, so folding attachment cost into the measurement would be measuring
    // the wrong thing. This proves the pipe is live before the clock starts.
    await write(a.token, {
      change: dateChange(randomUUID(), a.account.id, 500, {
        title: 'Warm-up',
        date: '2019-01-01',
      }),
    });
    const warmDeadline = Date.now() + 20_000;
    while (received.length === 0 && Date.now() < warmDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length, 'the subscription never delivered a warm-up event').toBeGreaterThan(0);
    received.length = 0;

    // Now measure a real partner change on a proven-live subscription.
    const itemId = randomUUID();
    const started = Date.now();
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 1_000, {
        title: 'Anniversary',
        date: '2020-06-15',
      }),
    });

    while (received.length === 0 && Date.now() - started < PROPAGATION_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = Date.now() - started;

    expect(received.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(PROPAGATION_BUDGET_MS);
    expect(received[0]?.table).toBe('relationship_dates');
    expect(received[0]?.row.id).toBe(itemId);

    partner.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // Req 5.5 — offline queue drains within 10s, conflicts resolved server-side
  // -------------------------------------------------------------------------
  it('drains a queued offline batch within 10 seconds (Req 5.5)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    // Drive the real Sync Module while "offline" so changes queue, then bring it
    // online and let the reconnect drain run against the live write path.
    const ports = createSupabaseSyncPorts(a.client);
    const drains: { remaining: number; durationMs: number; withinBudget: boolean }[] = [];
    const module = createSyncModule(ports, {
      onDrain: (o) =>
        drains.push({
          remaining: o.remaining,
          durationMs: o.durationMs,
          withinBudget: o.withinBudget,
        }),
    });

    // Never subscribed => offline => every change is retained (Req 5.4).
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const outcome = await module.applyChange(
        dateChange(id, a.account.id, 1_000 + index, {
          title: `Queued ${index}`,
          date: '2021-02-02',
        }),
      );
      expect(outcome.kind).toBe('queued');
    }
    expect(module.pendingCount()).toBe(3);
    expect(module.connectivity().indicatorVisible).toBe(true);

    // Reconnect: drain explicitly so the assertion is deterministic rather than
    // racing the channel's SUBSCRIBED callback.
    const started = Date.now();
    const outcome = await module.drainQueue();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(DRAIN_BUDGET_MS);
    expect(outcome.withinBudget).toBe(true);
    expect(outcome.applied).toHaveLength(3);
    expect(outcome.remaining).toBe(0);
    expect(module.pendingCount()).toBe(0);

    // Every queued change actually landed in Postgres.
    const { data, error } = await admin
      .from('relationship_dates')
      .select('id, title')
      .in('id', ids);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(3);
  });

  it('resolves a stale queued write server-side without clobbering (Req 5.5, 5.6)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const itemId = randomUUID();

    // Baseline, then a NEWER value lands while the client was offline.
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 1_000, { title: 'Original', date: '2020-01-01' }),
    });
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 5_000, { title: 'Newer' }),
    });

    // The offline client now drains a change stamped EARLIER than the stored one.
    const stale = await write(a.token, {
      change: dateChange(itemId, a.account.id, 2_000, { title: 'Stale offline edit' }),
    });

    // Reported as superseded rather than erroring — conflicting edits converge,
    // they do not fail (design.md: "simultaneous conflicting edits never error").
    expect(stale).toHaveLength(1);
    expect(stale[0]?.superseded).toBe(true);

    // And the stored value is untouched: last-write-wins kept the newer title.
    const { data } = await admin
      .from('relationship_dates')
      .select('title')
      .eq('id', itemId)
      .single();
    expect(data?.title).toBe('Newer');
  });

  it('applies a drained batch oldest-HLC-first so the newest change wins (Req 5.5)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const itemId = randomUUID();
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 1_000, { title: 'Base', date: '2020-01-01' }),
    });

    // A drained queue containing three edits to the SAME item, deliberately
    // submitted newest-first. Order of submission must not decide the winner —
    // the HLC does.
    const results = await write(a.token, {
      changes: [
        dateChange(itemId, a.account.id, 9_000, { title: 'Newest' }),
        dateChange(itemId, a.account.id, 3_000, { title: 'Middle' }),
        dateChange(itemId, a.account.id, 2_000, { title: 'Oldest' }),
      ],
    });
    expect(results).toHaveLength(3);

    const { data } = await admin
      .from('relationship_dates')
      .select('title')
      .eq('id', itemId)
      .single();
    expect(data?.title).toBe('Newest');
  });

  it('treats a replayed queue entry as a no-op (Req 5.5)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const itemId = randomUUID();
    const change = dateChange(itemId, a.account.id, 4_000, {
      title: 'Once',
      date: '2020-03-03',
    });

    const first = await write(a.token, { change });
    expect(first[0]?.superseded).toBe(false);

    // A retry after a flaky connection re-submits the identical change. An equal
    // HLC keeps the stored value, so the replay is harmless.
    const replay = await write(a.token, { change });
    expect(replay[0]?.superseded).toBe(true);

    const { data } = await admin
      .from('relationship_dates')
      .select('title')
      .eq('id', itemId);
    expect(data ?? []).toHaveLength(1);
    expect(data?.[0]?.title).toBe('Once');
  });

  // -------------------------------------------------------------------------
  // Property 16 — a committed change survives across sessions (Req 5.2)
  // -------------------------------------------------------------------------
  // Feature: ldr-companion-app, Property 16: For any change to shared data
  // committed during a session, ending that session and establishing a new
  // session returns state that includes the committed change.
  it('returns a committed change in a brand-new session (Property 16)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const itemId = randomUUID();
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 7_000, {
        title: 'Survives',
        date: '2024-04-04',
      }),
    });

    // End the session. A fresh sign-in is a genuinely new session: new epoch,
    // new token, new client instance with no cached state.
    await a.client.auth.signOut();

    const reborn = await signIn(config, a.account);
    const { data, error } = await reborn
      .from('relationship_dates')
      .select('id, title')
      .eq('id', itemId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    expect(data?.[0]?.title).toBe('Survives');

    // The partner's new session sees it too — it is shared data, not per-client
    // state (Req 5.1).
    const partnerSession = await signIn(config, b.account);
    const partnerView = await partnerSession
      .from('relationship_dates')
      .select('id, title')
      .eq('id', itemId);
    expect(partnerView.error).toBeNull();
    expect(partnerView.data?.[0]?.title).toBe('Survives');
  });

  // -------------------------------------------------------------------------
  // Req 9.3 / 10.4 regression guard: DELETE must survive the pairing filter
  // -------------------------------------------------------------------------
  it('delivers a DELETE to the partner, not just INSERT/UPDATE (Req 9.3)', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);

    const events: RemoteChange[] = [];
    const partner = createSyncModule(createSupabaseSyncPorts(b.client), {
      onRemoteChange: (change) => events.push(change),
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never subscribed')), SUBSCRIBE_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (partner.connectivity().status === 'online') {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 25);
      partner.subscribe(toPairingId(pairing));
    });

    const itemId = randomUUID();
    await write(a.token, {
      change: dateChange(itemId, a.account.id, 1_000, { title: 'Doomed', date: '2020-09-09' }),
    });

    const waitFor = async (event: RemoteChange['event']) => {
      const start = Date.now();
      while (
        !events.some((e) => e.event === event) &&
        Date.now() - start < PROPAGATION_BUDGET_MS
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return events.some((e) => e.event === event);
    };

    expect(await waitFor('INSERT')).toBe(true);

    // This is the case that silently failed before migration 20260901000002:
    // under the default replica identity the DELETE's old row carries only the
    // primary key, so `pairing_id=eq.{id}` cannot match and the event is dropped.
    await admin.from('relationship_dates').delete().eq('id', itemId);
    expect(await waitFor('DELETE')).toBe(true);

    partner.unsubscribe();
  });
});
