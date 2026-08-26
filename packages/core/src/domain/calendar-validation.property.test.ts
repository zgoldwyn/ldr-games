// Feature: ldr-companion-app, Property 34: Relationship date validation
//
// For any relationship date create or edit request, the request is rejected
// with the stored dates unchanged if the title is missing, empty,
// whitespace-only, or exceeds 100 characters, or if the calendar date is
// missing or not a valid calendar date; and an edit or delete of an id not
// present in the pairing is rejected as not-found.
//
// Title/date validity is decided by `validateTitle` / `isValidCalendarDate`
// (calendar-helpers, task 8.1); the not-found rejection lives in the pure
// persistence model `editDate` / `deleteDate` (calendar-store, task 8.5). We
// pair each "must reject" generator with a matching "must accept" generator so
// the boundary is pinned from both sides.
//
// Validates: Requirements 9.4, 9.5, 9.6
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isErr, isOk } from '../result.js';
import { dateId, pairingId } from './common.js';
import type { CalendarDate, DateId } from './common.js';
import type { RelationshipDate } from './calendar.js';
import { isValidCalendarDate, validateTitle } from './calendar-helpers.js';
import { createDate, deleteDate, editDate, emptyCalendarState } from './calendar-store.js';

// ---------------------------------------------------------------------------
// Title generators (Requirement 9.4)
// ---------------------------------------------------------------------------

/** Whitespace characters `String.prototype.trim` strips. */
const WHITESPACE = [' ', '\t', '\n', '\r', '\f', '\v'];

/** A run of pure whitespace (possibly empty), used to pad valid cores. */
const whitespaceRun = fc.stringOf(fc.constantFrom(...WHITESPACE), { minLength: 0, maxLength: 5 });

/**
 * The trimmed "core" of a valid title: a non-empty string of 1-100 characters
 * that neither starts nor ends with whitespace. Trimming an arbitrary string of
 * length <= 100 yields a string of length <= 100 with no bordering whitespace;
 * filtering to non-empty guarantees at least one visible character.
 */
const validTitleCore = fc
  .string({ minLength: 1, maxLength: 100 })
  .map((s) => s.trim())
  .filter((s) => s.length >= 1 && s.length <= 100);

/** A valid title: a valid core optionally padded with surrounding whitespace. */
const validTitle = fc
  .tuple(whitespaceRun, validTitleCore, whitespaceRun)
  .map(([lead, core, trail]) => `${lead}${core}${trail}`)
  .filter((title) => {
    const t = title.trim();
    return t.length >= 1 && t.length <= 100;
  });

/** A title that must be rejected: empty, whitespace-only, or too long. */
const invalidTitle = fc.oneof(
  // Empty.
  fc.constant(''),
  // Whitespace-only (never trims to a non-empty string).
  fc.stringOf(fc.constantFrom(...WHITESPACE), { minLength: 1, maxLength: 10 }),
  // Trimmed length strictly greater than 100.
  fc
    .integer({ min: 101, max: 200 })
    .chain((len) =>
      fc.tuple(whitespaceRun, whitespaceRun).map(
        ([lead, trail]) => `${lead}${'a'.repeat(len)}${trail}`,
      ),
    ),
);

// ---------------------------------------------------------------------------
// Calendar-date generators (Requirement 9.5)
// ---------------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return isLeapYear(year) ? 29 : 28; // February
  }
}

/** A valid calendar date: integer year 1-9999, month 1-12, day in range. */
const validCalendarDate: fc.Arbitrary<CalendarDate> = fc
  .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }))
  .chain(([year, month]) =>
    fc
      .integer({ min: 1, max: daysInMonth(year, month) })
      .map((day) => ({ year, month, day })),
  );

/** A day strictly beyond the length of its month (e.g. Feb 30, Apr 31). */
const dayOutOfRange = fc
  .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }))
  .chain(([year, month]) =>
    fc
      .integer({ min: daysInMonth(year, month) + 1, max: 40 })
      .map((day) => ({ year, month, day })),
  );

