/**
 * Cross-platform synchronization and conflict-resolution shapes (Requirement 5).
 */
import type { AccountId, Timestamp } from './common.js';

/**
 * A hybrid logical clock timestamp. `physical` is wall-clock milliseconds,
 * `counter` is a logical tiebreaker that preserves causality when physical time
 * does not advance, and `originAccountId` is the final deterministic tiebreaker
 * so two changes with identical `physical` and `counter` still converge
 * (Requirements 5.5, 5.6).
 */
export interface HLCTimestamp {
  readonly physical: number;
  readonly counter: number;
  readonly originAccountId: AccountId;
}

/** The kinds of shared data that carry an HLC and flow through the sync queue. */
export type SharedItemType =
  | 'relationship_date'
  | 'reminder'
  | 'rt_session'
  | 'async_session'
  | 'quiz_session'
  | 'quiz_self_answer'
  | 'quiz_guess'
  | 'notification_settings';

/**
 * A single mutation to a shared item, stamped with an HLC so it can be ordered
 * and conflict-resolved deterministically. Changes made while offline are held
 * in submission order in the sync queue and drained on reconnect
 * (Requirements 5.4, 5.5).
 */
export interface DataChange {
  readonly itemId: string;
  readonly itemType: SharedItemType;
  readonly payload: unknown;
  readonly hlc: HLCTimestamp;
  readonly originAccountId: AccountId;
}

/**
 * The outcome of applying a {@link DataChange}. `superseded` is true when
 * last-write-wins resolution kept a newer value and discarded this change
 * (Requirement 5.5).
 */
export interface AppliedChange {
  readonly change: DataChange;
  readonly appliedAt: Timestamp;
  readonly superseded: boolean;
}
