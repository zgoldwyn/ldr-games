/**
 * Relationship-date and reminder shapes (Requirements 9 and 10).
 */
import type {
  CalendarDate,
  DateId,
  Duration,
  PairingId,
  ReminderId,
  Timestamp,
} from './common.js';

/**
 * A pairing-owned calendar entry. `title` is a non-whitespace string of 1-100
 * characters (Requirement 9.4) and `date` is a valid calendar date
 * (Requirement 9.5). Recurring dates reschedule their reminders on delivery
 * (Requirement 10.5).
 */
export interface RelationshipDate {
  readonly id: DateId;
  readonly pairingId: PairingId;
  readonly title: string;
  readonly date: CalendarDate;
  readonly recurring: boolean;
}

/** Lifecycle status of a reminder. */
export type ReminderStatus = 'scheduled' | 'cancelled' | 'delivered';

/**
 * A scheduled reminder attached to a relationship date. `leadTime` is between
 * 1 minute and 365 days and must resolve to a future `nextTriggerAt`
 * (Requirements 10.1, 10.2). Reminders are cancelled when their date is deleted
 * (Requirement 10.4).
 */
export interface Reminder {
  readonly id: ReminderId;
  readonly dateId: DateId;
  readonly pairingId: PairingId;
  readonly leadTime: Duration;
  readonly nextTriggerAt: Timestamp;
  readonly status: ReminderStatus;
}
