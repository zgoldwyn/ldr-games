/**
 * Pure, deterministic persistence model for a pairing's relationship dates and
 * their reminders (Requirements 9 and 10).
 *
 * The functions here operate over an in-memory {@link CalendarState} — a plain
 * collection value — and never mutate their inputs: each operation returns a
 * new state (or a `Result` wrapping one) so callers can reason about changes
 * as immutable transitions. This mirrors the persistence semantics the write
 * Edge Function and the offline client both need, and keeps the logic trivially
 * property-testable.
 *
 * Scope note: this module owns the *set* operations (add/update/remove with
 * not-found rejection, reminder cascade on delete, and recurring reschedule on
 * delivery — Requirements 9.1, 9.2, 9.3, 9.6, 10.4, 10.5). Title/date validity
 * (Requirements 9.4, 9.5) and ordering (9.7) live in the calendar helpers and
 * are composed at a higher layer; where computing the *next future occurrence*
 * is needed (10.5), the caller injects that computation (see
 * {@link NextTriggerResolver}) so this module never depends on those helpers
 * directly.
 */
import { err, ok, type Result } from '../result.js';
import { ERROR_CODES, type CalendarError } from '../errors.js';
import type { CalendarDate, DateId, Duration, Timestamp } from './common.js';
import type { Reminder, RelationshipDate } from './calendar.js';

/**
 * The full in-memory state for a single pairing's calendar: its relationship
 * dates and every reminder attached to those dates. Both collections are
 * treated as immutable — operations return a fresh {@link CalendarState}.
 */
export interface CalendarState {
  readonly dates: readonly RelationshipDate[];
  readonly reminders: readonly Reminder[];
}

/** The fields of a {@link RelationshipDate} an edit may change (9.2). */
export type RelationshipDateUpdates = Partial<
  Pick<RelationshipDate, 'title' | 'date' | 'recurring'>
>;

/** An empty calendar state, useful as a starting point or test fixture. */
export function emptyCalendarState(): CalendarState {
  return { dates: [], reminders: [] };
}

/** Whether a date with `dateId` currently exists in the state. */
export function hasDate(state: CalendarState, dateId: DateId): boolean {
  return state.dates.some((d) => d.id === dateId);
}

/** The date with `dateId`, or `undefined` when it is not present. */
export function findDate(state: CalendarState, dateId: DateId): RelationshipDate | undefined {
  return state.dates.find((d) => d.id === dateId);
}

/** Every reminder currently attached to `dateId` (may be empty). */
export function remindersForDate(state: CalendarState, dateId: DateId): readonly Reminder[] {
  return state.reminders.filter((r) => r.dateId === dateId);
}

/**
 * Add a relationship date to the pairing's set (Requirement 9.1).
 *
 * Returns a new state with `date` appended. Reminders are untouched. Title and
 * calendar-date validity are enforced by the calendar helpers / write Edge
 * Function before this point, so this operation is a pure set insertion.
 */
export function createDate(state: CalendarState, date: RelationshipDate): CalendarState {
  return { ...state, dates: [...state.dates, date] };
}

/**
 * Update an existing relationship date (Requirement 9.2), rejecting with
 * `DATE_NOT_FOUND` when no date has the given id (Requirement 9.6).
 *
 * `id` and `pairingId` are immutable and never changed by `updates`. On success
 * a new state is returned with the matching date replaced in place; on failure
 * the stored dates are left unchanged.
 */
export function editDate(
  state: CalendarState,
  dateId: DateId,
  updates: RelationshipDateUpdates,
): Result<CalendarState, CalendarError> {
  const existing = findDate(state, dateId);
  if (existing === undefined) {
    return err(dateNotFound(dateId));
  }
  const updated: RelationshipDate = {
    ...existing,
    ...updates,
    id: existing.id,
    pairingId: existing.pairingId,
  };
  return ok({
    ...state,
    dates: state.dates.map((d) => (d.id === dateId ? updated : d)),
  });
}

/**
 * Delete an existing relationship date (Requirement 9.3), rejecting with
 * `DATE_NOT_FOUND` when it is absent (Requirement 9.6).
 *
 * On success the date is removed and, per Requirement 10.4, every reminder
 * associated with it is cancelled by dropping it from the state so no further
 * notifications for those reminders can be delivered (this mirrors the
 * `ON DELETE CASCADE` in the persistence layer). On failure nothing changes.
 */
export function deleteDate(
  state: CalendarState,
  dateId: DateId,
): Result<CalendarState, CalendarError> {
  if (!hasDate(state, dateId)) {
    return err(dateNotFound(dateId));
  }
  return ok({
    dates: state.dates.filter((d) => d.id !== dateId),
    reminders: state.reminders.filter((r) => r.dateId !== dateId),
  });
}

/**
 * Computes the trigger {@link Timestamp} for a reminder placed the given
 * `leadTime` before the next future occurrence of `date` relative to `now`.
 *
 * This is injected rather than imported so this module stays independent of the
 * calendar helpers (`nextOccurrence` + `reminderTriggerTime`); a caller composes
 * those to satisfy this shape.
 */
export type NextTriggerResolver = (
  date: RelationshipDate,
  now: CalendarDate,
  leadTime: Duration,
) => Timestamp;

/**
 * Reschedule a recurring date's reminder when its current occurrence is
 * delivered (Requirement 10.5).
 *
 * When `date` is recurring, this produces a new `scheduled` reminder that keeps
 * the same lead time and fires that same lead time before the date's next
 * future occurrence (computed via the injected `resolveNextTriggerAt`). The
 * reminder's identity (`id`, `dateId`, `pairingId`) and `leadTime` are
 * preserved; only `nextTriggerAt` advances and `status` returns to `scheduled`.
 *
 * When `date` is not recurring there is nothing to reschedule and `null` is
 * returned, signalling the delivered reminder should not be re-armed.
 */
export function rescheduleRecurringReminder(
  date: RelationshipDate,
  reminder: Reminder,
  now: CalendarDate,
  resolveNextTriggerAt: NextTriggerResolver,
): Reminder | null {
  if (!date.recurring) {
    return null;
  }
  const nextTriggerAt = resolveNextTriggerAt(date, now, reminder.leadTime);
  return {
    ...reminder,
    nextTriggerAt,
    status: 'scheduled',
  };
}

/** Build the standard `DATE_NOT_FOUND` error envelope (Requirement 9.6). */
function dateNotFound(dateId: DateId): CalendarError {
  return {
    code: ERROR_CODES.DATE_NOT_FOUND,
    message: `No relationship date exists with id "${dateId}".`,
    details: { dateId },
  };
}
