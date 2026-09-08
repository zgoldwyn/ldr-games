/**
 * Client notification module: in-app reads and acknowledgement
 * (Requirements 11.1, 11.2, 11.3, 11.4, 11.6).
 *
 * The server side already exists and is already writing rows — the pairing,
 * real-time game, asynchronous turn and cron paths all insert into
 * `notifications` with `delivered_at` NULL. Nothing read them, which is why this
 * module is on the MVP path rather than deferred: an asynchronous game where you
 * cannot tell it is your turn is not usable.
 *
 * There is no Edge Function here, and deliberately so. `notifications` is
 * recipient-scoped by RLS (`recipient_account_id = auth.uid()` plus the epoch
 * guard) and `authenticated` holds SELECT and UPDATE on it, so a client reads and
 * acknowledges its OWN rows directly. Routing that through a function would add a
 * hop without adding a check the database is not already making.
 *
 * WHAT IS DEFERRED. Out-of-app push (task 19.2) is not here. Category filtering
 * and preference writes ARE here, because
 * `shouldDeliver` already exists and the settings table is already readable —
 * honouring a disabled category costs one query, whereas bolting the filter on
 * afterwards would mean revisiting every read path (Req 11.3).
 *
 * Collaborators are injected as narrow ports, matching `sync/sync-module.ts`, so
 * the eligibility and acknowledgement logic is unit-testable without a stack and
 * task 21.3 can compose this into the Connection Manager.
 */
import type { AccountId, NotificationId, Timestamp } from '../domain/common.js';
import { hlcLocalEvent, initialClock } from '../domain/hlc.js';
import {
  canonicalNotificationCategories,
  type Notification,
  type NotificationCategory,
  type NotificationSettings,
} from '../domain/notification.js';
import { isExpired, shouldDeliver } from '../domain/notification-delivery.js';
import type { DataChange, HLCTimestamp } from '../domain/sync.js';
import type { ChannelStatus } from '../sync/connectivity.js';
import type { ApplyOutcome } from '../sync/sync-module.js';
import type { LocalStore, StoreListener } from '../store/local-store.js';

/** A `notifications` row as PostgREST returns it. */
export interface NotificationRow {
  readonly id: string;
  readonly recipient_account_id: string;
  readonly category: string;
  readonly payload: unknown;
  readonly created_at: string;
  readonly dedupe_key: string;
  readonly acknowledged_at: string | null;
  readonly delivered_at: string | null;
}

/**
 * Map a database row to the domain {@link Notification}.
 *
 * Exported and pure so the timestamp conversion is testable: the domain uses
 * epoch milliseconds while Postgres returns ISO strings, and every retention and
 * eligibility decision downstream depends on that conversion being right.
 */
export function notificationFromRow(row: NotificationRow): Notification {
  return {
    id: row.id as NotificationId,
    recipientAccountId: row.recipient_account_id as AccountId,
    category: row.category as Notification['category'],
    payload: row.payload,
    createdAt: Date.parse(row.created_at),
    dedupeKey: row.dedupe_key,
    acknowledgedAt: row.acknowledged_at === null ? null : Date.parse(row.acknowledged_at),
    deliveredAt: row.delivered_at === null ? null : Date.parse(row.delivered_at),
  };
}

/**
 * Settings used when the recipient has no `notification_settings` row yet.
 * Nothing disabled: a user who has never opened settings must still receive
 * their notifications.
 */
export function defaultNotificationSettings(accountId: AccountId): NotificationSettings {
  return { accountId, disabledCategories: [] };
}

/** Injected collaborators. Each is the narrowest thing the module needs. */
export interface NotificationPorts {
  /**
   * Subscribe to the recipient's own notification inserts. Implementations must
   * filter server-side by `recipient_account_id` so another account's rows are
   * never delivered to this client. Returns an unsubscribe function.
   */
  readonly subscribeRecipient: (
    accountId: AccountId,
    handlers: {
      readonly onInsert: (row: NotificationRow) => void;
      readonly onStatus: (status: ChannelStatus) => void;
    },
  ) => () => void;

  /** Every notification row addressed to this account. */
  readonly fetchAll: (accountId: AccountId) => Promise<readonly NotificationRow[]>;

  /** The account's settings row, or null when it has never been created. */
  readonly fetchSettings: (accountId: AccountId) => Promise<NotificationSettings | null>;

  /**
   * Mark one notification acknowledged AND delivered, returning the updated row
   * (or null when the id does not belong to this account, which RLS enforces).
   */
  readonly acknowledge: (id: NotificationId, at: Timestamp) => Promise<NotificationRow | null>;

  readonly now: () => number;
}

/** Listeners a shell or the Connection Manager (21.3) can attach. */
export interface NotificationListeners {
  /**
   * A newly arrived notification that is ELIGIBLE for this recipient — already
   * filtered for disabled categories and acknowledgement, so a shell can present
   * it without re-deriving eligibility.
   */
  readonly onNotification?: (notification: Notification) => void;
  /** Every arrival, eligible or not. Useful for badge counts and diagnostics. */
  readonly onAnyNotification?: (notification: Notification) => void;
}

