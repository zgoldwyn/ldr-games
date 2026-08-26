/**
 * Unit tests for the pure calendar and reminder helpers (Requirements 9 and
 * 10). Property-based coverage lives in the corresponding `*.property.test.ts`
 * files; these examples pin down specific edge cases and the intended semantics.
 */
import { describe, expect, it } from 'vitest';

import { isErr, isOk } from '../result.js';
import { dateId, pairingId } from './common.js';
import type { CalendarDate } from './common.js';
import type { RelationshipDate } from './calendar.js';
import {
  calendarDateToTimestamp,
  compareCalendarDate,
  isValidCalendarDate,
  isValidLeadTime,
  MAX_LEAD_TIME,
  MIN_LEAD_TIME,
  nextOccurrence,
  orderDates,
  reminderTriggerTime,
  resolveReminderTrigger,
  validateTitle,
} from './calendar-helpers.js';

const MS_ONE_DAY = 24 * 60 * 60 * 1000;
const MS_TWO_DAYS = 2 * MS_ONE_DAY;

const date = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

const makeDate = (
  overrides: Partial<RelationshipDate> & { title: string; date: CalendarDate; recurring: boolean },
): RelationshipDate => ({
  id: dateId(overrides.title),
  pairingId: pairingId('p1'),
  ...overrides,
});

