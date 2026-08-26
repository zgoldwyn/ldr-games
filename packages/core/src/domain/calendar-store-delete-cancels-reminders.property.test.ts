// Feature: ldr-companion-app, Property 37: Deleting a date cancels its reminders
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { dateId, pairingId, reminderId } from './common.js';
import type { CalendarDate, DateId, Duration, PairingId, Timestamp } from './common.js';
import type { Reminder, RelationshipDate, ReminderStatus } from './calendar.js';
import {
  deleteDate,
  emptyCalendarState,
  remindersForDate,
  type CalendarState,
} from './calendar-store.js';

/**
 * Property 37 (task 8.7) — Deleting a date cancels its reminders.
 *
 * For any relationship date that owns one or more reminders, deleting the date
 * cancels every reminder associated with it: none remain in the stored state,
 * so nothing is left scheduled to fire (Requirement 10.4). Reminders belonging
 * to *other* dates must be left completely untouched, ensuring the cascade is
 * scoped precisely to the deleted date.
 *
 * The generator builds a calendar with a handful of uniquely-identified dates,
 * each carrying a random number of reminders (including some with zero), then
 * deletes one of those dates chosen at random. Invariants are checked against
 * the resulting state.
 */
describe('calendar-store: deleting a date cancels its reminders (property)', () => {
  const PAIRING: PairingId = pairingId('p1');

  const calendarDateArb: fc.Arbitrary<CalendarDate> = fc.record({
    year: fc.integer({ min: 1900, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  });

  // 1 minute .. 365 days, matching a reminder's valid lead-time range (10.1).
  const leadTimeArb: fc.Arbitrary<Duration> = fc.integer({
    min: 60_000,
    max: 365 * 24 * 60 * 60 * 1000,
  });

  const triggerAtArb: fc.Arbitrary<Timestamp> = fc.integer({ min: 1, max: 4_102_444_800_000 });

  const statusArb: fc.Arbitrary<ReminderStatus> = fc.constantFrom(
    'scheduled',
    'cancelled',
    'delivered',
  );

  // Each date is described by its content plus how many reminders hang off it.
  const dateSpecArb = fc.record({
    title: fc.string({ maxLength: 60 }),
    date: calendarDateArb,
    recurring: fc.boolean(),
    reminderCount: fc.integer({ min: 0, max: 5 }),
    reminderSpecs: fc.array(
      fc.record({ leadTime: leadTimeArb, nextTriggerAt: triggerAtArb, status: statusArb }),
      { maxLength: 5 },
    ),
  });

  const scenarioArb = fc
    .record({
      dates: fc.array(dateSpecArb, { minLength: 1, maxLength: 6 }),
      // [0,1) selector resolved against the built date set to pick the target.
      selector: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
    });

  interface BuiltCalendar {
    readonly state: CalendarState;
    readonly targetId: DateId;
  }

  const buildCalendar = (scenario: fc.infer<typeof scenarioArb>): BuiltCalendar => {
    const dates: RelationshipDate[] = [];
    const reminders: Reminder[] = [];
    let reminderSeq = 0;

    scenario.dates.forEach((spec, i) => {
      const id = dateId(`d${i}`);
      dates.push({
        id,
        pairingId: PAIRING,
        title: spec.title,
        date: spec.date,
        recurring: spec.recurring,
      });
      const count = Math.min(spec.reminderCount, spec.reminderSpecs.length);
      for (let r = 0; r < count; r++) {
        const rs = spec.reminderSpecs[r];
        reminders.push({
          id: reminderId(`r${reminderSeq++}`),
          dateId: id,
          pairingId: PAIRING,
          leadTime: rs.leadTime,
          nextTriggerAt: rs.nextTriggerAt,
          status: rs.status,
        });
      }
    });

    const state: CalendarState = { ...emptyCalendarState(), dates, reminders };
    const index = Math.min(dates.length - 1, Math.floor(scenario.selector * dates.length));
    return { state, targetId: dates[index].id };
  };

  // Validates: Requirements 10.4
  it('removes the deleted date and every reminder attached to it, leaving others intact', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { state, targetId } = buildCalendar(scenario);

        const survivingReminders = state.reminders.filter((r) => r.dateId !== targetId);

        const result = deleteDate(state, targetId);
        expect(isOk(result)).toBe(true);
        if (!isOk(result)) return;
        const next = result.value;

        // 10.4: no reminder for the deleted date remains — none are left to fire.
        expect(remindersForDate(next, targetId)).toEqual([]);
        expect(next.reminders.some((r) => r.dateId === targetId)).toBe(false);

        // Reminders belonging to other dates are untouched (same values, same order).
        expect(next.reminders).toEqual(survivingReminders);
      }),
      { numRuns: 100 },
    );
  });
});