/**
 * The only SyncModule capability notification settings need. Kept structural so
 * this module neither owns a connection nor couples tests to the full sync API.
 */
export interface NotificationSettingsSync {
  readonly applyChange: (change: DataChange) => Promise<ApplyOutcome>;
}

export interface NotificationModule {
  /** Subscribe to live arrivals for this account (Req 11.1, 11.2). */
  subscribe(accountId: AccountId): void;
  /** Tear down the subscription. */
  unsubscribe(): void;
  /**
   * Notifications to present now: unacknowledged, category-enabled, and inside
   * the 30-day retention window, newest first (Req 11.3, 11.4, 11.6).
   */
  list(accountId: AccountId): Promise<readonly Notification[]>;
  /** How many are currently eligible to present. */
  unreadCount(accountId: AccountId): Promise<number>;
  /** Enable or disable one category without disturbing the other preferences. */
  setCategoryEnabled(
    accountId: AccountId,
    category: NotificationCategory,
    enabled: boolean,
  ): Promise<NotificationSettings | null>;
  /**
   * Acknowledge one notification: marks it delivered and withholds it from this
   * and every later session (Req 11.6).
   */
  acknowledge(id: NotificationId): Promise<Notification | null>;
  /** Acknowledge every currently eligible notification. */
  acknowledgeAll(accountId: AccountId): Promise<number>;
  /**
   * Eligible notifications from the Local Store, read synchronously and without
   * the network. Empty when no store was provided (Req 5.1).
   */
  cached(accountId: AccountId): readonly Notification[];
  /** Observe cache changes so a badge re-renders. */
  subscribeCache(listener: StoreListener): () => void;
}

/**
 * Build a notification module over the given ports, optionally backed by the
 * Local Store for instant and offline reads (task 21.2).
 *
 * Settings are re-read on each `list` rather than cached. That is a deliberate
 * choice for the MVP: a stale cache would keep delivering a category the user
 * just muted, and the read is a single indexed lookup on a one-row-per-account
 * table. The cached READ path is the exception — it has no network to consult,
 * so it filters with the last settings seen.
 */
