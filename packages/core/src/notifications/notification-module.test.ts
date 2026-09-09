import { describe, expect, it } from 'vitest';

import { accountId as toAccountId } from '../domain/common.js';
import { NOTIFICATION_RETENTION_MS } from '../domain/notification-delivery.js';
import type { Notification, NotificationSettings } from '../domain/notification.js';
import type { DataChange } from '../domain/sync.js';
import { createLocalStore, type LocalStore } from '../store/local-store.js';
import type { ApplyOutcome } from '../sync/sync-module.js';
import {
  createNotificationModule,
  defaultNotificationSettings,
  notificationFromRow,
  type NotificationSettingsSync,
  type NotificationPorts,
  type NotificationRow,
} from './notification-module.js';

// Unit tests for the client notification module (Req 11.1, 11.2, 11.3, 11.4, 11.6).
//
// Stub ports rather than a Supabase client: the module exists to decide what is
// ELIGIBLE to present and to make acknowledgement stick, and those decisions are
// what is worth pinning down. Realtime delivery latency is an integration concern.

const ALICE = toAccountId('11111111-1111-4111-8111-111111111111');
const BOB = toAccountId('22222222-2222-4222-8222-222222222222');
const NOW = 1_700_000_000_000;

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    recipient_account_id: ALICE,
    category: 'async_turn',
    payload: { kind: 'your_turn' },
    created_at: new Date(NOW - 1_000).toISOString(),
    dedupe_key: 'k-1',
    acknowledged_at: null,
    delivered_at: null,
    ...overrides,
  };
}

function harness(
  options: {
    rows?: NotificationRow[];
    settings?: NotificationSettings | null;
    store?: LocalStore;
    applyChange?: (change: DataChange) => Promise<ApplyOutcome>;
  } = {},
) {
  let clock = NOW;
  const rows = options.rows ?? [];
  const acknowledged: { id: string; at: number }[] = [];
  const changes: DataChange[] = [];
  let currentSettings = options.settings ?? null;
  let insertHandler: ((r: NotificationRow) => void) | null = null;
  let unsubscribes = 0;

  const ports: NotificationPorts = {
    subscribeRecipient: (_accountId, handlers) => {
      insertHandler = handlers.onInsert;
      return () => {
        unsubscribes += 1;
      };
    },
    fetchAll: async () => rows,
    fetchSettings: async () => currentSettings,
    acknowledge: async (id, at) => {
      const target = rows.find((r) => r.id === id);
      // Mirrors the adapter's `is('acknowledged_at', null)` guard: a second
      // acknowledge matches no row.
      if (target === undefined || target.acknowledged_at !== null) return null;
      acknowledged.push({ id, at });
      const iso = new Date(at).toISOString();
      const updated = { ...target, acknowledged_at: iso, delivered_at: iso };
      rows[rows.indexOf(target)] = updated;
      return updated;
    },
    now: () => clock,
  };

  const eligibleArrivals: Notification[] = [];
  const allArrivals: Notification[] = [];
  const settingsSync: NotificationSettingsSync = {
    applyChange: async (change) => {
      changes.push(change);
      const outcome = await (options.applyChange?.(change) ??
        Promise.resolve({
          kind: 'applied' as const,
          applied: { change, appliedAt: clock, superseded: false },
        }));
      // Applied settings are visible to a later fetch; a queued change is not,
      // which models the actual sync queue's offline behaviour.
      if (outcome.kind === 'applied' && !outcome.applied.superseded) {
        const payload = change.payload as {
          disabled_categories: NotificationSettings['disabledCategories'];
        };
        currentSettings = {
          ...(currentSettings ?? { accountId: change.originAccountId }),
          accountId: change.originAccountId,
          disabledCategories: payload.disabled_categories,
        };
      }
      return outcome;
    },
  };
  const module = createNotificationModule(
    ports,
    {
      onNotification: (n) => eligibleArrivals.push(n),
      onAnyNotification: (n) => allArrivals.push(n),
    },
    options.store,
    settingsSync,
  );

  return {
    module,
    rows,
    acknowledged,
    changes,
    ports,
    settingsSync,
    setSettings: (next: NotificationSettings | null) => {
      currentSettings = next;
    },
    eligibleArrivals,
    allArrivals,
    emit: (r: NotificationRow) => insertHandler?.(r),
    advance: (ms: number) => {
      clock += ms;
    },
    unsubscribes: () => unsubscribes,
  };
}

