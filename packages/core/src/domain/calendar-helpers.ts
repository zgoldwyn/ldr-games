/**
 * Pure, deterministic calendar and reminder helpers (Requirements 9 and 10).
 *
 * These functions are shared verbatim between the platform clients and the
 * write/scheduling Edge Functions so both agree on title/date validity, the
 * canonical ordering of relationship dates, when a recurring date next occurs,
 * and when a reminder should fire. Every function is a pure function of its
 * inputs with no side effects, which makes them straightforward to
 * property-test.
 *
 * Calendar dates carry no time component; where a wall-clock instant is needed
 * (reminder trigger calculation) a date is anchored to midnight UTC of that
 * day so the mapping is stable regardless of the caller's local time zone.
 */
import { err, ok, type Result } from '../result.js';
import type { ReminderError } from '../errors.js';
import type { CalendarDate, Duration, Timestamp } from './common.js';
import type { RelationshipDate } from './calendar.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Inclusive length bounds for a relationship-date title (Requirement 9.4). */
const TITLE_MIN_LENGTH = 1;
const TITLE_MAX_LENGTH = 100;

/** Number of milliseconds in one minute. */
const MS_PER_MINUTE = 60_000;
/** Number of milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Inclusive lead-time bounds for a reminder (Requirements 10.1, 10.2). */
export const MIN_LEAD_TIME: Duration = MS_PER_MINUTE; // 1 minute
export const MAX_LEAD_TIME: Duration = 365 * MS_PER_DAY; // 365 days

// ---------------------------------------------------------------------------
// Title validation (Requirement 9.4)
// ---------------------------------------------------------------------------

/**
 * Whether `title` is a valid relationship-date title: non-empty after trimming
 * surrounding whitespace and between {@link TITLE_MIN_LENGTH} and
 * {@link TITLE_MAX_LENGTH} characters once trimmed (Requirement 9.4).
 *
 * A missing, empty, or whitespace-only title trims to length 0 and is rejected;
 * a title whose trimmed length exceeds 100 characters is rejected.
 */