export function createNotificationModule(
  ports: NotificationPorts,
  listeners: NotificationListeners = {},
  store?: LocalStore,
  settingsSync?: NotificationSettingsSync,
): NotificationModule {
  let teardown: (() => void) | null = null;
  /** Settings for the subscribed account, refreshed on subscribe and list. */
  let settings: NotificationSettings | null = null;
  /** One monotonic outgoing HLC stream per settings owner. */
  const settingsClocks = new Map<AccountId, HLCTimestamp>();
  /** Local settings accepted into the offline queue but not yet server-confirmed. */
  const queuedSettings = new Set<AccountId>();

  /**
   * Cache one notification.
   *
   * The version is the acknowledgement time, which only ever moves from "not
   * acknowledged" (0) to a timestamp. That is what stops a `fetchAll` issued
   * before an acknowledgement, but answered after it, from resurrecting a
   * notification the user has already dismissed (Req 11.6).
   */
  function cache(notification: Notification): void {
    store?.put('notification', notification.id, notification, notification.acknowledgedAt ?? 0);
  }

  function rememberSettings(current: NotificationSettings): void {
    settings = current;
    store?.put('notification_settings', current.accountId, current);
  }

  function cachedSettingsFor(accountId: AccountId): NotificationSettings {
    if (settings?.accountId === accountId) return settings;
    return (
      store?.get<NotificationSettings>('notification_settings', accountId) ??
      defaultNotificationSettings(accountId)
    );
  }

  async function settingsFor(accountId: AccountId): Promise<NotificationSettings> {
    const current =
      (await ports.fetchSettings(accountId)) ?? defaultNotificationSettings(accountId);
    rememberSettings(current);
    return current;
  }

  function nextSettingsHlc(accountId: AccountId): HLCTimestamp {
    const previous = settingsClocks.get(accountId);
    const next =
      previous === undefined
        ? initialClock(accountId, ports.now())
        : hlcLocalEvent(previous, ports.now());
    settingsClocks.set(accountId, next);
    return next;
  }

  /**
   * Eligible = deliverable AND not aged out.
   *
   * `shouldDeliver` covers the category and acknowledgement checks (Req 11.3,
   * 11.6); the retention check is separate because Req 11.5's discard job is
   * task 20.2 and is deferred — until it exists, expired rows are still present
   * in the table and the client must not surface them.
   */
  function isEligible(
    notification: Notification,
    current: NotificationSettings,
    now: Timestamp,
  ): boolean {
    return shouldDeliver(notification, current) && !isExpired(notification, now);
  }

  async function eligible(accountId: AccountId): Promise<Notification[]> {
    const [rows, current] = await Promise.all([ports.fetchAll(accountId), settingsFor(accountId)]);
    const now = ports.now();
    const all = rows.map(notificationFromRow);
    // Everything is cached, not just the eligible ones: acknowledging a
    // notification is what makes it ineligible, and the cache has to hold the
    // acknowledged copy for the version guard above to recognise it.
    for (const notification of all) cache(notification);
    return (
      all
        .filter((n) => isEligible(n, current, now))
        // Newest first: the most recent invitation or your-turn prompt is the one
        // the recipient most likely wants to act on.
        .sort((a, b) => b.createdAt - a.createdAt)
    );
  }

  return {
    subscribe(accountId: AccountId): void {
      // Replace any existing subscription so re-subscribing (after a sign-in as a
      // different account, say) cannot leak a channel or deliver the previous
      // account's rows.
      teardown?.();

      // Warm the settings cache so an arrival landing before the first `list`
      // is still filtered correctly rather than being presented unconditionally.
      void settingsFor(accountId);

      teardown = ports.subscribeRecipient(accountId, {
        onInsert: (row) => {
          const notification = notificationFromRow(row);
          cache(notification);
          listeners.onAnyNotification?.(notification);

          const current = cachedSettingsFor(accountId);
          if (isEligible(notification, current, ports.now())) {
            listeners.onNotification?.(notification);
          }
        },
        // Connectivity is owned by the sync module's state machine; a status
        // change here needs no separate handling.
        onStatus: () => undefined,
      });
    },

    unsubscribe(): void {
      teardown?.();
      teardown = null;
      settings = null;
    },

    async list(accountId: AccountId): Promise<readonly Notification[]> {
      return await eligible(accountId);
    },

    async unreadCount(accountId: AccountId): Promise<number> {
      return (await eligible(accountId)).length;
    },

    async setCategoryEnabled(
      accountId: AccountId,
      category: NotificationCategory,
      enabled: boolean,
    ): Promise<NotificationSettings | null> {
      if (settingsSync === undefined) return null;
      // Always start from the durable row rather than the in-memory snapshot:
      // settings can have changed in another session, and this full-array write
      // must not silently erase an unrelated preference. Crucially, this direct
      // read does not replace `settings`: on a later failed write the active
      // live/cache filter must remain exactly as it was before this call.
      try {
        const fetched = await ports.fetchSettings(accountId);
        const cached = settings?.accountId === accountId ? settings : undefined;
        const current =
          queuedSettings.has(accountId) && cached !== undefined
            ? cached
            : (fetched ?? cached ?? defaultNotificationSettings(accountId));
        const disabled = new Set(current.disabledCategories);
        if (enabled) {
          disabled.delete(category);
        } else {
          disabled.add(category);
        }

        const disabledCategories = canonicalNotificationCategories([...disabled]);
        const outcome = await settingsSync.applyChange({
          itemType: 'notification_settings',
          itemId: accountId,
          payload: { disabled_categories: disabledCategories },
          originAccountId: accountId,
          hlc: nextSettingsHlc(accountId),
        });

        if (outcome.kind === 'applied' && outcome.applied.superseded) {
          // The server kept a newer HLC. Replace our optimistic candidate with
          // the authority before letting cached/live filtering continue.
          const authoritative =
            (await ports.fetchSettings(accountId)) ?? defaultNotificationSettings(accountId);
          queuedSettings.delete(accountId);
          rememberSettings(authoritative);
          return authoritative;
        }

        // Queued is a successful offline mutation (Req 5.4), not a failure.
        // Both it and an applied, non-superseded change should immediately mute
        // or unmute the local notifications while sync catches up.
        const saved: NotificationSettings = {
          ...current,
          accountId,
          disabledCategories,
        };
        if (outcome.kind === 'queued') {
          queuedSettings.add(accountId);
        } else {
          queuedSettings.delete(accountId);
        }
        rememberSettings(saved);
        return saved;
      } catch {
        // Port implementations normally map transport/RLS errors to null, but
        // keep the module's failure contract and active filtering stable if a
        // custom port rejects instead.
        return null;
      }
    },

    async acknowledge(id: NotificationId): Promise<Notification | null> {
      const row = await ports.acknowledge(id, ports.now());
      if (row === null) return null;
      const notification = notificationFromRow(row);
      cache(notification);
      return notification;
    },

    async acknowledgeAll(accountId: AccountId): Promise<number> {
      const pending = await eligible(accountId);
      const at = ports.now();
      const results = await Promise.all(pending.map((n) => ports.acknowledge(n.id, at)));
      const applied = results.filter((r) => r !== null);
      for (const row of applied) cache(notificationFromRow(row));
      return applied.length;
    },

    cached(accountId: AccountId): readonly Notification[] {
      if (store === undefined) return [];
      const current = cachedSettingsFor(accountId);
      const now = ports.now();
      return (
        store
          .list<Notification>('notification')
          // The cache is cleared on sign-out, but filtering by recipient keeps a
          // stale hydrated snapshot from showing another account's notifications.
          .filter((n) => n.recipientAccountId === accountId)
          .filter((n) => isEligible(n, current, now))
          .sort((a, b) => b.createdAt - a.createdAt)
      );
    },

    subscribeCache(listener: StoreListener): () => void {
      return store === undefined ? () => undefined : store.subscribe('notification', listener);
    },
  };
}