describe('notificationFromRow', () => {
  it('converts ISO timestamps to epoch milliseconds', () => {
    const created = NOW - 5_000;
    const acked = NOW - 1_000;
    const mapped = notificationFromRow(
      row({
        created_at: new Date(created).toISOString(),
        acknowledged_at: new Date(acked).toISOString(),
        delivered_at: new Date(acked).toISOString(),
      }),
    );
    // Every retention and eligibility decision downstream depends on this.
    expect(mapped.createdAt).toBe(created);
    expect(mapped.acknowledgedAt).toBe(acked);
    expect(mapped.deliveredAt).toBe(acked);
  });

  it('maps a never-acknowledged row to null rather than 0', () => {
    const mapped = notificationFromRow(row({ acknowledged_at: null, delivered_at: null }));
    // `shouldDeliver` tests `acknowledgedAt === null`, so a 0 here would read as
    // "acknowledged at the epoch" and silently withhold the notification.
    expect(mapped.acknowledgedAt).toBeNull();
    expect(mapped.deliveredAt).toBeNull();
  });
});

describe('defaultNotificationSettings', () => {
  it('disables nothing', () => {
    // A user who has never opened settings must still get their notifications.
    expect(defaultNotificationSettings(ALICE).disabledCategories).toEqual([]);
  });
});

describe('Notification module — list eligibility', () => {
  it('presents an unacknowledged, in-window notification (Req 11.1, 11.2)', async () => {
    const h = harness({ rows: [row()] });
    expect(await h.module.list(ALICE)).toHaveLength(1);
    expect(await h.module.unreadCount(ALICE)).toBe(1);
  });

  it('withholds an acknowledged notification (Req 11.6)', async () => {
    const h = harness({
      rows: [row({ acknowledged_at: new Date(NOW - 500).toISOString() })],
    });
    expect(await h.module.list(ALICE)).toHaveLength(0);
  });

  it('withholds a notification past the 30-day retention window (Req 11.4, 11.5)', async () => {
    const h = harness({
      rows: [
        // One second inside the window.
        row({ created_at: new Date(NOW - NOTIFICATION_RETENTION_MS + 1_000).toISOString() }),
        // One second past it.
        row({ created_at: new Date(NOW - NOTIFICATION_RETENTION_MS - 1_000).toISOString() }),
      ],
    });
    // Brackets the window, so this would fail against a wrong retention constant
    // rather than merely "old things are hidden".
    const listed = await h.module.list(ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.createdAt).toBe(NOW - NOTIFICATION_RETENTION_MS + 1_000);
  });

  it('withholds a disabled category (Req 11.3)', async () => {
    const h = harness({
      rows: [row({ category: 'async_turn' }), row({ category: 'game_invite' })],
      settings: { accountId: ALICE, disabledCategories: ['game_invite'] },
    });
    const listed = await h.module.list(ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.category).toBe('async_turn');
  });

  it('presents everything when the account has no settings row', async () => {
    const h = harness({
      rows: [row({ category: 'async_turn' }), row({ category: 'game_invite' })],
      settings: null,
    });
    expect(await h.module.list(ALICE)).toHaveLength(2);
  });

  it('orders newest first', async () => {
    const h = harness({
      rows: [
        row({ id: 'old', created_at: new Date(NOW - 10_000).toISOString() }),
        row({ id: 'new', created_at: new Date(NOW - 1_000).toISOString() }),
        row({ id: 'mid', created_at: new Date(NOW - 5_000).toISOString() }),
      ],
    });
    expect((await h.module.list(ALICE)).map((n) => n.id)).toEqual(['new', 'mid', 'old']);
  });

  it('re-reads settings on each list so a fresh mute takes effect', async () => {
    // A cached settings snapshot would keep delivering a category the user just
    // muted, which is why settings are not cached across calls.
    let disabled: NotificationSettings['disabledCategories'] = [];
    const ports: NotificationPorts = {
      subscribeRecipient: () => () => undefined,
      fetchAll: async () => [row({ category: 'game_invite' })],
      fetchSettings: async () => ({ accountId: ALICE, disabledCategories: disabled }),
      acknowledge: async () => null,
      now: () => NOW,
    };
    const module = createNotificationModule(ports);

    expect(await module.list(ALICE)).toHaveLength(1);
    disabled = ['game_invite'];
    expect(await module.list(ALICE)).toHaveLength(0);
  });
});

