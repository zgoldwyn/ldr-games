// Relationship-date calendar write endpoint (Requirements 9.1-9.6).
//
// The function validates the public request with the shared pure domain
// helpers, then writes through a bearer-token-scoped Supabase client. Calendar
// create/edit/delete retain that RLS write path; setReminder uses a narrowly
// service-role-only SQL RPC after caller authentication so its derived trigger,
// pairing, and session checks occur atomically under row locks.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import type { SupabaseClient } from "@supabase/supabase-js";
import { dateId, pairingId, type CalendarDate } from "@ldr/core/common";
import {
  isValidCalendarDate,
  nextOccurrence,
  resolveReminderTrigger,
  validateTitle,
} from "@ldr/core/calendar-helpers";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import {
  authenticatedAccountId,
  callerClient,
  serviceClient,
  tokenEpoch,
} from "../_shared/supabase.ts";

type CalendarAction = "create" | "edit" | "delete" | "setReminder";

interface RelationshipDateRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly title: string;
  readonly date: string;
  readonly recurring: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReminderRpcRow {
  readonly result_code?: string;
  readonly reminder_id?: string;
  readonly date_id?: string;
  readonly pairing_id?: string;
  readonly lead_time_ms?: number;
  readonly next_trigger_at?: string;
  readonly status?: string;
}

const DATE_COLUMNS =
  "id, pairing_id, title, date, recurring, created_at, updated_at";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "calendar must be called with POST.",
      405,
    );
  }

  const db = callerClient(req);
  const actor = await authenticatedAccountId(req);
  if (!db || !actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to change relationship dates.",
      401,
    );
  }

  // `account_session` is deliberately readable by its owner even when stale,
  // allowing the endpoint to report a displaced token precisely. The actual
  // table mutation below still carries its caller token and is independently
  // guarded by `app.session_epoch_ok`, covering a session that changes mid-call.
  const epoch = await currentSessionEpoch(db, actor, req);
  if (!epoch.ok) return epoch.response;

  const body = await readBody(req);
  if (body === null) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A calendar action payload is required.",
      400,
      { fields: ["action"] },
    );
  }

  const action = normalizeAction(body.action);
  if (!action) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "Supply an action of `create`, `edit`, `delete`, or `setReminder`.",
      400,
      { fields: ["action"] },
    );
  }

  // The pairing id is derived from the authenticated caller, never accepted
  // from JSON. The subsequent relationship_dates mutation remains RLS-checked,
  // so an epoch/pairing change racing this read is denied by the database.
  const pairing = await activePairing(db, actor);
  if (!pairing.ok) return pairing.response;

  switch (action) {
    case "create":
      return createDate(db, pairing.id, body);
    case "edit":
      return editDate(db, body);
    case "delete":
      return deleteDate(db, body);
    case "setReminder":
      return setReminder(db, pairing.id, actor, epoch.value, body);
  }
});

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAction(value: unknown): CalendarAction | null {
  switch (value) {
    case "create":
    case "createDate":
      return "create";
    case "edit":
    case "editDate":
      return "edit";
    case "delete":
    case "deleteDate":
      return "delete";
    case "setReminder":
      return "setReminder";
    default:
      return null;
  }
}

async function activePairing(
  db: SupabaseClient,
  actor: string,
): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("pairing_id")
    .eq("id", actor)
    .maybeSingle();
  if (accountError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the account.",
        500,
      ),
    };
  }
  const pairingId = account?.pairing_id as string | null | undefined;
  if (!account || !pairingId) return pairingRequired();

  const { data: pairing, error: pairingError } = await db
    .from("pairings")
    .select("id")
    .eq("id", pairingId)
    .eq("status", "active")
    .maybeSingle();
  if (pairingError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the pairing.",
        500,
      ),
    };
  }
  if (!pairing) return pairingRequired();
  return { ok: true, id: pairing.id as string };
}

async function currentSessionEpoch(
  db: SupabaseClient,
  actor: string,
  req: Request,
): Promise<{ ok: true; value: number } | { ok: false; response: Response }> {
  const presented = tokenEpoch(req);
  const { data, error } = await db
    .from("account_session")
    .select("epoch")
    .eq("account_id", actor)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the session.",
        500,
      ),
    };
  }
  if (!data || presented === null || data.epoch !== presented) {
    return {
      ok: false,
      response: errorResponse(
        "SESSION_SUPERSEDED",
        "This session is no longer active.",
        statusForErrorCode("SESSION_SUPERSEDED"),
      ),
    };
  }
  // `presented === null` returned above, so this is the integer JWT epoch the
  // transaction must check under its row lock as well.
  return { ok: true, value: presented };
}

