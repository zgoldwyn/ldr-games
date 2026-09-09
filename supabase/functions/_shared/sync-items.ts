// Pure request-shaping and decision logic for the sync write path (task 14.1).
//
// Requirements: 5.2, 5.5, 5.6
//
// Everything in this module is pure so it can be unit tested without a database
// (`sync-items.test.ts`). It answers three questions for the `sync-write` Edge
// Function:
//
//   1. WHERE does a `DataChange` land? -> `SYNC_ITEM_SPECS` maps each
//      `SharedItemType` to its table, primary-key columns, ownership scope, and
//      the whitelist of columns a client is allowed to write. The whitelist is
//      the authorization boundary for column-level writes: `pairing_id`,
//      `account_id`, timestamps and `hlc` are set by the server, never by the
//      payload, so a client cannot re-home a row into another pairing.
//   2. Is the change WELL FORMED? -> `parseChange` validates the item type, the
//      composite item id, the HLC shape, and that the change is stamped by the
//      calling account.
//   3. Does the change WIN? -> `decideCommit` runs the shared, property-tested
//      `resolveConflict` against the HLC stored on the row, so a stale offline
//      change is reported as `superseded` instead of overwriting a newer value
//      (Req 5.5) and ties resolve deterministically (Req 5.6).

import type { AppError } from "./errors.ts";
import {
  accountId,
  compareHLC,
  type DataChange,
  type HLCTimestamp,
  resolveConflict,
  type SharedItemType,
} from "./sync-hlc.ts";

/** Stable error codes returned by the sync write path. */
export type SyncErrorCode =
  | "MISSING_REQUIRED_FIELD" // no changes supplied, or a change is missing a field
  | "INVALID_ITEM_TYPE" // itemType is not a known SharedItemType
  | "INVALID_ITEM_ID" // itemId does not match the item's key arity
  | "INVALID_HLC" // hlc is missing or structurally invalid
  | "INVALID_CHANGE" // payload writes unknown/forbidden columns, or is rejected by a constraint
  | "ORIGIN_MISMATCH" // the change is stamped by an account other than the caller
  | "PAIRING_SCOPE_VIOLATION" // the target row belongs to another pairing/account
  | "NOT_PAIRED" // pairing-scoped write by an unpaired account
  | "ITEM_NOT_FOUND"; // update-only item type with no existing row

export type SyncError = AppError<SyncErrorCode>;

/** How a row's ownership is established before it may be written. */
export type ItemScope =
  /** Row carries `pairing_id`; must equal the caller's active pairing. */
  | "pairing"
  /** Row is keyed by the caller's own `account_id`. */
  | "account"
  /** Ownership is inherited from the parent `quiz_sessions` row. */
  | "quiz_session";

/** Everything the write path needs to know about one shared item type. */
export interface ItemSpec {
  /** Target table. */
  readonly table: string;
  /**
   * Primary-key columns, in the order they appear in a composite `itemId`
   * (colon-joined, e.g. `"<sessionId>:<accountId>:<questionId>"`).
   */
  readonly keyColumns: readonly string[];
  /** How ownership of the row is checked. */
  readonly scope: ItemScope;
  /** Columns a client change is allowed to write. */
  readonly writableColumns: readonly string[];
  /** Whether the table has an `updated_at` column the server should bump. */
  readonly hasUpdatedAt: boolean;
  /**
   * Whether the write path may CREATE a missing row. Sessions are created by
   * their own server-authoritative flows (game invite, quiz start), so a change
   * for a missing session row is an error rather than an insert.
   */
  readonly insertable: boolean;
}

/**
 * The sync queue has a broader domain union, but reminder rows are derived and
 * intentionally excluded from this service-role write path.
 */
export type SynchronizedItemType = Exclude<SharedItemType, "reminder">;

