// sync-write Edge Function: the server-authoritative shared-data write path
// (Requirements 5.2, 5.5, 5.6).
//
// Clients never write shared rows directly. They POST HLC-stamped `DataChange`
// objects here — one at a time while online, or a whole drained offline queue on
// reconnect (Req 5.5) — and this function:
//
//   1. authenticates the caller and confirms every change is stamped by that
//      account (a partner cannot forge the other's changes);
//   2. confirms the target row is inside the caller's own pairing (or, for
//      account-owned settings, is the caller's own row);
//   3. applies the shared, property-tested `resolveConflict` against the HLC
//      stored on the row and only writes when the incoming change wins, so a
//      stale offline change is reported as `superseded` instead of clobbering a
//      newer value (Req 5.5), and ties resolve deterministically (Req 5.6);
//   4. persists the winning change so it is present on the next session on any
//      client (Req 5.2). Committed rows are what the partner's Postgres Changes
//      subscription observes (Req 5.3, wired in task 14.2).
//
// Two layers cooperate, mirroring the pairing write path:
//   * the PURE decision above (`_shared/sync-items.ts` + `@ldr/core` HLC), and
//   * a DATABASE guard (`app.hlc_guard`, migration 20260826062554) that discards
//     any update whose `hlc` is strictly older than the stored one. The decision
//     here is a read-then-write, so the guard is what makes "a stale change never
//     clobbers a newer value" hold even when two writes interleave. When the
//     guard discards a write, the returned row still carries the newer stored
//     HLC, which this function reports back as `superseded`.
//
// A change is addressed by `itemType` + `itemId`. For tables with a composite
// primary key (`quiz_self_answers`, `quiz_guesses`) the `itemId` is the key
// columns joined with ":" — `"<sessionId>:<accountId>:<questionId>"`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { type SupabaseClient } from "@supabase/supabase-js";

import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import {
  authenticatedAccountId,
  serviceClient,
} from "../_shared/supabase.ts";
import {
  type AppliedChange,
  compareHLC,
  type DataChange,
} from "../_shared/sync-hlc.ts";
import {
  decideCommit,
  type ItemSpec,
  orderByHLC,
  parseChange,
  parseItemKey,
  parseStoredHLC,
  SYNC_ITEM_SPECS,
  type SyncError,
  type ValidatedChange,
} from "../_shared/sync-items.ts";

/** Upper bound on one drained-queue submission, to bound request work. */
const MAX_BATCH_SIZE = 200;

/** A failed change carries the stable code plus the HTTP status to return. */
interface Failure {
  readonly ok: false;
  readonly error: SyncError | { code: string; message: string; details?: Record<string, unknown> };
  readonly status: number;
}

type Outcome = { readonly ok: true; readonly applied: AppliedChange } | Failure;

/** Postgres error codes that mean "the client sent an invalid value". */
const CLIENT_DATA_PG_CODES = new Set([
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22P02", // invalid_text_representation (bad enum / uuid / number)
  "23502", // not_null_violation (required column missing on insert)
  "23503", // foreign_key_violation (unknown parent row)
  "23514", // check_violation (e.g. title length, lead-time range)
]);

const UNIQUE_VIOLATION = "23505";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "syncWrite must be called with POST.",
      405,
    );
  }

  const accountId = await authenticatedAccountId(req);
  if (!accountId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to write shared data.",
      401,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  const rawChanges = readRawChanges(body);
  if (rawChanges === null || rawChanges.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "Supply a `change` object or a non-empty `changes` array.",
      400,
      { fields: ["changes"] },
    );
  }
  if (rawChanges.length > MAX_BATCH_SIZE) {
    return errorResponse(
      "BATCH_TOO_LARGE",
      `A submission carries at most ${MAX_BATCH_SIZE} changes.`,
      statusForErrorCode("BATCH_TOO_LARGE"),
      { limit: MAX_BATCH_SIZE, received: rawChanges.length },
    );
  }

  // Validate the whole batch before touching the database: a malformed queue is
  // a client bug, and a partial application would be harder to reason about.
  const changes: ValidatedChange[] = [];
  for (let index = 0; index < rawChanges.length; index++) {
    const parsed = parseChange(rawChanges[index], accountId);
    if (!parsed.ok) {
      return errorResponse(
        parsed.error.code,
        parsed.error.message,
        statusForErrorCode(parsed.error.code),
        { index, ...parsed.error.details },
      );
    }
    changes.push(parsed.change);
  }

  const db = serviceClient();

  const pairing = await currentPairing(db, accountId);
  if (!pairing.ok) {
    return errorResponse(
      pairing.error.code,
      pairing.error.message,
      pairing.status,
    );
  }

  const results: AppliedChange[] = new Array(changes.length);

  // Apply oldest HLC first so several queued changes to the same item converge
  // on the newest one; results are returned in submission order.
  const entries = changes.map((change, index) => ({ change, index }));
  for (const entry of orderByHLC(entries)) {
    const outcome = await applyChange(
      db,
      entry.change,
      accountId,
      pairing.pairingId,
    );
    if (!outcome.ok) {
      return errorResponse(
        outcome.error.code,
        outcome.error.message,
        outcome.status,
        { index: entry.index, ...outcome.error.details },
      );
    }
    results[entry.index] = outcome.applied;
  }

  return jsonResponse({ results });
});