function pairingRequired(): { ok: false; response: Response } {
  return {
    ok: false,
    response: errorResponse(
      "PAIRING_REQUIRED",
      "A partner pairing is required to change relationship dates.",
      statusForErrorCode("PAIRING_REQUIRED"),
    ),
  };
}

function invalidTitleResponse(): Response {
  return errorResponse(
    "INVALID_TITLE",
    "A relationship-date title must be 1 to 100 characters after trimming.",
    400,
  );
}

function invalidDateResponse(): Response {
  return errorResponse(
    "INVALID_DATE",
    "Supply a valid calendar date with year 1 through 9999.",
    400,
  );
}

function missingFieldResponse(field: string): Response {
  return errorResponse(
    "MISSING_REQUIRED_FIELD",
    `A \`${field}\` field is required.`,
    400,
    { fields: [field] },
  );
}

function dateNotFoundResponse(id: string): Response {
  return errorResponse(
    "DATE_NOT_FOUND",
    "No relationship date exists for the supplied id.",
    statusForErrorCode("DATE_NOT_FOUND"),
    { dateId: id },
  );
}

function dateIdFrom(body: Record<string, unknown>): string | null {
  const candidate = body.dateId ?? body.id;
  return typeof candidate === "string" && isUuid(candidate) ? candidate : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function toPostgresDate(date: CalendarDate): string {
  return `${date.year.toString().padStart(4, "0")}-${
    date.month
      .toString()
      .padStart(2, "0")
  }-${date.day.toString().padStart(2, "0")}`;
}

async function createDate(
  db: SupabaseClient,
  pairingId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (typeof body.title !== "string" || !validateTitle(body.title)) {
    return invalidTitleResponse();
  }
  if (!isValidCalendarDate(body.date)) return invalidDateResponse();
  if (body.recurring !== undefined && typeof body.recurring !== "boolean") {
    return missingFieldResponse("recurring");
  }

  const { data, error } = await db
    .from("relationship_dates")
    .insert({
      pairing_id: pairingId,
      title: body.title,
      date: toPostgresDate(body.date),
      recurring: body.recurring ?? false,
    })
    .select(DATE_COLUMNS)
    .single();
  if (error || !data) return writeFailure(error);
  return jsonResponse({ date: data as RelationshipDateRow }, 201);
}

async function editDate(
  db: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = dateIdFrom(body);
  if (!id) return dateNotFoundResponse(String(body.dateId ?? body.id ?? ""));

  // An edit is a replacement of the calendar item's displayed fields. Keeping
  // title and date mandatory makes the same Req 9.4/9.5 validation boundary
  // apply to every create/edit request rather than allowing malformed partial
  // patches to bypass it.
  if (typeof body.title !== "string" || !validateTitle(body.title)) {
    return invalidTitleResponse();
  }
  if (!isValidCalendarDate(body.date)) return invalidDateResponse();
  if (body.recurring !== undefined && typeof body.recurring !== "boolean") {
    return missingFieldResponse("recurring");
  }
  const updates: Record<string, string | boolean> = {
    title: body.title,
    date: toPostgresDate(body.date),
  };
  if (body.recurring !== undefined) updates.recurring = body.recurring;

  const { data, error } = await db
    .from("relationship_dates")
    .update(updates)
    .eq("id", id)
    .select(DATE_COLUMNS)
    .maybeSingle();
  if (error) return writeFailure(error);
  if (!data) return dateNotFoundResponse(id);
  return jsonResponse({ date: data as RelationshipDateRow });
}

async function deleteDate(
  db: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = dateIdFrom(body);
  if (!id) return dateNotFoundResponse(String(body.dateId ?? body.id ?? ""));

  const { data, error } = await db
    .from("relationship_dates")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return writeFailure(error);
  if (!data) return dateNotFoundResponse(id);
  return jsonResponse({ deleted: true, dateId: id });
}

function invalidLeadTimeResponse(): Response {
  return errorResponse(
    "INVALID_LEAD_TIME",
    "Reminder lead time must be between 1 minute and 365 days and fire in the future.",
    400,
  );
}

function currentUtcCalendarDate(now: number): CalendarDate {
  const instant = new Date(now);
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function calendarDateFromPostgres(value: unknown): CalendarDate | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date: CalendarDate = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return isValidCalendarDate(date) ? date : null;
}

function isReminderStatus(value: unknown): value is "scheduled" | "cancelled" | "delivered" {
  return value === "scheduled" || value === "cancelled" || value === "delivered";
}

/**
 * Create a reminder through the locked SQL write path (Requirement 10.1-10.2).
 *
 * The pure helpers calculate precisely the same UTC occurrence and trigger
 * used by the client. This function deliberately gets `now` from its own
 * server clock and passes it to SQL, where the date/pairing/session/trigger
 * checks are repeated atomically. A client-supplied clock is never trusted.
 */
async function setReminder(
  db: SupabaseClient,
  activePairingId: string,
  actor: string,
  epoch: number,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = dateIdFrom(body);
  if (!id) return dateNotFoundResponse(String(body.dateId ?? body.id ?? ""));
  const leadTime = body.leadTime;
  // Postgres accepts non-integral JSON numbers for bigint by rounding. Reject
  // them here so API milliseconds remain exact and portable across clients.
  if (typeof leadTime !== "number" || !Number.isSafeInteger(leadTime)) {
    return invalidLeadTimeResponse();
  }

  // This caller-scoped read gives a stable DATE_NOT_FOUND surface before the
  // calculation. The RPC still locks and rechecks it, so a concurrent delete,
  // unlink, or session replacement cannot turn into an unauthorized write.
  const { data: rawDate, error: dateError } = await db
    .from("relationship_dates")
    .select("id, pairing_id, title, date, recurring")
    .eq("id", id)
    .eq("pairing_id", activePairingId)
    .maybeSingle();
  if (dateError) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the relationship date.", 500);
  }
  if (!rawDate) return dateNotFoundResponse(id);
  const date = calendarDateFromPostgres(rawDate.date);
  if (!date || typeof rawDate.title !== "string" || typeof rawDate.recurring !== "boolean") {
    return errorResponse("INTERNAL_ERROR", "The relationship date is malformed.", 500);
  }

  const now = Date.now();
  const trigger = resolveReminderTrigger(
    nextOccurrence({
      id: dateId(rawDate.id as string),
      pairingId: pairingId(activePairingId),
      title: rawDate.title,
      date,
      recurring: rawDate.recurring,
    }, currentUtcCalendarDate(now)),
    leadTime,
    now,
  );
  if (!trigger.ok) return invalidLeadTimeResponse();

  const { data, error } = await serviceClient().rpc("set_calendar_reminder", {
    p_date: id,
    p_actor: actor,
    p_epoch: epoch,
    p_lead_time_ms: leadTime,
    p_next_trigger_at: new Date(trigger.value).toISOString(),
    p_now: new Date(now).toISOString(),
  });
  if (error) {
    return errorResponse("INTERNAL_ERROR", "Failed to schedule the reminder.", 500);
  }
  const committed = (Array.isArray(data) ? data[0] : data) as ReminderRpcRow | null;
  const resultCode = committed?.result_code ?? "INTERNAL_ERROR";
  if (resultCode !== "OK") {
    return errorResponse(
      resultCode,
      resultCode === "INVALID_LEAD_TIME"
        ? "Reminder lead time must produce a future trigger."
        : "The reminder could not be scheduled.",
      resultCode === "INTERNAL_ERROR" ? 500 : statusForErrorCode(resultCode),
    );
  }
  if (
    !committed ||
    typeof committed.reminder_id !== "string" ||
    typeof committed.date_id !== "string" ||
    typeof committed.pairing_id !== "string" ||
    typeof committed.lead_time_ms !== "number" ||
    !Number.isSafeInteger(committed.lead_time_ms) ||
    typeof committed.next_trigger_at !== "string" ||
    !Number.isFinite(Date.parse(committed.next_trigger_at)) ||
    !isReminderStatus(committed.status)
  ) {
    return errorResponse("INTERNAL_ERROR", "The reminder transaction returned invalid data.", 500);
  }
  return jsonResponse({
    reminder: {
      id: committed.reminder_id,
      dateId: committed.date_id,
      pairingId: committed.pairing_id,
      leadTime: committed.lead_time_ms,
      nextTriggerAt: committed.next_trigger_at,
      status: committed.status,
    },
  }, 201);
}

function writeFailure(
  error: { code?: string; message?: string } | null,
): Response {
  // A caller-scoped RLS rejection includes an epoch mismatch or a racing
  // dissolution/pairing transition. Do not retry it with service_role.
  if (error?.code === "42501") {
    return errorResponse(
      "PAIRING_REQUIRED",
      "A partner pairing is required to change relationship dates.",
      statusForErrorCode("PAIRING_REQUIRED"),
    );
  }
  if (
    error?.code === "23514" &&
    error.message?.includes("relationship_dates_title_len")
  ) {
    return invalidTitleResponse();
  }
  if (
    error?.code === "23514" || error?.code === "22007" ||
    error?.code === "22008"
  ) {
    return errorResponse(
      "INVALID_DATE",
      "The supplied relationship date is invalid.",
      400,
    );
  }
  return errorResponse(
    "INTERNAL_ERROR",
    "Failed to change the relationship date.",
    500,
  );
}
