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
 * WHAT IS DEFERRED. Out-of-app push (task 19.2) and the settings WRITE path
 * (19.1b) are not here. Category filtering itself IS here, because
 * `shouldDeliver` already exists and the settings table is already readable —
 * honouring a disabled category costs one query, whereas bolting the filter on
 * afterwards would mean revisiting every read path (Req 11.3).
 *
 * Collaborators are injected as narrow ports, matching `sync/sync-module.ts`, so
 * the eligibility and acknowledgement logic is unit-testable without a stack and
 * task 21.3 can compose this into the Connection Manager.
 */
import type { AccountId, NotificationId, Timestamp } from '../domain/common.js';
import type { Notification, NotificationSettings } from '../domain/notification.js';
import {
  isExpired,
  shouldDeliver,
} from '../domain/notification-delivery.js';
import type { ChannelStatus } from '../sync/connectivity.js';

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
  readonly acknowledge: (
    id: NotificationId,
    at: Timestamp,
  ) => Promise<NotificationRow | null>;

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
  /**
   * Acknowledge one notification: marks it delivered and withholds it from this
   * and every later session (Req 11.6).
   */
  acknowledge(id: NotificationId): Promise<Notification | null>;
  /** Acknowledge every currently eligible notification. */
  acknowledgeAll(accountId: AccountId): Promise<number>;
}

/**
 * Build a notification module over the given ports.
 *
 * Settings are re-read on each `list` rather than cached. That is a deliberate
 * choice for the MVP: a stale cache would keep delivering a category the user
 * just muted, and the read is a single indexed lookup on a one-row-per-account
 * table.
 */
export function createNotificationModule(
  ports: NotificationPorts,
  listeners: NotificationListeners = {},
): NotificationModule {
  let teardown: (() => void) | null = null;
  /** Settings for the subscribed account, refreshed on subscribe and list. */
  let settings: NotificationSettings | null = null;

  async function settingsFor(accountId: AccountId): Promise<NotificationSettings> {
    settings = (await ports.fetchSettings(accountId)) ?? defaultNotificationSettings(accountId);
    return settings;
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
    const [rows, current] = await Promise.all([
      ports.fetchAll(accountId),
      settingsFor(accountId),
    ]);
    const now = ports.now();
    return rows
      .map(notificationFromRow)
      .filter((n) => isEligible(n, current, now))
      // Newest first: the most recent invitation or your-turn prompt is the one
      // the recipient most likely wants to act on.
      .sort((a, b) => b.createdAt - a.createdAt);
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
          listeners.onAnyNotification?.(notification);

          const current = settings ?? defaultNotificationSettings(accountId);
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

    async acknowledge(id: NotificationId): Promise<Notification | null> {
      const row = await ports.acknowledge(id, ports.now());
      return row === null ? null : notificationFromRow(row);
    },

    async acknowledgeAll(accountId: AccountId): Promise<number> {
      const pending = await eligible(accountId);
      const at = ports.now();
      const results = await Promise.all(
        pending.map((n) => ports.acknowledge(n.id, at)),
      );
      return results.filter((r) => r !== null).length;
    },
  };
}