describe('Notification module — category settings writes', () => {
  it('persists a native APNs registration without changing category preferences', async () => {
    const h = harness({
      settings: { accountId: ALICE, disabledCategories: ['quiz'] },
    });

    await expect(
      h.module.setApnsDeviceToken(ALICE, 'a'.repeat(64), 'development'),
    ).resolves.toEqual({
      accountId: ALICE,
      disabledCategories: ['quiz'],
      apnsDeviceToken: 'a'.repeat(64),
      apnsEnvironment: 'development',
    });
    expect(h.changes[0]).toMatchObject({
      itemType: 'notification_settings',
      itemId: ALICE,
      payload: {
        apns_device_token: 'a'.repeat(64),
        apns_environment: 'development',
      },
      originAccountId: ALICE,
    });
  });

  it('clears a native APNs registration with an explicit null write', async () => {
    const h = harness({
      settings: {
        accountId: ALICE,
        disabledCategories: [],
        apnsDeviceToken: 'b'.repeat(64),
        apnsEnvironment: 'production',
      },
    });

    await expect(h.module.setApnsDeviceToken(ALICE, null, null)).resolves.toEqual({
      accountId: ALICE,
      disabledCategories: [],
    });
    expect(h.changes[0]?.payload).toEqual({
      apns_device_token: null,
      apns_environment: null,
    });
  });

  it('submits a complete canonical sync change while preserving unrelated categories', async () => {
    const h = harness({
      settings: { accountId: ALICE, disabledCategories: ['quiz', 'pairing'] },
    });

    const disabled = await h.module.setCategoryEnabled(ALICE, 'async_turn', false);
    expect(disabled?.disabledCategories).toEqual(['pairing', 'async_turn', 'quiz']);
    expect(h.changes[0]).toMatchObject({
      itemType: 'notification_settings',
      itemId: ALICE,
      originAccountId: ALICE,
      payload: { disabled_categories: ['pairing', 'async_turn', 'quiz'] },
    });

    const enabled = await h.module.setCategoryEnabled(ALICE, 'quiz', true);
    expect(enabled?.disabledCategories).toEqual(['pairing', 'async_turn']);
    // The sync item always carries the whole durable preference set, never an
    // ambiguous single-toggle patch.
    expect(h.changes.map((change) => change.payload)).toEqual([
      { disabled_categories: ['pairing', 'async_turn', 'quiz'] },
      { disabled_categories: ['pairing', 'async_turn'] },
    ]);
  });

  it('is idempotent for an already-disabled or already-enabled category', async () => {
    const h = harness({
      settings: { accountId: ALICE, disabledCategories: ['pairing', 'quiz'] },
    });

    await h.module.setCategoryEnabled(ALICE, 'quiz', false);
    await h.module.setCategoryEnabled(ALICE, 'system', true);

    expect(h.changes.map((change) => change.payload)).toEqual(
      [
        ['pairing', 'quiz'],
        ['pairing', 'quiz'],
      ].map((disabled_categories) => ({ disabled_categories })),
    );
  });

  it('reads current settings for each write instead of overwriting a newer session', async () => {
    const h = harness({ settings: { accountId: ALICE, disabledCategories: [] } });
    // Populate the module's snapshot first, then simulate another session
    // muting quiz before this device changes a different switch.
    await h.module.list(ALICE);
    h.setSettings({ accountId: ALICE, disabledCategories: ['quiz'] });

    await h.module.setCategoryEnabled(ALICE, 'pairing', false);

    expect(h.changes[0]?.payload).toEqual({ disabled_categories: ['pairing', 'quiz'] });
  });

  it('generates independent monotonic HLC streams per account', async () => {
    const h = harness();
    await h.module.setCategoryEnabled(ALICE, 'quiz', false);
    await h.module.setCategoryEnabled(BOB, 'system', false);
    await h.module.setCategoryEnabled(ALICE, 'system', false);

    expect(h.changes.map((change) => change.hlc)).toEqual([
      { physical: NOW, counter: 0, originAccountId: ALICE },
      { physical: NOW, counter: 0, originAccountId: BOB },
      { physical: NOW, counter: 1, originAccountId: ALICE },
    ]);
  });

  it('changes cached and live eligibility immediately after a successful write', async () => {
    const store = createLocalStore();
    const h = harness({ rows: [row({ category: 'quiz' })], store });
    await h.module.list(ALICE);
    expect(h.module.cached(ALICE)).toHaveLength(1);

    await h.module.setCategoryEnabled(ALICE, 'quiz', false);
    expect(h.module.cached(ALICE)).toHaveLength(0);

    h.module.subscribe(ALICE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit(row({ id: 'muted-live', category: 'quiz' }));
    expect(h.eligibleArrivals).toHaveLength(0);
  });

  it('updates cache filtering immediately when an offline change is queued', async () => {
    const store = createLocalStore();
    const h = harness({
      rows: [row({ category: 'quiz' })],
      store,
      applyChange: async () => ({ kind: 'queued', queuedCount: 1 }),
    });
    await h.module.list(ALICE);
    await h.module.setCategoryEnabled(ALICE, 'quiz', false);

    expect(h.module.cached(ALICE)).toHaveLength(0);
    expect(store.get<NotificationSettings>('notification_settings', ALICE)).toEqual({
      accountId: ALICE,
      disabledCategories: ['quiz'],
    });

    const revived = createLocalStore();
    revived.hydrate(store.snapshot());
    const afterRestart = createNotificationModule(h.ports, {}, revived);
    // A cold, offline shell has no settings fetch to wait for: the persisted
    // preference still filters the cached notification immediately.
    expect(afterRestart.cached(ALICE)).toHaveLength(0);
  });

  it('refetches the authoritative settings when the sync write is superseded', async () => {
    let reads = 0;
    const ports: NotificationPorts = {
      subscribeRecipient: () => () => undefined,
      fetchAll: async () => [],
      fetchSettings: async () => {
        reads += 1;
        return reads === 1
          ? { accountId: ALICE, disabledCategories: [] }
          : { accountId: ALICE, disabledCategories: ['system'] };
      },
      acknowledge: async () => null,
      now: () => NOW,
    };
    const change: DataChange = {
      itemType: 'notification_settings',
      itemId: ALICE,
      payload: { disabled_categories: ['quiz'] },
      originAccountId: ALICE,
      hlc: { physical: NOW, counter: 0, originAccountId: ALICE },
    };
    const module = createNotificationModule(ports, {}, undefined, {
      applyChange: async () => ({
        kind: 'applied',
        applied: { change, appliedAt: NOW, superseded: true },
      }),
    });

    await expect(module.setCategoryEnabled(ALICE, 'quiz', false)).resolves.toEqual({
      accountId: ALICE,
      disabledCategories: ['system'],
    });
    expect(reads).toBe(2);
  });

  it('leaves the active cache and live filter unchanged when sync rejects', async () => {
    const store = createLocalStore();
    const h = harness({
      rows: [row({ category: 'quiz' })],
      store,
      applyChange: async () => {
        throw new Error('temporary write failure');
      },
    });
    await h.module.list(ALICE);
    expect(await h.module.setCategoryEnabled(ALICE, 'quiz', false)).toBeNull();
    expect(h.module.cached(ALICE)).toHaveLength(1);

    h.module.subscribe(ALICE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit(row({ id: 'still-live', category: 'quiz' }));
    expect(h.eligibleArrivals.map((notification) => notification.id)).toEqual(['still-live']);
  });

  it('returns null without changing preferences when no sync collaborator was injected', async () => {
    const store = createLocalStore();
    const h = harness({ rows: [row({ category: 'quiz' })], store });
    await h.module.list(ALICE);
    const withoutSync = createNotificationModule(h.ports, {}, store);

    await expect(withoutSync.setCategoryEnabled(ALICE, 'quiz', false)).resolves.toBeNull();
    expect(withoutSync.cached(ALICE)).toHaveLength(1);
    expect(h.changes).toHaveLength(0);
  });
});

describe('Notification module — acknowledgement (Req 11.6)', () => {
  it('marks acknowledged and delivered together', async () => {
    const target = row({ id: 'ack-me' });
    const h = harness({ rows: [target] });

    const result = await h.module.acknowledge(target.id as never);
    expect(result).not.toBeNull();
    // Req 11.6: acknowledging marks it delivered. Splitting the two would leave a
    // window where a notification is acknowledged but still counted undelivered.
    expect(result?.acknowledgedAt).toBe(NOW);
    expect(result?.deliveredAt).toBe(NOW);
  });

  it('withholds an acknowledged notification from subsequent sessions', async () => {
    const target = row({ id: 'ack-me' });
    const h = harness({ rows: [target] });

    expect(await h.module.list(ALICE)).toHaveLength(1);
    await h.module.acknowledge(target.id as never);
    // "subsequent Authenticated_Sessions" — the row is durably marked, so a later
    // read excludes it rather than relying on client memory.
    expect(await h.module.list(ALICE)).toHaveLength(0);
  });

  it('is idempotent — a second acknowledge does not move the timestamp', async () => {
    const target = row({ id: 'ack-me' });
    const h = harness({ rows: [target] });

    const first = await h.module.acknowledge(target.id as never);
    h.advance(60_000);
    const second = await h.module.acknowledge(target.id as never);

    expect(first?.acknowledgedAt).toBe(NOW);
    // Null rather than a re-stamped row, so a retry cannot rewrite history.
    expect(second).toBeNull();
    expect(h.acknowledged).toHaveLength(1);
  });

  it('returns null for an id that is not the caller’s', async () => {
    const h = harness({ rows: [] });
    // RLS is what actually enforces this; the module must surface the refusal as
    // null rather than throwing.
    expect(await h.module.acknowledge('someone-elses' as never)).toBeNull();
  });

  it('acknowledgeAll clears exactly the eligible ones', async () => {
    const h = harness({
      rows: [
        row({ id: 'a' }),
        row({ id: 'b' }),
        // Already acknowledged, so not eligible and not re-acknowledged.
        row({ id: 'c', acknowledged_at: new Date(NOW - 100).toISOString() }),
        // Disabled category.
        row({ id: 'd', category: 'quiz' }),
      ],
      settings: { accountId: ALICE, disabledCategories: ['quiz'] },
    });

    expect(await h.module.acknowledgeAll(ALICE)).toBe(2);
    expect(h.acknowledged.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(await h.module.unreadCount(ALICE)).toBe(0);
  });
});

describe('Notification module — live arrivals (Req 11.1, 11.2)', () => {
  it('forwards an eligible arrival to onNotification', async () => {
    const h = harness({ rows: [] });
    h.module.subscribe(ALICE);
    // Let the settings warm-up settle so filtering is in place.
    await new Promise((r) => setTimeout(r, 0));

    const incoming = row({ id: 'live' });
    h.emit(incoming);

    expect(h.eligibleArrivals.map((n) => n.id)).toEqual(['live']);
    expect(h.allArrivals.map((n) => n.id)).toEqual(['live']);
  });

  it('reports a disabled-category arrival only on onAnyNotification (Req 11.3)', async () => {
    const h = harness({
      rows: [],
      settings: { accountId: ALICE, disabledCategories: ['game_invite'] },
    });
    h.module.subscribe(ALICE);
    await new Promise((r) => setTimeout(r, 0));

    h.emit(row({ id: 'muted', category: 'game_invite' }));

    // Withheld from presentation, but still observable for diagnostics.
    expect(h.eligibleArrivals).toHaveLength(0);
    expect(h.allArrivals.map((n) => n.id)).toEqual(['muted']);
  });

  it('replaces an existing subscription rather than leaking it', () => {
    const h = harness({ rows: [] });
    h.module.subscribe(ALICE);
    expect(h.unsubscribes()).toBe(0);

    // Re-subscribing (e.g. after signing in as a different account) must tear the
    // old channel down, or the previous account's rows could keep arriving.
    h.module.subscribe(ALICE);
    expect(h.unsubscribes()).toBe(1);

    h.module.unsubscribe();
    expect(h.unsubscribes()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Local Store backing (task 21.2)
// ---------------------------------------------------------------------------

describe('notification reads over the Local Store (Req 5.1)', () => {
  it('reads notifications synchronously after a list, with no network', async () => {
    const store = createLocalStore();
    const h = harness({ rows: [row(), row()], store });
    await h.module.list(ALICE);

    // No await: the badge and the list render on the frame the screen mounts,
    // and keep rendering when the device is offline.
    expect(h.module.cached(ALICE)).toHaveLength(2);
  });

  it('caches a live arrival, so a badge updates without a refetch (Req 11.1)', () => {
    const store = createLocalStore();
    const h = harness({ rows: [], store });
    h.module.subscribe(ALICE);
    h.emit(row({ id: 'live-1' }));
    expect(h.module.cached(ALICE).map((n) => n.id)).toEqual(['live-1']);
  });

  it('drops an acknowledged notification from the cached read (Req 11.6)', async () => {
    const store = createLocalStore();
    const target = row({ id: 'ack-me' });
    const h = harness({ rows: [target, row({ id: 'keep' })], store });
    await h.module.list(ALICE);

    await h.module.acknowledge(target.id as never);

    expect(h.module.cached(ALICE).map((n) => n.id)).toEqual(['keep']);
  });

  it('does not resurrect an acknowledged notification from a stale fetch (Req 11.6)', async () => {
    // The race: `list` reads the rows, the user dismisses one, and only then does
    // the in-flight read resolve carrying the pre-dismissal copy. Applying it
    // would put the notification back on screen after the user cleared it.
    const store = createLocalStore();
    const target = row({ id: 'ack-me' });
    const h = harness({ rows: [target], store });
    await h.module.list(ALICE);
    await h.module.acknowledge(target.id as never);

    // Replay the stale, still-unacknowledged copy exactly as a late read would.
    store.put('notification', target.id, notificationFromRow(target), 0);

    expect(h.module.cached(ALICE)).toHaveLength(0);
  });

  it('withholds a muted category from the cached read (Req 11.3)', async () => {
    const store = createLocalStore();
    const h = harness({
      rows: [row({ category: 'async_turn' }), row({ category: 'game_invite' })],
      store,
      settings: { accountId: ALICE, disabledCategories: ['async_turn'] },
    });
    await h.module.list(ALICE);
    // Settings were learned on the last online read; the offline path honours
    // them rather than falling back to "deliver everything".
    expect(h.module.cached(ALICE).map((n) => n.category)).toEqual(['game_invite']);
  });

  it('withholds a notification past the retention window (Req 11.4)', async () => {
    const store = createLocalStore();
    const h = harness({ rows: [row({ id: 'old' })], store });
    await h.module.list(ALICE);
    expect(h.module.cached(ALICE)).toHaveLength(1);

    h.advance(NOTIFICATION_RETENTION_MS + 1);
    // The discard job is task 20.2 and deferred, so the row is still cached; the
    // read has to age it out itself.
    expect(h.module.cached(ALICE)).toHaveLength(0);
  });

  it("never returns another account's notifications", async () => {
    const store = createLocalStore();
    const other = toAccountId('99999999-9999-4999-8999-999999999999');
    const h = harness({ rows: [row({ id: 'mine' })], store });
    await h.module.list(ALICE);
    // A hydrated snapshot could outlive a sign-out; the recipient filter is the
    // backstop that keeps it from surfacing.
    store.put('notification', 'theirs', {
      ...notificationFromRow(row({ id: 'theirs' })),
      recipientAccountId: other,
    });

    expect(h.module.cached(ALICE).map((n) => n.id)).toEqual(['mine']);
  });

  it('notifies cache subscribers so a badge re-renders', () => {
    const store = createLocalStore();
    const h = harness({ rows: [], store });
    let notified = 0;
    h.module.subscribeCache(() => {
      notified += 1;
    });
    h.module.subscribe(ALICE);
    h.emit(row());
    expect(notified).toBe(1);
  });

  it('reads empty and subscribes harmlessly when no store is provided', () => {
    // The store is optional so 19.1a's existing composition keeps working
    // unchanged; a caller without one simply has no offline read.
    const h = harness({ rows: [row()] });
    expect(h.module.cached(ALICE)).toEqual([]);
    expect(() => h.module.subscribeCache(() => undefined)()).not.toThrow();
  });
});
