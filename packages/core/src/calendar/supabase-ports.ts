/**
 * Caller-scoped Supabase implementation of CalendarPorts (Requirement 9).
 *
 * Reads and the Realtime subscription use the regular authenticated client, so
 * RLS remains the authorization boundary. Mutations intentionally invoke the
 * `calendar` Edge Function: server-side validation is required even when a
 * modified client bypasses the local preflight checks.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import { dateId, pairingId, reminderId, type CalendarDate, type DateId } from '../domain/common.js';
import type { RelationshipDate, Reminder, ReminderStatus } from '../domain/calendar.js';
import { isValidCalendarDate } from '../domain/calendar-helpers.js';
import { ERROR_CODES, type CalendarErrorCode } from '../errors.js';
import { narrowCode, readErrorEnvelope } from '../supabase/function-error.js';
import type {
  CalendarPorts,
  DateDeleteOutcome,
  DateMutationOutcome,
  DateRemoteChange,
  ReminderMutationOutcome,
} from './calendar-module.js';

const DATE_COLUMNS = 'id, pairing_id, title, date, recurring';
const CALENDAR_CODES: readonly string[] = [
  ERROR_CODES.INVALID_TITLE,
  ERROR_CODES.INVALID_DATE,
  ERROR_CODES.DATE_NOT_FOUND,
];
const REMINDER_CODES: readonly string[] = [
  ERROR_CODES.INVALID_LEAD_TIME,
  ERROR_CODES.DATE_NOT_FOUND,
];

/** A raw relationship-date row as PostgREST / Postgres Changes returns it. */
export interface RelationshipDateRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly title: string;
  readonly date: string;
  readonly recurring: boolean;
}

/** A raw reminder row or the stable camel-case calendar Function payload. */
export interface ReminderRow {
  readonly id: string;
  readonly date_id: string;
  readonly pairing_id: string;
  readonly lead_time_ms: number;
  readonly next_trigger_at: string;
  readonly status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse Postgres's `date` text without going through timezone-sensitive Date. */
export function calendarDateFromRow(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const date: CalendarDate = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return isValidCalendarDate(date) ? date : null;
}

function calendarDateFromValue(value: unknown): CalendarDate | null {
  if (typeof value === 'string') return calendarDateFromRow(value);
  return isValidCalendarDate(value) ? value : null;
}

/** Map either a snake-case table row or camel-case Edge Function date payload. */
export function relationshipDateFromWire(value: unknown): RelationshipDate | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const rawPairingId = value.pairing_id ?? value.pairingId;
  const title = value.title;
  const date = calendarDateFromValue(value.date);
  const recurring = value.recurring;
  if (
    typeof id !== 'string' ||
    typeof rawPairingId !== 'string' ||
    typeof title !== 'string' ||
    date === null ||
    typeof recurring !== 'boolean'
  ) {
    return null;
  }
  return { id: dateId(id), pairingId: pairingId(rawPairingId), title, date, recurring };
}

function idFromWire(value: unknown): DateId | null {
  return isRecord(value) && typeof value.id === 'string' ? dateId(value.id) : null;
}

function reminderStatusFromWire(value: unknown): ReminderStatus | null {
  return value === 'scheduled' || value === 'cancelled' || value === 'delivered' ? value : null;
}

/**
 * Map a database reminder or a stable calendar Function reminder payload.
 *
 * The database and domain API both use exact milliseconds. The function's
 * camel-case payload and an RLS table row therefore map without lossy unit
 * conversion.
 */
export function reminderFromWire(value: unknown): Reminder | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const rawDateId = value.date_id ?? value.dateId;
  const rawPairingId = value.pairing_id ?? value.pairingId;
  const leadTime = value.lead_time_ms ?? value.leadTime;
  const rawTrigger = value.next_trigger_at ?? value.nextTriggerAt;
  const status = reminderStatusFromWire(value.status);
  const nextTriggerAt =
    typeof rawTrigger === 'number'
      ? rawTrigger
      : typeof rawTrigger === 'string'
        ? Date.parse(rawTrigger)
        : Number.NaN;
  if (
    typeof id !== 'string' ||
    typeof rawDateId !== 'string' ||
    typeof rawPairingId !== 'string' ||
    typeof leadTime !== 'number' ||
    !Number.isFinite(leadTime) ||
    !Number.isFinite(nextTriggerAt) ||
    status === null
  ) {
    return null;
  }
  return {
    id: reminderId(id),
    dateId: dateId(rawDateId),
    pairingId: pairingId(rawPairingId),
    leadTime,
    nextTriggerAt,
    status,
  };
}

