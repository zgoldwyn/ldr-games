// Feature: ldr-companion-app, Property 38: Recurring reminders reschedule on delivery
//
// For any recurring relationship date, delivering a reminder for the current
// occurrence schedules a new reminder at the same lead time before the next
// future occurrence of the date (Requirement 10.5). We drive
// `rescheduleRecurringReminder` with the real trigger resolver composed from the
// calendar helpers (`nextOccurrence` + `reminderTriggerTime`) so the property
// exercises the exact rescheduling behaviour a caller would wire up.
//
// The mirror case is pinned too: a non-recurring date has no next future
// occurrence to re-arm, so delivering its reminder reschedules nothing (`null`).
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { dateId, pairingId, reminderId } from './common.js';
import type { CalendarDate, Duration } from './common.js';
import type { Reminder, RelationshipDate, ReminderStatus } from './calendar.js';
import { nextOccurrence, reminderTriggerTime } from './calendar-helpers.js';
import {
  rescheduleRecurringReminder,
  type NextTriggerResolver,
} from './calendar-store.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const MIN_LEAD_TIME_MS = MS_PER_MINUTE; // 1 minute
const MAX_LEAD_TIME_MS = 365 * MS_PER_DAY; // 365 days

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number): number =>
  [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** A valid calendar date (Requirement 9.5 shape) across the full 1-9999 range. */
const calendarDate: fc.Arbitrary<CalendarDate> = fc
  .record({ year: fc.integer({ min: 1, max: 9999 }), month: fc.integer({ min: 1, max: 12 }) })
  .chain(({ year, month }) =>
    fc.integer({ min: 1, max: daysInMonth(year, month) }).map((day) => ({ year, month, day })),
  );

/** Lead times inside the allowed range, weighted to hit both inclusive bounds. */
const leadTime: fc.Arbitrary<Duration> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(MIN_LEAD_TIME_MS) },
  { weight: 1, arbitrary: fc.constant(MAX_LEAD_TIME_MS) },
  { weight: 4, arbitrary: fc.integer({ min: MIN_LEAD_TIME_MS, max: MAX_LEAD_TIME_MS }) },
);

const reminderStatus: fc.Arbitrary<ReminderStatus> = fc.constantFrom(
  'scheduled',
  'delivered',
  'cancelled',
);

/** A relationship date with an explicitly controlled `recurring` flag. */
const relationshipDate = (recurring: boolean): fc.Arbitrary<RelationshipDate> =>
  fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 12 }),
      pairing: fc.string({ minLength: 1, maxLength: 12 }),
      title: fc.string({ minLength: 1, maxLength: 30 }),
      date: calendarDate,
    })
    .map(({ id, pairing, title, date }) => ({
      id: dateId(id),
      pairingId: pairingId(pairing),
      title,
      date,
      recurring,
    }));

/** A delivered-or-otherwise reminder attached to `date` at some lead time. */
const reminderFor = (date: RelationshipDate): fc.Arbitrary<Reminder> =>
  fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 12 }),
      leadTime,
      nextTriggerAt: fc.integer({ min: -8.64e15, max: 8.64e15 }),
      status: reminderStatus,
    })
    .map(({ id, leadTime: lead, nextTriggerAt, status }) => ({
      id: reminderId(id),
      dateId: date.id,
      pairingId: date.pairingId,
      leadTime: lead,
      nextTriggerAt,
      status,
    }));

// The resolver a real caller composes: the same lead time before the next
// future occurrence of the date relative to `now`.
const resolveNextTriggerAt: NextTriggerResolver = (date, now, lead) =>
  reminderTriggerTime(nextOccurrence(date, now), lead);

describe('calendar-store: recurring reminder reschedule on delivery (property)', () => {
  // Feature: ldr-companion-app, Property 38: Recurring reminders reschedule on delivery
  // Validates: Requirements 10.5
  it('re-arms a recurring date at the same lead time before its next future occurrence', () => {
    fc.assert(
      fc.property(
        relationshipDate(true).chain((date) =>
          fc.record({
            date: fc.constant(date),
            reminder: reminderFor(date),
            now: calendarDate,
          }),
        ),
        ({ date, reminder, now }) => {
          const rescheduled = rescheduleRecurringReminder(
            date,
            reminder,
            now,
            resolveNextTriggerAt,
          );

          // A recurring delivery always produces a new scheduled reminder.
          expect(rescheduled).not.toBeNull();
          if (rescheduled === null) return;

          // Identity and lead time are preserved; only the trigger advances.
          expect(rescheduled.id).toBe(reminder.id);
          expect(rescheduled.dateId).toBe(reminder.dateId);
          expect(rescheduled.pairingId).toBe(reminder.pairingId);
          expect(rescheduled.leadTime).toBe(reminder.leadTime);

          // It is re-armed (back to scheduled) regardless of the prior status.
          expect(rescheduled.status).toBe('scheduled');

          // The new trigger is exactly the same lead time before the next future
          // occurrence of the date relative to `now`.
          const occurrence = nextOccurrence(date, now);
          expect(rescheduled.nextTriggerAt).toBe(
            reminderTriggerTime(occurrence, reminder.leadTime),
          );

          // And that occurrence is genuinely "the next future occurrence": it is
          // on or after `now` (recurring dates never re-arm into the past).
          const notBeforeNow =
            occurrence.year > now.year ||
            (occurrence.year === now.year &&
              (occurrence.month > now.month ||
                (occurrence.month === now.month && occurrence.day >= now.day)));
          expect(notBeforeNow).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 38: Recurring reminders reschedule on delivery
  // Validates: Requirements 10.5
  it('reschedules nothing for a non-recurring date (no next future occurrence to re-arm)', () => {
    fc.assert(
      fc.property(
        relationshipDate(false).chain((date) =>
          fc.record({
            date: fc.constant(date),
            reminder: reminderFor(date),
            now: calendarDate,
          }),
        ),
        ({ date, reminder, now }) => {
          const rescheduled = rescheduleRecurringReminder(
            date,
            reminder,
            now,
            resolveNextTriggerAt,
          );
          expect(rescheduled).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