export function validateTitle(title: string): boolean {
  if (typeof title !== 'string') {
    return false;
  }
  const trimmed = title.trim();
  return trimmed.length >= TITLE_MIN_LENGTH && trimmed.length <= TITLE_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// Calendar-date validation (Requirement 9.5)
// ---------------------------------------------------------------------------

/** Whether `year` is a Gregorian leap year. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Number of days in the given 1-based `month` of `year` (1-12). */
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
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Whether `d` is a valid {@link CalendarDate} (Requirement 9.5): an object with
 * integer `year` (1-9999), `month` (1-12), and `day` fields where `day` is a
 * real day of that month/year (leap years respected). Any other shape — a
 * missing field, a non-integer, or a day out of range for the month — is
 * invalid.
 */
export function isValidCalendarDate(d: unknown): d is CalendarDate {
  if (typeof d !== 'object' || d === null) {
    return false;
  }
  const { year, month, day } = d as Record<string, unknown>;
  if (
    typeof year !== 'number' ||
    typeof month !== 'number' ||
    typeof day !== 'number' ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  if (year < 1 || year > 9999 || month < 1 || month > 12) {
    return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

// ---------------------------------------------------------------------------
// Calendar-date comparison and conversion
// ---------------------------------------------------------------------------

/**
 * Total ordering on calendar dates by (year, month, day). Returns a negative
 * number when `a` is earlier than `b`, a positive number when later, and 0 when
 * they denote the same day.
 */
export function compareCalendarDate(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) {
    return a.year - b.year;
  }
  if (a.month !== b.month) {
    return a.month - b.month;
  }
  return a.day - b.day;
}

/**
 * Clamp `day` to the last valid day of `month`/`year`. Used when projecting a
 * recurring date into a year where its day does not exist (for example a
 * February 29 anniversary in a non-leap year clamps to February 28).
 */
function clampDay(year: number, month: number, day: number): number {
  const last = daysInMonth(year, month);
  return day > last ? last : day;
}

/**
 * The wall-clock instant for a calendar date, anchored to midnight UTC of that
 * day. This gives a stable, time-zone-independent mapping used by
 * {@link reminderTriggerTime}.
 */
export function calendarDateToTimestamp(d: CalendarDate): Timestamp {
  return Date.UTC(d.year, d.month - 1, d.day);
}

// ---------------------------------------------------------------------------
// Next occurrence (Requirements 9.7, 10.5)
// ---------------------------------------------------------------------------

/**
 * The next upcoming occurrence of a relationship date relative to `now`
 * (inclusive of `now` itself).
 *
 * - A non-recurring date occurs exactly once, so its own `date` is returned
 *   unchanged regardless of whether it is in the past or future.
 * - A recurring date recurs annually on the same month/day. The returned
 *   occurrence is that month/day in the smallest year, at or after `now.year`,
 *   whose date falls on or after `now`. When the day does not exist in the
 *   target year (a February 29 anniversary in a non-leap year) it is clamped to
 *   the last day of the month.
 */
export function nextOccurrence(d: RelationshipDate, now: CalendarDate): CalendarDate {
  if (!d.recurring) {
    return d.date;
  }
  const { month, day } = d.date;
  const candidateFor = (year: number): CalendarDate => ({
    year,
    month,
    day: clampDay(year, month, day),
  });
  let candidate = candidateFor(now.year);
  if (compareCalendarDate(candidate, now) < 0) {
    candidate = candidateFor(now.year + 1);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Ordering (Requirement 9.7)
// ---------------------------------------------------------------------------

/** Case-insensitive, deterministic comparison of two titles. */
function compareTitleCaseInsensitive(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al < bl) {
    return -1;
  }
  if (al > bl) {
    return 1;
  }
  return 0;
}

/**
 * Order relationship dates for display (Requirement 9.7): ascending by next
 * upcoming occurrence relative to `now`, with dates sharing the same next
 * occurrence ordered alphabetically by title using a case-insensitive
 * comparison. Returns a new array; the input is not mutated.
 */
export function orderDates(dates: RelationshipDate[], now: CalendarDate): RelationshipDate[] {
  return [...dates].sort((a, b) => {
    const occurrenceOrder = compareCalendarDate(
      nextOccurrence(a, now),
      nextOccurrence(b, now),
    );
    if (occurrenceOrder !== 0) {
      return occurrenceOrder;
    }
    return compareTitleCaseInsensitive(a.title, b.title);
  });
}

// ---------------------------------------------------------------------------
// Reminder trigger time (Requirements 10.1, 10.2)
// ---------------------------------------------------------------------------

/**
 * The instant a reminder should fire: the reminder's `occurrence` (anchored to
 * midnight UTC) minus its `leadTime`. This is the pure calculation only; it
 * performs no range or future-time validation (see {@link isValidLeadTime} and
 * {@link resolveReminderTrigger}).
 */
export function reminderTriggerTime(occurrence: CalendarDate, leadTime: Duration): Timestamp {
  return calendarDateToTimestamp(occurrence) - leadTime;
}

/**
 * Whether `leadTime` is within the allowed reminder range of 1 minute to 365
 * days inclusive (Requirements 10.1, 10.2).
 */
export function isValidLeadTime(leadTime: Duration): boolean {
  return Number.isFinite(leadTime) && leadTime >= MIN_LEAD_TIME && leadTime <= MAX_LEAD_TIME;
}

/**
 * Resolve and validate a reminder's trigger time (Requirements 10.1, 10.2).
 *
 * Returns the trigger time (occurrence minus lead time) when — and only when —
 * the lead time is between 1 minute and 365 days inclusive and the resulting
 * trigger time is strictly later than `now`. Otherwise the request is rejected
 * with an `INVALID_LEAD_TIME` error, leaving the caller (the `setReminder`
 * service, Requirement 10) to surface it.
 */
export function resolveReminderTrigger(
  occurrence: CalendarDate,
  leadTime: Duration,
  now: Timestamp,
): Result<Timestamp, ReminderError> {
  if (!isValidLeadTime(leadTime)) {
    return err({
      code: 'INVALID_LEAD_TIME',
      message: 'Reminder lead time must be between 1 minute and 365 days.',
    });
  }
  const trigger = reminderTriggerTime(occurrence, leadTime);
  if (trigger <= now) {
    return err({
      code: 'INVALID_LEAD_TIME',
      message: 'Reminder trigger time must be later than the current time.',
    });
  }
  return ok(trigger);
}