function calendarError(
  code: string | undefined,
  message: string | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
) {
  return {
    code: narrowCode<CalendarErrorCode>(code, CALENDAR_CODES, ERROR_CODES.DATE_NOT_FOUND),
    message: message ?? 'The calendar request failed.',
    ...(details === undefined ? {} : { details }),
  };
}

function reminderError(
  code: string | undefined,
  message: string | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
) {
  return {
    code: narrowCode(code, REMINDER_CODES, ERROR_CODES.DATE_NOT_FOUND),
    message: message ?? 'The reminder request failed.',
    ...(details === undefined ? {} : { details }),
  };
}

/** Build caller-scoped CalendarPorts around an authenticated Supabase client. */
export function createSupabaseCalendarPorts(client: SupabaseClient): CalendarPorts {
  async function invoke(
    body: Record<string, unknown>,
  ): Promise<DateMutationOutcome | DateDeleteOutcome> {
    const { data, error } = await client.functions.invoke<unknown>('calendar', { body });
    if (error) {
      const envelope = await readErrorEnvelope(error);
      return {
        ok: false,
        error: calendarError(envelope?.code, envelope?.message, envelope?.details),
      };
    }
    if (body.action === 'deleteDate') return { ok: true };

    const wrapped = isRecord(data) ? data.date : undefined;
    const date = relationshipDateFromWire(wrapped);
    if (date === null) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.DATE_NOT_FOUND,
          message: 'The calendar server returned an invalid relationship date.',
        },
      };
    }
    return { ok: true, date };
  }

  async function invokeReminder(id: DateId, leadTime: number): Promise<ReminderMutationOutcome> {
    const { data, error } = await client.functions.invoke<unknown>('calendar', {
      body: { action: 'setReminder', dateId: id, leadTime },
    });
    if (error) {
      const envelope = await readErrorEnvelope(error);
      return {
        ok: false,
        error: reminderError(envelope?.code, envelope?.message, envelope?.details),
      };
    }
    const reminder = reminderFromWire(isRecord(data) ? data.reminder : undefined);
    if (reminder === null) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.DATE_NOT_FOUND,
          message: 'The calendar server returned an invalid reminder.',
        },
      };
    }
    return { ok: true, reminder };
  }

  return {
    async fetchDates(): Promise<readonly RelationshipDate[] | null> {
      const { data, error } = await client.from('relationship_dates').select(DATE_COLUMNS);
      if (error || data === null) return null;
      const dates = data.map(relationshipDateFromWire);
      // A malformed row must not be accepted as a valid calendar entry. Return
      // null rather than a partial collection, preserving the last known view.
      if (dates.some((date) => date === null)) return null;
      return dates as RelationshipDate[];
    },

    async createDate(title, date, recurring): Promise<DateMutationOutcome> {
      const outcome = await invoke({ action: 'createDate', title, date, recurring });
      return outcome.ok || !('date' in outcome) ? (outcome as DateMutationOutcome) : outcome;
    },

    async editDate(id, title, date, recurring): Promise<DateMutationOutcome> {
      const outcome = await invoke({
        action: 'editDate',
        dateId: id,
        title,
        date,
        ...(recurring === undefined ? {} : { recurring }),
      });
      return outcome.ok || !('date' in outcome) ? (outcome as DateMutationOutcome) : outcome;
    },

    async deleteDate(id): Promise<DateDeleteOutcome> {
      const outcome = await invoke({ action: 'deleteDate', dateId: id });
      return outcome.ok || !('date' in outcome) ? (outcome as DateDeleteOutcome) : outcome;
    },

    async setReminder(id, leadTime): Promise<ReminderMutationOutcome> {
      return invokeReminder(id, leadTime);
    },

    subscribeDates(requestedPairingId, onChange): () => void {
      const channel: RealtimeChannel = client.channel(`calendar:${requestedPairingId}`);
      channel.on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'relationship_dates',
          filter: `pairing_id=eq.${requestedPairingId}`,
        } as never,
        (payload: {
          eventType?: string;
          new?: Record<string, unknown>;
          old?: Record<string, unknown>;
        }) => {
          const event = (payload.eventType ?? 'UPDATE') as DateRemoteChange['event'];
          const raw = event === 'DELETE' ? payload.old : payload.new;
          const id = idFromWire(raw);
          if (id === null) return;
          if (event === 'DELETE') {
            onChange({ event, id });
            return;
          }
          const date = relationshipDateFromWire(raw);
          if (date !== null) onChange({ event, id, date });
        },
      );
      channel.subscribe();
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