/** Accepts either `{ change }` (online write) or `{ changes }` (queue drain). */
function readRawChanges(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as Record<string, unknown>;
  if (Array.isArray(envelope.changes)) return envelope.changes;
  if (envelope.change !== undefined) return [envelope.change];
  return null;
}

/** The caller's active pairing id, or null when they are unpaired. */
async function currentPairing(
  db: SupabaseClient,
  accountId: string,
): Promise<
  { ok: true; pairingId: string | null } | Failure
> {
  const { data, error } = await db
    .from("accounts")
    .select("pairing_id")
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to load the caller's pairing.",
      },
    };
  }
  if (!data) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHENTICATED",
        message: "The authenticated account no longer exists.",
      },
    };
  }
  return { ok: true, pairingId: (data.pairing_id as string | null) ?? null };
}

/**
 * Resolve and persist a single change. `attempt` guards the one retry taken when
 * a concurrent insert wins the race to create the row, so the change is then
 * resolved against that row instead.
 */
async function applyChange(
  db: SupabaseClient,
  change: ValidatedChange,
  accountId: string,
  pairingId: string | null,
  attempt = 0,
): Promise<Outcome> {
  const spec = SYNC_ITEM_SPECS[change.itemType];
  const key = parseItemKey(spec, change.itemId);
  if (key === null) {
    // parseChange already validated the arity; unreachable in practice.
    return invalid(change, "INVALID_ITEM_ID", "Malformed `itemId`.");
  }

  const scope = await checkScope(db, spec, change, key, accountId, pairingId);
  if (!scope.ok) return scope;

  const selectColumns = spec.scope === "pairing" ? "hlc, pairing_id" : "hlc";
  const { data: existing, error: readError } = await db
    .from(spec.table)
    .select(selectColumns)
    .match(key)
    .maybeSingle();

  if (readError) {
    return internal("Failed to load the current value of the shared item.");
  }

  const row = existing as Record<string, unknown> | null;

  if (row === null) {
    if (!spec.insertable) {
      return {
        ok: false,
        status: statusForErrorCode("ITEM_NOT_FOUND"),
        error: {
          code: "ITEM_NOT_FOUND",
          message:
            `No ${change.itemType} exists for this id; it is created by its own ` +
            `server-authoritative flow, not by the sync write path.`,
          details: { itemId: change.itemId },
        },
      };
    }
    return await insertRow(db, spec, change, key, accountId, pairingId, attempt);
  }

  // The row exists: confirm it is inside the caller's pairing before reading or
  // overwriting it (the service-role client bypasses RLS, so this check is the
  // authorization boundary).
  if (spec.scope === "pairing") {
    const rowPairing = (row.pairing_id as string | null) ?? null;
    if (rowPairing === null || rowPairing !== pairingId) {
      return scopeViolation(change);
    }
  }

  const storedHLC = parseStoredHLC(row.hlc);
  if (!decideCommit(change, storedHLC)) {
    // Last-write-wins kept the newer stored value (Req 5.5).
    return { ok: true, applied: superseded(change) };
  }

  const values: Record<string, unknown> = {
    ...change.payload,
    hlc: change.hlc,
  };
  if (spec.hasUpdatedAt) values.updated_at = new Date().toISOString();

  const { data: written, error: writeError } = await db
    .from(spec.table)
    .update(values)
    .match(key)
    .select("hlc")
    .maybeSingle();

  if (writeError) return writeFailure(change, writeError);

  // `app.hlc_guard` discards an update that lost a concurrent race, leaving the
  // stored (newer) HLC in place — that is reported as superseded, not committed.
  const writtenHLC = parseStoredHLC(
    (written as Record<string, unknown> | null)?.hlc,
  );
  const committed = writtenHLC !== null &&
    compareHLC(writtenHLC, change.hlc) === 0;

  return {
    ok: true,
    applied: committed ? applied(change) : superseded(change),
  };
}

