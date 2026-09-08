/**
 * Client calendar module (Requirement 9).
 *
 * Relationship dates are a shared, pairing-scoped projection.  The database
 * remains the authority: writes go through the `calendar` Edge Function so the
 * same title/date checks run on the server, and the authenticated client reads
 * and subscribes through RLS.  This module owns the useful client concerns:
 * local preflight validation, display ordering, a last-known cache, and making
 * an in-flight list unable to resurrect a date that a later Realtime event has
 * removed.
 */
import type { CalendarDate, DateId, PairingId } from '../domain/common.js';
import type { RelationshipDate } from '../domain/calendar.js';
import { isValidCalendarDate, orderDates, validateTitle } from '../domain/calendar-helpers.js';
import { ERROR_CODES, type CalendarError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

/** A committed relationship-date mutation observed through Postgres Changes. */
export interface DateRemoteChange {
  readonly event: 'INSERT' | 'UPDATE' | 'DELETE';
  /** INSERT/UPDATE carry a complete mapped date; DELETE needs only its id. */
  readonly date?: RelationshipDate;
  readonly id: DateId;
}

/** Result of a server-authoritative create or edit. */
export type DateMutationOutcome =
  | { readonly ok: true; readonly date: RelationshipDate }
  | { readonly ok: false; readonly error: CalendarError };

/** Result of a server-authoritative delete. */
export type DateDeleteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: CalendarError };

/** The deliberately small collaborators the module needs. */
export interface CalendarPorts {
  /** Caller-scoped RLS read; null means the read did not complete. */
  readonly fetchDates: () => Promise<readonly RelationshipDate[] | null>;
  /** `calendar { action: 'createDate', title, date, recurring }`. */
  readonly createDate: (
    title: string,
    date: CalendarDate,
    recurring: boolean,
  ) => Promise<DateMutationOutcome>;
  /** `calendar { action: 'editDate', dateId, title, date }`. */
  readonly editDate: (
    id: DateId,
    title: string,
    date: CalendarDate,
    recurring?: boolean,
  ) => Promise<DateMutationOutcome>;
  /** `calendar { action: 'deleteDate', dateId }`. */
  readonly deleteDate: (id: DateId) => Promise<DateDeleteOutcome>;
  /** Pairing-filtered Postgres Changes, already constrained by RLS. */
  readonly subscribeDates: (
    pairingId: PairingId,
    onChange: (change: DateRemoteChange) => void,
  ) => () => void;
}

/** A callback for screens that render synchronously from the last-known cache. */
export type CalendarCacheListener = () => void;

export interface CalendarModule {
  /** Create a valid date through the server-authoritative write function. */
  createDate(
    title: string,
    date: CalendarDate,
    recurring: boolean,
  ): Promise<Result<RelationshipDate, CalendarError>>;
  /** Edit title/date; recurrence is deliberately unchanged by this operation. */
  editDate(
    id: DateId,
    title: string,
    date: CalendarDate,
    recurring?: boolean,
  ): Promise<Result<RelationshipDate, CalendarError>>;
  /** Delete the date (and, server-side, its cascading reminders). */
  deleteDate(id: DateId): Promise<Result<void, CalendarError>>;
  /** RLS-backed list ordered for display by next occurrence and title. */
  listDates(now: CalendarDate): Promise<readonly RelationshipDate[]>;
  /** Start receiving committed partner/local changes for one pairing. */
  subscribe(pairingId: PairingId): void;
  /** Stop the active Postgres Changes subscription. */
  unsubscribe(): void;
  /** Apply a date change forwarded by a subscription or Connection Manager. */
  applyRemoteChange(change: DateRemoteChange): void;
  /** Last-known ordered dates, available immediately and while offline. */
  cached(now: CalendarDate): readonly RelationshipDate[];
  /** Observe cache changes. */
  subscribeCache(listener: CalendarCacheListener): () => void;
}

function invalidTitle(): CalendarError {
  return {
    code: ERROR_CODES.INVALID_TITLE,
    message: 'Relationship date titles must be 1 to 100 non-whitespace characters.',
  };
}

function invalidDate(): CalendarError {
  return {
    code: ERROR_CODES.INVALID_DATE,
    message: 'Relationship dates must use a valid calendar date.',
  };
}

/**
 * Build a calendar module over authenticated client ports.
 *
 * `revision` and `changedAt` are a small race guard around `listDates`: a
 * Realtime deletion/update that lands while a previous list request is in
 * flight wins over that stale response.  DELETEs leave a tombstone revision,
 * so an old response cannot put the removed row back in the cache.
 */
