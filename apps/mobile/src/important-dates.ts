import type { CalendarDate, RelationshipDate } from '@ldr/core';

export const ANNIVERSARY_TITLE = 'Anniversary';
export const FIRST_DATE_TITLE = 'First date';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface ImportantMilestone {
  readonly key: string;
  readonly date: CalendarDate;
  readonly label: string;
  readonly daysAway: number;
}

export function birthdayTitle(name: string): string {
  return `${name.trim() || 'Partner'}'s birthday`;
}

export function todayCalendarDate(now = Date.now()): CalendarDate {
  const date = new Date(now);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

export function calendarDateTimestamp(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function elapsedDays(from: CalendarDate, through: CalendarDate): number {
  return Math.max(
    0,
    Math.floor((calendarDateTimestamp(through) - calendarDateTimestamp(from)) / DAY_MS),
  );
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${MONTHS[date.month - 1]} ${date.day}, ${date.year}`;
}

export function findImportantDate(
  dates: readonly RelationshipDate[],
  title: string,
): RelationshipDate | undefined {
  const normalized = title.trim().toLocaleLowerCase();
  return dates.find((date) => date.title.trim().toLocaleLowerCase() === normalized);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(date: CalendarDate, amount: number): CalendarDate {
  const monthIndex = date.month - 1 + amount;
  const year = date.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  return { year, month, day: Math.min(date.day, lastDayOfMonth(year, month)) };
}

function addDays(date: CalendarDate, amount: number): CalendarDate {
  const next = new Date(calendarDateTimestamp(date) + amount * DAY_MS);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function nextAnnual(date: CalendarDate, today: CalendarDate): CalendarDate {
  const inYear = (year: number): CalendarDate => ({
    year,
    month: date.month,
    day: Math.min(date.day, lastDayOfMonth(year, date.month)),
  });
  const candidate = inYear(today.year);
  return calendarDateTimestamp(candidate) >= calendarDateTimestamp(today)
    ? candidate
    : inYear(today.year + 1);
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** Upcoming monthly, yearly, fifty-day, birthday, and first-date landmarks. */
export function buildImportantMilestones({
  dates,
  selfName,
  partnerName,
  today = todayCalendarDate(),
  limit = 14,
}: {
  readonly dates: readonly RelationshipDate[];
  readonly selfName: string;
  readonly partnerName: string;
  readonly today?: CalendarDate;
  readonly limit?: number;
}): readonly ImportantMilestone[] {
  const todayAt = calendarDateTimestamp(today);
  const candidates: Array<{ date: CalendarDate; label: string }> = [];
  const anniversary = findImportantDate(dates, ANNIVERSARY_TITLE);

  if (anniversary !== undefined) {
    const monthsElapsed = Math.max(
      0,
      (today.year - anniversary.date.year) * 12 + today.month - anniversary.date.month - 1,
    );
    for (let month = Math.max(1, monthsElapsed); month <= monthsElapsed + 18; month += 1) {
      const date = addMonths(anniversary.date, month);
      if (calendarDateTimestamp(date) >= todayAt) {
        candidates.push({ date, label: `${plural(month, 'month')} together` });
      }
    }

    const currentDays = elapsedDays(anniversary.date, today);
    const firstFifty = Math.max(50, Math.ceil(currentDays / 50) * 50);
    for (let days = firstFifty; days <= firstFifty + 600; days += 50) {
      candidates.push({ date: addDays(anniversary.date, days), label: `${days} days together` });
    }

    const yearsElapsed = Math.max(1, today.year - anniversary.date.year - 1);
    for (let year = yearsElapsed; year <= yearsElapsed + 5; year += 1) {
      const date = addMonths(anniversary.date, year * 12);
      if (calendarDateTimestamp(date) >= todayAt) {
        candidates.push({ date, label: `${plural(year, 'year')} together` });
      }
    }
  }

  for (const name of [selfName, partnerName]) {
    const birthday = findImportantDate(dates, birthdayTitle(name));
    if (birthday !== undefined) {
      candidates.push({ date: nextAnnual(birthday.date, today), label: `${name}'s birthday` });
    }
  }

  const firstDate = findImportantDate(dates, FIRST_DATE_TITLE);
  if (firstDate !== undefined) {
    candidates.push({ date: nextAnnual(firstDate.date, today), label: 'First-date anniversary' });
  }

  const grouped = new Map<string, { date: CalendarDate; labels: string[] }>();
  for (const candidate of candidates) {
    const stamp = calendarDateTimestamp(candidate.date);
    if (stamp < todayAt) continue;
    const key = `${candidate.date.year}-${candidate.date.month}-${candidate.date.day}`;
    const current = grouped.get(key);
    if (current === undefined)
      grouped.set(key, { date: candidate.date, labels: [candidate.label] });
    else if (!current.labels.includes(candidate.label)) current.labels.push(candidate.label);
  }

  return [...grouped.entries()]
    .map(([key, value]) => ({
      key,
      date: value.date,
      label: value.labels.join(' · '),
      daysAway: elapsedDays(today, value.date),
    }))
    .sort((left, right) => calendarDateTimestamp(left.date) - calendarDateTimestamp(right.date))
    .slice(0, limit);
}