/** Create a missing row for an insertable item type. */
async function insertRow(
  db: SupabaseClient,
  spec: ItemSpec,
  change: ValidatedChange,
  key: Readonly<Record<string, string>>,
  accountId: string,
  pairingId: string | null,
  attempt: number,
): Promise<Outcome> {
  const values: Record<string, unknown> = {
    ...key,
    ...change.payload,
    hlc: change.hlc,
  };
  if (spec.scope === "pairing") values.pairing_id = pairingId;

  const { error } = await db.from(spec.table).insert(values);

  if (error) {
    // A concurrent writer created the row first: resolve against it instead.
    if (error.code === UNIQUE_VIOLATION && attempt === 0) {
      return await applyChange(db, change, accountId, pairingId, attempt + 1);
    }
    return writeFailure(change, error);
  }

  return { ok: true, applied: applied(change) };
}

/**
 * Ownership check performed before the row is read. Pairing-scoped items require
 * an active pairing; the quiz child tables inherit their pairing from the parent
 * session and may only be written for the caller's own account.
 */
async function checkScope(
  db: SupabaseClient,
  spec: ItemSpec,
  change: ValidatedChange,
  key: Readonly<Record<string, string>>,
  accountId: string,
  pairingId: string | null,
): Promise<{ ok: true } | Failure> {
  if (spec.scope === "account" || spec.scope === "quiz_session") {
    if (key.account_id !== undefined && key.account_id !== accountId) {
      return scopeViolation(change);
    }
  }

  if (spec.scope === "account") return { ok: true };

  if (pairingId === null) {
    return {
      ok: false,
      status: statusForErrorCode("NOT_PAIRED"),
      error: {
        code: "NOT_PAIRED",
        message: "Shared data can only be written by an account in a pairing.",
        details: { itemId: change.itemId },
      },
    };
  }

  if (spec.scope === "quiz_session") {
    const sessionId = key.session_id;
    const { data, error } = await db
      .from("quiz_sessions")
      .select("pairing_id")
      .eq("id", sessionId ?? "")
      .maybeSingle();

    if (error) return internal("Failed to load the parent quiz session.");
    if (!data) {
      return {
        ok: false,
        status: statusForErrorCode("ITEM_NOT_FOUND"),
        error: {
          code: "ITEM_NOT_FOUND",
          message: "The parent quiz session does not exist.",
          details: { itemId: change.itemId },
        },
      };
    }
    if ((data.pairing_id as string | null) !== pairingId) {
      return scopeViolation(change);
    }
  }

  return { ok: true };
}

function applied(change: DataChange): AppliedChange {
  return { change, appliedAt: Date.now(), superseded: false };
}

function superseded(change: DataChange): AppliedChange {
  return { change, appliedAt: Date.now(), superseded: true };
}

function scopeViolation(change: DataChange): Failure {
  return {
    ok: false,
    status: statusForErrorCode("PAIRING_SCOPE_VIOLATION"),
    error: {
      code: "PAIRING_SCOPE_VIOLATION",
      message: "The shared item does not belong to the caller.",
      details: { itemId: change.itemId },
    },
  };
}

function invalid(
  change: ValidatedChange,
  code: string,
  message: string,
): Failure {
  return {
    ok: false,
    status: statusForErrorCode(code),
    error: { code, message, details: { itemId: change.itemId } },
  };
}

function internal(message: string): Failure {
  return {
    ok: false,
    status: 500,
    error: { code: "INTERNAL_ERROR", message },
  };
}

/** Map a Postgres write failure to a client error or an internal error. */
function writeFailure(
  change: ValidatedChange,
  error: { code?: string; message?: string },
): Failure {
  if (error.code && CLIENT_DATA_PG_CODES.has(error.code)) {
    return {
      ok: false,
      status: statusForErrorCode("INVALID_CHANGE"),
      error: {
        code: "INVALID_CHANGE",
        message: "The change was rejected by a data constraint.",
        details: { itemId: change.itemId, reason: error.message },
      },
    };
  }
  return internal("Failed to persist the shared change.");
}