describe('validateTitle (Req 9.4)', () => {
  it('accepts a normal title', () => {
    expect(validateTitle('Anniversary')).toBe(true);
  });

  it('accepts a title of exactly 100 characters', () => {
    expect(validateTitle('a'.repeat(100))).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validateTitle('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(validateTitle('   \t\n')).toBe(false);
  });

  it('rejects a title whose trimmed length exceeds 100 characters', () => {
    expect(validateTitle('a'.repeat(101))).toBe(false);
  });

  it('accepts a title that fits within 100 characters after trimming', () => {
    expect(validateTitle(`  ${'a'.repeat(100)}  `)).toBe(true);
  });
});

describe('isValidCalendarDate (Req 9.5)', () => {
  it('accepts a real date', () => {
    expect(isValidCalendarDate(date(2024, 2, 29))).toBe(true);
  });

  it('rejects February 29 in a non-leap year', () => {
    expect(isValidCalendarDate(date(2023, 2, 29))).toBe(false);
  });

  it('rejects a day beyond the month length', () => {
    expect(isValidCalendarDate(date(2024, 4, 31))).toBe(false);
  });

  it('rejects month 0 and month 13', () => {
    expect(isValidCalendarDate(date(2024, 0, 10))).toBe(false);
    expect(isValidCalendarDate(date(2024, 13, 10))).toBe(false);
  });

  it('rejects non-integer components', () => {
    expect(isValidCalendarDate(date(2024, 1, 1.5))).toBe(false);
  });

  it('rejects missing fields and non-objects', () => {
    expect(isValidCalendarDate({ year: 2024, month: 1 })).toBe(false);
    expect(isValidCalendarDate(null)).toBe(false);
    expect(isValidCalendarDate('2024-01-01')).toBe(false);
    expect(isValidCalendarDate(undefined)).toBe(false);
  });
});

describe('nextOccurrence (Reqs 9.7, 10.5)', () => {
  it('returns a non-recurring date unchanged even when in the past', () => {
    const d = makeDate({ title: 'Trip', date: date(2020, 5, 1), recurring: false });
    expect(nextOccurrence(d, date(2024, 1, 1))).toEqual(date(2020, 5, 1));
  });

  it('returns this year for a recurring date still ahead in the year', () => {
    const d = makeDate({ title: 'Birthday', date: date(1990, 6, 15), recurring: true });
    expect(nextOccurrence(d, date(2024, 1, 1))).toEqual(date(2024, 6, 15));
  });

  it('rolls to next year once this year has passed', () => {
    const d = makeDate({ title: 'Birthday', date: date(1990, 3, 5), recurring: true });
    expect(nextOccurrence(d, date(2024, 6, 1))).toEqual(date(2025, 3, 5));
  });

  it('treats today as the next occurrence', () => {
    const d = makeDate({ title: 'Anniversary', date: date(2000, 8, 8), recurring: true });
    expect(nextOccurrence(d, date(2024, 8, 8))).toEqual(date(2024, 8, 8));
  });

  it('clamps a February 29 recurrence to February 28 in a non-leap year', () => {
    const d = makeDate({ title: 'Leap day', date: date(2024, 2, 29), recurring: true });
    expect(nextOccurrence(d, date(2023, 1, 1))).toEqual(date(2023, 2, 28));
  });
});

describe('orderDates (Req 9.7)', () => {
  it('orders by ascending next occurrence, then case-insensitive title', () => {
    const now = date(2024, 1, 1);
    const march = makeDate({ title: 'March event', date: date(2024, 3, 10), recurring: false });
    const janB = makeDate({ title: 'banana', date: date(2024, 2, 1), recurring: false });
    const janA = makeDate({ title: 'Apple', date: date(2024, 2, 1), recurring: false });

    const ordered = orderDates([march, janB, janA], now);
    expect(ordered.map((d) => d.title)).toEqual(['Apple', 'banana', 'March event']);
  });

  it('does not mutate the input array', () => {
    const now = date(2024, 1, 1);
    const input = [
      makeDate({ title: 'B', date: date(2024, 5, 1), recurring: false }),
      makeDate({ title: 'A', date: date(2024, 2, 1), recurring: false }),
    ];
    const snapshot = [...input];
    orderDates(input, now);
    expect(input).toEqual(snapshot);
  });
});

describe('reminderTriggerTime and validation (Reqs 10.1, 10.2)', () => {
  it('computes occurrence midnight UTC minus lead time', () => {
    const occurrence = date(2024, 6, 15);
    const midnight = calendarDateToTimestamp(occurrence);
    expect(reminderTriggerTime(occurrence, MIN_LEAD_TIME)).toBe(midnight - MIN_LEAD_TIME);
  });

  it('accepts lead times at the inclusive bounds', () => {
    expect(isValidLeadTime(MIN_LEAD_TIME)).toBe(true);
    expect(isValidLeadTime(MAX_LEAD_TIME)).toBe(true);
  });

  it('rejects lead times outside the range', () => {
    expect(isValidLeadTime(MIN_LEAD_TIME - 1)).toBe(false);
    expect(isValidLeadTime(MAX_LEAD_TIME + 1)).toBe(false);
    expect(isValidLeadTime(Number.NaN)).toBe(false);
  });

  it('resolves a future trigger with a valid lead time', () => {
    const occurrence = date(2024, 6, 15);
    const now = calendarDateToTimestamp(occurrence) - MS_TWO_DAYS;
    const result = resolveReminderTrigger(occurrence, MS_ONE_DAY, now);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(calendarDateToTimestamp(occurrence) - MS_ONE_DAY);
    }
  });

  it('rejects an out-of-range lead time', () => {
    const occurrence = date(2024, 6, 15);
    const result = resolveReminderTrigger(occurrence, MAX_LEAD_TIME + 1, 0);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVALID_LEAD_TIME');
    }
  });

  it('rejects a trigger time that is not in the future', () => {
    const occurrence = date(2024, 6, 15);
    // now is after the trigger (occurrence minus one day)
    const now = calendarDateToTimestamp(occurrence);
    const result = resolveReminderTrigger(occurrence, MS_ONE_DAY, now);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVALID_LEAD_TIME');
    }
  });
});

describe('compareCalendarDate', () => {
  it('orders by year, then month, then day', () => {
    expect(compareCalendarDate(date(2024, 1, 1), date(2025, 1, 1))).toBeLessThan(0);
    expect(compareCalendarDate(date(2024, 3, 1), date(2024, 2, 1))).toBeGreaterThan(0);
    expect(compareCalendarDate(date(2024, 2, 5), date(2024, 2, 5))).toBe(0);
  });
});