// Reminders are intentionally absent.  Their trigger and lifecycle status are
// server-derived, so accepting an HLC sync change here would give a modified
// client a service-role bypass around set_calendar_reminder.
export const SYNC_ITEM_SPECS: Readonly<Record<SynchronizedItemType, ItemSpec>> =
  {
    relationship_date: {
      table: "relationship_dates",
      keyColumns: ["id"],
      scope: "pairing",
      writableColumns: ["title", "date", "recurring"],
      hasUpdatedAt: true,
      insertable: true,
    },
    rt_session: {
      table: "rt_sessions",
      keyColumns: ["id"],
      scope: "pairing",
      writableColumns: [
        "state",
        "game_state",
        "outcome",
        "pending_since",
        "paused_since",
      ],
      hasUpdatedAt: true,
      insertable: false,
    },
    async_session: {
      table: "async_sessions",
      keyColumns: ["id"],
      scope: "pairing",
      writableColumns: [
        "state",
        "active_turn_holder",
        "turn_pending_since",
        "game_state",
        "outcome",
      ],
      hasUpdatedAt: true,
      insertable: false,
    },
    quiz_session: {
      table: "quiz_sessions",
      keyColumns: ["id"],
      scope: "pairing",
      writableColumns: ["phase", "scores"],
      hasUpdatedAt: true,
      insertable: false,
    },
    quiz_self_answer: {
      table: "quiz_self_answers",
      keyColumns: ["session_id", "account_id", "question_id"],
      scope: "quiz_session",
      writableColumns: ["answer"],
      hasUpdatedAt: false,
      insertable: true,
    },
    quiz_guess: {
      table: "quiz_guesses",
      keyColumns: ["session_id", "account_id", "question_id"],
      scope: "quiz_session",
      writableColumns: ["guess"],
      hasUpdatedAt: false,
      insertable: true,
    },
    notification_settings: {
      table: "notification_settings",
      keyColumns: ["account_id"],
      scope: "account",
      writableColumns: [
        "disabled_categories",
        "apns_device_token",
        "apns_environment",
      ],
      hasUpdatedAt: true,
      insertable: true,
    },
  };

/** True when `value` names a shared item type the write path understands. */
export function isSharedItemType(
  value: unknown,
): value is SynchronizedItemType {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SYNC_ITEM_SPECS, value);
}

/** The composite-key separator used inside an `itemId`. */
export const ITEM_ID_SEPARATOR = ":";

/**
 * Split an `itemId` into its key columns. Returns null when the number of parts
 * does not match the table's key arity or any part is empty.
 */
export function parseItemKey(
  spec: ItemSpec,
  itemId: string,
): Readonly<Record<string, string>> | null {
  const parts = itemId.split(ITEM_ID_SEPARATOR);
  if (parts.length !== spec.keyColumns.length) return null;
  const key: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const column = spec.keyColumns[i];
    if (!part || part.length === 0 || column === undefined) return null;
    key[column] = part;
  }
  return key;
}

/** True when `value` is a non-negative, finite, integral number. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True when `value` has the structural shape of an {@link HLCTimestamp}. */
export function isHLCTimestamp(value: unknown): value is HLCTimestamp {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isCount(candidate.physical) &&
    isCount(candidate.counter) &&
    typeof candidate.originAccountId === "string" &&
    candidate.originAccountId.length > 0;
}

/**
 * Read the HLC stored in a row's `hlc` jsonb column. A row written before it
 * joined the sync path (or holding a malformed timestamp) reads as null, which
 * `decideCommit` treats as "older than anything".
 */
export function parseStoredHLC(value: unknown): HLCTimestamp | null {
  if (!isHLCTimestamp(value)) return null;
  return {
    physical: value.physical,
    counter: value.counter,
    originAccountId: value.originAccountId,
  };
}

/** A plain JSON object (payloads are column maps, never arrays or scalars). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A {@link DataChange} that has been through {@link parseChange}.
 *
 * Core declares `payload` as `unknown` on purpose — the client-side sync queue
 * is payload-agnostic and its property tests stamp arbitrary values. The write
 * path is not: a payload here is always a column map destined for an UPDATE or
 * INSERT, which `parseChange` verifies. Narrowing it once at the validation
 * boundary is what lets the write path spread `change.payload` into a row
 * without re-asserting the shape at every use.
 */