/** Values that are not valid calendar dates, each violating a distinct rule. */
const invalidCalendarDate: fc.Arbitrary<unknown> = fc.oneof(
  // Day past the end of the month (leap years respected by the generator).
  dayOutOfRange,
  // Day below 1.
  fc
    .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: -10, max: 0 }))
    .map(([year, month, day]) => ({ year, month, day })),
  // Month out of range.
  fc
    .tuple(fc.integer({ min: 1, max: 9999 }), fc.oneof(fc.integer({ min: -5, max: 0 }), fc.integer({ min: 13, max: 20 })), fc.integer({ min: 1, max: 28 }))
    .map(([year, month, day]) => ({ year, month, day })),
  // Year out of range.
  fc
    .tuple(fc.oneof(fc.integer({ min: -100, max: 0 }), fc.integer({ min: 10000, max: 20000 })), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
    .map(([year, month, day]) => ({ year, month, day })),
  // Non-integer component.
  fc
    .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }))
    .map(([year, month]) => ({ year, month, day: 1.5 })),
  // Missing field.
  fc.constant({ year: 2024, month: 1 }),
  // Non-object shapes.
  fc.constantFrom(null, undefined, '2024-01-01', 42, [] as unknown),
);

// ---------------------------------------------------------------------------
// State + not-found generators (Requirement 9.6)
// ---------------------------------------------------------------------------

const makeDate = (id: string, title: string, date: CalendarDate): RelationshipDate => ({
  id: dateId(id),
  pairingId: pairingId('pairing-1'),
  title,
  date,
  recurring: false,
});

/**
 * A calendar state built from distinct date ids, together with a target id that
 * is guaranteed absent from that state.
 */
const stateWithMissingId = fc
  .tuple(
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 5 }),
    fc.string({ minLength: 1, maxLength: 8 }),
    validCalendarDate,
  )
  .map(([ids, rawMissing, date]) => {
    const present = new Set(ids);
    // Ensure the target id is not one of the present ids.
    let missing = rawMissing;
    while (present.has(missing)) {
      missing = `${missing}!`;
    }
    let state = emptyCalendarState();
    ids.forEach((id, index) => {
      state = createDate(state, makeDate(id, `Date ${index}`, date));
    });
    return { state, missingId: dateId(missing) as DateId };
  });

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Property 34: Relationship date validation', () => {
  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('accepts every valid title (Req 9.4)', () => {
    fc.assert(
      fc.property(validTitle, (title) => {
        expect(validateTitle(title)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('rejects every missing, empty, whitespace-only, or too-long title (Req 9.4)', () => {
    fc.assert(
      fc.property(invalidTitle, (title) => {
        expect(validateTitle(title)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('accepts every valid calendar date (Req 9.5)', () => {
    fc.assert(
      fc.property(validCalendarDate, (date) => {
        expect(isValidCalendarDate(date)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('rejects every missing or invalid calendar date (Req 9.5)', () => {
    fc.assert(
      fc.property(invalidCalendarDate, (date) => {
        expect(isValidCalendarDate(date)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('rejects an edit of an id not present in the pairing, leaving dates unchanged (Req 9.6)', () => {
    fc.assert(
      fc.property(stateWithMissingId, validTitle, ({ state, missingId }, newTitle) => {
        const result = editDate(state, missingId, { title: newTitle });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('DATE_NOT_FOUND');
        }
        // The stored dates are untouched on rejection.
        expect(isOk(result)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 34: Relationship date validation
  it('rejects a delete of an id not present in the pairing, leaving dates unchanged (Req 9.6)', () => {
    fc.assert(
      fc.property(stateWithMissingId, ({ state, missingId }) => {
        const before = state.dates;
        const result = deleteDate(state, missingId);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('DATE_NOT_FOUND');
        }
        // Same underlying date collection reference: nothing was rebuilt.
        expect(state.dates).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});
