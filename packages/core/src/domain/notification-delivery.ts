/**
 * Pure, deterministic notification-delivery helpers (Requirement 11).
 *
 * These functions are shared by the client and the delivery Edge Function so
 * that both sides agree on exactly which notifications are eligible for
 * delivery, when a notification has aged out of its retention window, and when
 * two notifications are duplicates. They contain no I/O and no clock access —
 * every time-dependent decision takes an explicit `now` — so they are safe to
 * property-test.
 */
import type { Notification, NotificationSettings } from './notification.js';
import type { Timestamp } from './common.js';

/**
 * Notification retention window in milliseconds: 30 days. A notification older
 * than this is discarded and never delivered (Requirements 11.4, 11.5).
 */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the notification's category is currently enabled for its recipient.
 * A category is enabled unless the recipient has explicitly listed it in
 * `disabledCategories` (Requirement 11.3).
 */
export function isCategoryEnabled(
  n: Notification,
  settings: NotificationSettings,
): boolean {
  return !settings.disabledCategories.includes(n.category);
}

/**
 * Whether a notification is eligible to be delivered to the recipient's
 * session.
 *
 * Returns `true` iff the notification's category is enabled in the recipient's
 * settings (Requirement 11.3) AND the notification has not already been
 * acknowledged. Once acknowledged, a notification is considered delivered and
 * is withheld from subsequent sessions (Requirement 11.6).
 */
export function shouldDeliver(
  n: Notification,
  settings: NotificationSettings,
): boolean {
  return isCategoryEnabled(n, settings) && n.acknowledgedAt === null;
}

/**
 * Whether a notification has aged out of its 30-day retention window.
 *
 * Returns `true` iff more than 30 days have elapsed between the notification's
 * creation and `now`. Expired notifications are discarded and no further
 * delivery is attempted (Requirements 11.4, 11.5).
 */
export function isExpired(n: Notification, now: Timestamp): boolean {
  return now - n.createdAt > NOTIFICATION_RETENTION_MS;
}

/**
 * The de-duplication identity of a notification: a duplicate is any other
 * notification addressed to the same recipient carrying the same `dedupeKey`.
 * Scoping by recipient prevents an unrelated recipient's identical key from
 * being treated as a duplicate (Requirement 11.6).
 */
export function dedupeIdentity(n: Notification): string {
  return `${n.recipientAccountId}\u0000${n.dedupeKey}`;
}

/**
 * Whether two notifications are duplicates — same recipient and same
 * `dedupeKey`. Duplicate notifications are suppressed so the recipient is not
 * notified twice for the same event (Requirement 11.6).
 */
export function isDuplicate(a: Notification, b: Notification): boolean {
  return dedupeIdentity(a) === dedupeIdentity(b);
}