export interface ValidatedChange extends DataChange {
  readonly itemType: SynchronizedItemType;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Validate one raw change from the request body and normalize it into a
 * {@link ValidatedChange}. `callerAccountId` is the authenticated account: a
 * change must be stamped by (and its HLC originate from) that account, so one
 * partner cannot forge changes attributed to the other.
 */
export function parseChange(
  raw: unknown,
  callerAccountId: string,
): { ok: true; change: ValidatedChange } | { ok: false; error: SyncError } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: "INVALID_CHANGE",
        message: "A change must be an object.",
      },
    };
  }

  if (!isSharedItemType(raw.itemType)) {
    return {
      ok: false,
      error: {
        code: "INVALID_ITEM_TYPE",
        message: "`itemType` is not a synchronized shared item type.",
        details: { itemType: raw.itemType },
      },
    };
  }
  const spec = SYNC_ITEM_SPECS[raw.itemType];

  if (typeof raw.itemId !== "string" || raw.itemId.length === 0) {
    return {
      ok: false,
      error: {
        code: "MISSING_REQUIRED_FIELD",
        message: "A change requires a non-empty `itemId`.",
        details: { fields: ["itemId"] },
      },
    };
  }
  if (parseItemKey(spec, raw.itemId) === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_ITEM_ID",
        message:
          `\`itemId\` for ${raw.itemType} must be ${spec.keyColumns.length} ` +
          `non-empty part(s) joined by "${ITEM_ID_SEPARATOR}" ` +
          `(${spec.keyColumns.join(ITEM_ID_SEPARATOR)}).`,
        details: { itemId: raw.itemId, keyColumns: spec.keyColumns },
      },
    };
  }

  if (!isHLCTimestamp(raw.hlc)) {
    return {
      ok: false,
      error: {
        code: "INVALID_HLC",
        message: "`hlc` must be { physical: non-negative integer, counter: " +
          "non-negative integer, originAccountId: string }.",
        details: { itemId: raw.itemId },
      },
    };
  }

  if (!isPlainObject(raw.payload)) {
    return {
      ok: false,
      error: {
        code: "INVALID_CHANGE",
        message: "`payload` must be an object of column values.",
        details: { itemId: raw.itemId },
      },
    };
  }

  const unknownFields = Object.keys(raw.payload).filter(
    (column) => !spec.writableColumns.includes(column),
  );
  if (unknownFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_CHANGE",
        message: `\`payload\` writes fields that are not client-writable on ` +
          `${raw.itemType}.`,
        details: {
          itemId: raw.itemId,
          unknownFields,
          writableColumns: spec.writableColumns,
        },
      },
    };
  }

  const originAccountId = raw.originAccountId ?? raw.hlc.originAccountId;
  if (
    typeof originAccountId !== "string" ||
    originAccountId !== callerAccountId ||
    raw.hlc.originAccountId !== callerAccountId
  ) {
    return {
      ok: false,
      error: {
        code: "ORIGIN_MISMATCH",
        message:
          "A change must be stamped by the authenticated account that submits it.",
        details: { itemId: raw.itemId },
      },
    };
  }

  return {
    ok: true,
    change: {
      itemId: raw.itemId,
      itemType: raw.itemType,
      payload: { ...raw.payload },
      hlc: {
        physical: raw.hlc.physical,
        counter: raw.hlc.counter,
        originAccountId: accountId(raw.hlc.originAccountId),
      },
      // Validated above to equal `callerAccountId`, so branding it here is
      // asserting a fact the checks already established.
      originAccountId: accountId(originAccountId),
    },
  };
}

/**
 * Decide whether `incoming` may overwrite the value a row currently holds,
 * using the shared last-write-wins resolution (Req 5.5, 5.6).
 *
 * The stored HLC is lifted into a synthetic `DataChange` so the decision is made
 * by the very same `resolveConflict` the clients use (Property 18). Because
 * `resolveConflict` returns its FIRST argument on a tie, passing the stored
 * change first means an equal timestamp keeps the stored value: replaying an
 * already-applied change (a duplicate in a drained offline queue) is a no-op
 * rather than a rewrite, and a strictly older change is reported as superseded.
 */
export function decideCommit(
  incoming: DataChange,
  storedHLC: HLCTimestamp | null,
): boolean {
  if (storedHLC === null) return true;

  const stored: DataChange = {
    itemId: incoming.itemId,
    itemType: incoming.itemType,
    payload: {},
    hlc: storedHLC,
    originAccountId: storedHLC.originAccountId,
  };

  return resolveConflict(stored, incoming) === incoming;
}

/**
 * Order a batch of changes oldest-HLC-first so that, when a drained offline
 * queue carries several changes to the same item, the newest one is applied last
 * and the row converges on it. Ties keep the submission order (Req 5.5).
 */
export function orderByHLC<T extends { change: DataChange; index: number }>(
  entries: readonly T[],
): T[] {
  return entries.slice().sort((left, right) => {
    const byHLC = compareHLC(left.change.hlc, right.change.hlc);
    return byHLC !== 0 ? byHLC : left.index - right.index;
  });
}
