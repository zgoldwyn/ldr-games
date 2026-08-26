// Feature: ldr-companion-app, Property 35: Relationship date ordering
//
// For any set of relationship dates and any current date, `orderDates` returns
// them ordered by ascending next upcoming occurrence relative to the current
// date, with dates sharing the same next occurrence ordered alphabetically by
// title using a case-insensitive comparison. We verify the output is a
// permutation of the input and that every adjacent pair is correctly ordered by
// (nextOccurrence, case-insensitive title).
//
// Validates: Requirements 9.7
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { dateId, pairingId } from './common.js';
import type { CalendarDate } from './common.js';
import type { RelationshipDate } from './calendar.js';
import { compareCalendarDate, nextOccurrence, orderDates } from './calendar-helpers.js';

/** Days in a 1-based month, respecting Gregorian leap years. */
function daysInMonth(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** A generator of valid calendar dates (day always in range for its month). */
const calendarDate: fc.Arbitrary<CalendarDate> = fc
  .record({
    year: fc.integer({ min: 1, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFraction: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, dayFraction }) => ({
    year,
    month,
    day: Math.min(dayFraction, daysInMonth(year, month)),
  }));

// Small pool of titles that collide case-insensitively so the tie-break path is
// exercised (e.g. "Apple" vs "apple", "banana" vs "BANANA").
const title: fc.Arbitrary<string> = fc.constantFrom(
  'Anniversary',
  'anniversary',
  'Birthday',
  'BIRTHDAY',
  'Apple',
  'apple',
  'banana',
  'BANANA',
  'Trip',
  'trip',
  '',
);

let counter = 0;
const relationshipDate: fc.Arbitrary<RelationshipDate> = fc
  .record({ title, date: calendarDate, recurring: fc.boolean() })
  .map(({ title: t, date, recurring }) => ({
    id: dateId(`d-${counter++}`),
    pairingId: pairingId('p1'),
    title: t,
    date,
    recurring,
  }));

const dates = fc.array(relationshipDate, { minLength: 0, maxLength: 12 });

const lower = (s: string): string => s.toLowerCase();

describe('orderDates (Property 35: Relationship date ordering)', () => {
  // Feature: ldr-companion-app, Property 35: Relationship date ordering
  it('orders by ascending next occurrence, then case-insensitive title', () => {
    fc.assert(
      fc.property(dates, calendarDate, (input, now) => {
        const ordered = orderDates(input, now);

        // The result is a permutation of the input (same length, same ids).
        expect(ordered).toHaveLength(input.length);
        const countIds = (arr: RelationshipDate[]): Map<string, number> => {
          const m = new Map<string, number>();
          for (const d of arr) {
            m.set(d.id, (m.get(d.id) ?? 0) + 1);
          }
          return m;
        };
        expect(countIds(ordered)).toEqual(countIds(input));

        // Every adjacent pair is correctly ordered.
        for (let i = 0; i + 1 < ordered.length; i++) {
          const a = ordered[i]!;
          const b = ordered[i + 1]!;
          const occ = compareCalendarDate(nextOccurrence(a, now), nextOccurrence(b, now));
          expect(occ).toBeLessThanOrEqual(0);
          if (occ === 0) {
            // Same next occurrence: titles are non-decreasing case-insensitively.
            expect(lower(a.title) <= lower(b.title)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
