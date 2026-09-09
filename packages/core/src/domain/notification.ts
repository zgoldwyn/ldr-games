/**
 * Notification and notification-settings shapes (Requirement 11).
 */
import type { AccountId, NotificationId, Timestamp } from './common.js';

/** Categories a user may individually enable or disable (Requirement 11.3). */
export type NotificationCategory =
  'pairing' | 'game_invite' | 'async_turn' | 'reminder' | 'quiz' | 'system';

/** The APNs endpoint associated with a native iOS device token. */
export type ApnsEnvironment = 'development' | 'production';

/**
 * The notification-category vocabulary in its canonical persistence order.
 *
 * Settings store categories as a Postgres array. Keeping the array in this
 * order makes equivalent choices produce the same durable value, regardless of
 * the order in which a person toggled the individual controls.
 */
export const NOTIFICATION_CATEGORIES = [
  'pairing',
  'game_invite',
  'async_turn',
  'reminder',
  'quiz',
  'system',
] as const satisfies readonly NotificationCategory[];

/** Whether an untrusted persistence value is one of the domain categories. */
export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Deduplicate categories and order them for stable notification-settings writes. */
export function canonicalNotificationCategories(
  categories: readonly NotificationCategory[],
): NotificationCategory[] {
  const disabled = new Set(categories);
  return NOTIFICATION_CATEGORIES.filter((category) => disabled.has(category));
}

/**
 * A durable notification addressed to a single recipient account (the RLS
 * predicate). Retained up to 30 days for offline delivery (Requirements 11.4,
 * 11.5); `dedupeKey` suppresses duplicates and `acknowledgedAt` prevents
 * re-delivery once acknowledged (Requirement 11.6).
 */
export interface Notification {
  readonly id: NotificationId;
  readonly recipientAccountId: AccountId;
  readonly category: NotificationCategory;
  readonly payload: unknown;
  readonly createdAt: Timestamp;
  readonly dedupeKey: string;
  readonly acknowledgedAt: Timestamp | null;
  readonly deliveredAt: Timestamp | null;
}

/**
 * Per-account notification preferences. `disabledCategories` lists categories to
 * withhold (Requirement 11.3); the APNs fields are the optional native iOS
 * registration for out-of-app delivery.
 */
export interface NotificationSettings {
  readonly accountId: AccountId;
  readonly disabledCategories: readonly NotificationCategory[];
  readonly apnsDeviceToken?: string;
  readonly apnsEnvironment?: ApnsEnvironment;
}
