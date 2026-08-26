// Feature: ldr-companion-app, Property 36: Reminder scheduling and validation
//
// For any reminder request, it is scheduled with a trigger time equal to the
// occurrence (anchored to midnight UTC) minus the lead time *if and only if* the
// lead time is between 1 minute and 365 days (inclusive) and the resulting
// trigger time is strictly later than the current time; otherwise the request is
// rejected as invalid. We verify the full biconditional against
// `resolveReminderTrigger`, and separately pin down the 1-minute and 365-day
// boundaries and the values just outside them.
//
// Validates: Requirements 10.1, 10.2
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isErr, isOk } from '../result.js';
import type { CalendarDate } from './common.js';
import { calendarDateToTimestamp, resolveReminderTrigger } from './calendar-helpers.js';

// Requirement bounds expressed from first principles (independent of the module
// constants) so the test pins the intended semantics rather than mirroring the
// implementation.
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const MIN_LEAD_TIME_MS = MS_PER_MINUTE; // 1 minute
const MAX_LEAD_TIME_MS = 365 * MS_PER_DAY; // 365 days

// The valid range of ECMAScript time values.
const MAX_TIME = 8.64e15;

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
const inRangeLeadTime = fc.oneof(
  { weight: 1, arbitrary: fc.constant(MIN_LEAD_TIME_MS) },
  { weight: 1, arbitrary: fc.constant(MAX_LEAD_TIME_MS) },
  { weight: 4, arbitrary: fc.integer({ min: MIN_LEAD_TIME_MS, max: MAX_LEAD_TIME_MS }) },
);

/** Lead times outside the allowed range (too small, too large, or non-finite). */
const outOfRangeLeadTime = fc.oneof(
  fc.constant(MIN_LEAD_TIME_MS - 1),
  fc.constant(MAX_LEAD_TIME_MS + 1),
  fc.integer({ min: 0, max: MIN_LEAD_TIME_MS - 1 }),
  fc.integer({ min: MAX_LEAD_TIME_MS + 1, max: MAX_LEAD_TIME_MS + 365 * MS_PER_DAY }),
  fc.constant(-1),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
);

const anyLeadTime = fc.oneof(inRangeLeadTime, outOfRangeLeadTime);

/**
 * A full reminder request: an occurrence, a lead time (in or out of range), and
 * a `now` instant. `now` is generated near the resulting trigger time so the
 * strict "later than the current time" boundary is exercised heavily, plus some
 * fully arbitrary instants for breadth.
 */
const reminderRequest = fc
  .record({ occurrence: calendarDate, leadTime: anyLeadTime })
  .chain(({ occurrence, leadTime }) => {
    const trigger = calendarDateToTimestamp(occurrence) - leadTime;
    const nowArb = Number.isFinite(trigger)
      ? fc.oneof(
          // Straddle the trigger boundary exactly (before / equal / after).
          fc.integer({ min: -2, max: 2 }).map((d) => trigger + d),
          // Within a day either side.
          fc.integer({ min: -MS_PER_DAY, max: MS_PER_DAY }).map((d) => trigger + d),
          // Arbitrary instants across the whole time range.
          fc.integer({ min: -MAX_TIME, max: MAX_TIME }),
        )
      : fc.integer({ min: -MAX_TIME, max: MAX_TIME });
    return fc.record({
      occurrence: fc.constant(occurrence),
      leadTime: fc.constant(leadTime),
      now: nowArb,
    });
  });

describe('resolveReminderTrigger (Property 36: Reminder scheduling and validation)', () => {
  // Feature: ldr-companion-app, Property 36: Reminder scheduling and validation
  it('schedules iff the lead time is in [1 min, 365 days] and the trigger is in the future', () => {
    fc.assert(
      fc.property(reminderRequest, ({ occurrence, leadTime, now }) => {
        const inRange =
          Number.isFinite(leadTime) &&
          leadTime >= MIN_LEAD_TIME_MS &&
          leadTime <= MAX_LEAD_TIME_MS;
        const expectedTrigger = calendarDateToTimestamp(occurrence) - leadTime;
        const shouldSchedule = inRange && expectedTrigger > now;

        const result = resolveReminderTrigger(occurrence, leadTime, now);

        if (shouldSchedule) {
          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            expect(result.value).toBe(expectedTrigger);
          }
        } else {
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('INVALID_LEAD_TIME');
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  // Feature: ldr-companion-app, Property 36: Reminder scheduling and validation
  it('accepts the 1-minute and 365-day boundaries when the trigger is in the future', () => {
    fc.assert(
      fc.property(
        fc.record({
          occurrence: calendarDate,
          leadTime: fc.constantFrom(MIN_LEAD_TIME_MS, MAX_LEAD_TIME_MS),
        }),
        ({ occurrence, leadTime }) => {
          const trigger = calendarDateToTimestamp(occurrence) - leadTime;
          const now = trigger - 1; // strictly before the trigger
          const result = resolveReminderTrigger(occurrence, leadTime, now);
          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            expect(result.value).toBe(trigger);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 36: Reminder scheduling and validation
  it('rejects lead times just outside the 1-minute and 365-day boundaries', () => {
    fc.assert(
      fc.property(
        fc.record({
          occurrence: calendarDate,
          leadTime: fc.constantFrom(MIN_LEAD_TIME_MS - 1, MAX_LEAD_TIME_MS + 1),
        }),
        ({ occurrence, leadTime }) => {
          // Choose an early `now` so only the range check can trigger rejection.
          const now = calendarDateToTimestamp(occurrence) - MAX_LEAD_TIME_MS - MS_PER_DAY;
          const result = resolveReminderTrigger(occurrence, leadTime, now);
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('INVALID_LEAD_TIME');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