export function createCalendarModule(ports: CalendarPorts): CalendarModule {
  const dates = new Map<DateId, RelationshipDate>();
  const changedAt = new Map<DateId, number>();
  const listeners = new Set<CalendarCacheListener>();
  let revision = 0;
  // Each list starts a new generation. A response from a request started before
  // another list must never replace the later request's view, even if it happens
  // to arrive last.
  let latestListGeneration = 0;
  let teardown: (() => void) | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function remember(date: RelationshipDate): void {
    revision += 1;
    changedAt.set(date.id, revision);
    dates.set(date.id, date);
    notify();
  }

  function forget(id: DateId): void {
    revision += 1;
    // Keep the revision even when this device had not cached the row. A DELETE
    // replay may race a stale list response and still must win that race.
    changedAt.set(id, revision);
    const didDelete = dates.delete(id);
    if (didDelete) notify();
  }

  function valid(title: string, date: CalendarDate): CalendarError | null {
    if (!validateTitle(title)) return invalidTitle();
    if (!isValidCalendarDate(date)) return invalidDate();
    return null;
  }

  function mergeList(fetched: readonly RelationshipDate[], startedAt: number): void {
    const fetchedIds = new Set(fetched.map((date) => date.id));
    let changed = false;

    for (const date of fetched) {
      // A local mutation or Realtime event after the request started is newer
      // than this response. Leave it alone rather than rewinding the cache.
      if ((changedAt.get(date.id) ?? 0) > startedAt) continue;
      const previous = dates.get(date.id);
      if (previous !== date) {
        dates.set(date.id, date);
        changed = true;
      }
    }

    for (const id of [...dates.keys()]) {
      if (fetchedIds.has(id) || (changedAt.get(id) ?? 0) > startedAt) continue;
      dates.delete(id);
      changed = true;
    }

    if (changed) {
      // A successfully applied read is a cache write too. Advancing the
      // revision makes an older in-flight response treat every touched row as
      // newer than its own starting point rather than overwriting this view.
      revision += 1;
      const mergedAt = revision;
      for (const date of fetched) {
        if ((changedAt.get(date.id) ?? 0) <= startedAt) changedAt.set(date.id, mergedAt);
      }
      notify();
    }
  }

  function applyRemoteChange(change: DateRemoteChange): void {
    if (change.event === 'DELETE') {
      forget(change.id);
      return;
    }
    // A malformed INSERT/UPDATE must not erase a known-good cached date.
    if (change.date !== undefined) remember(change.date);
  }

  return {
    async createDate(title, date, recurring): Promise<Result<RelationshipDate, CalendarError>> {
      const problem = valid(title, date);
      if (problem !== null) return err(problem);

      const outcome = await ports.createDate(title, date, recurring);
      if (!outcome.ok) return err(outcome.error);
      remember(outcome.date);
      return ok(outcome.date);
    },

    async editDate(id, title, date, recurring): Promise<Result<RelationshipDate, CalendarError>> {
      const problem = valid(title, date);
      if (problem !== null) return err(problem);

      const outcome = await ports.editDate(id, title, date, recurring);
      if (!outcome.ok) return err(outcome.error);
      remember(outcome.date);
      return ok(outcome.date);
    },

    async deleteDate(id): Promise<Result<void, CalendarError>> {
      const outcome = await ports.deleteDate(id);
      if (!outcome.ok) return err(outcome.error);
      forget(id);
      return ok(undefined);
    },

    async listDates(now): Promise<readonly RelationshipDate[]> {
      const startedAt = revision;
      const generation = ++latestListGeneration;
      const fetched = await ports.fetchDates();
      // Preserve the useful last-known data through a transient failed read.
      // It also means a caller can render the same surface offline.
      if (fetched !== null && generation === latestListGeneration) {
        mergeList(fetched, startedAt);
      }
      return orderDates([...dates.values()], now);
    },

    subscribe(pairingId): void {
      teardown?.();
      teardown = ports.subscribeDates(pairingId, (change) => {
        applyRemoteChange(change);
      });
    },

    unsubscribe(): void {
      teardown?.();
      teardown = null;
    },

    applyRemoteChange(change): void {
      applyRemoteChange(change);
    },

    cached(now): readonly RelationshipDate[] {
      return orderDates([...dates.values()], now);
    },

    subscribeCache(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
