/**
 * Notification and notification-settings shapes (Requirement 11).
 */
import type { AccountId, NotificationId, Timestamp } from './common.js';

/** Categories a user may individually enable or disable (Requirement 11.3). */
export type NotificationCategory =
  | 'pairing'
  | 'game_invite'
  | 'async_turn'
  | 'reminder'
  | 'quiz'
  | 'system';

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
 * withhold (Requirement 11.3); `expoPushToken` is the optional external push
 * registration for out-of-app delivery.
 */
export interface NotificationSettings {
  readonly accountId: AccountId;
  readonly disabledCategories: readonly NotificationCategory[];
  readonly expoPushToken?: string;
}
