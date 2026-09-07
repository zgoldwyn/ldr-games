// Account-deletion Edge Function (Requirement 12, task 21A.3).
//
// A confirmed request first derives the deletion plan with the shared pure
// helper, then invokes a service-role-only Postgres transaction which reuses
// dissolve_pairing before deleting pairing/account-owned rows. Storage and Auth
// are separate Supabase services and cannot join that database transaction, so
// an Auth metadata marker preserves the pairing prefix across retries. The Auth
// credential is removed last: while it exists a failed cleanup can be retried,
// but the deleted account_session row already makes its JWT fail every app-data
// epoch guard.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { deleteAccount } from "@ldr/core/account-deletion";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import { accountTopic, broadcast } from "../_shared/realtime.ts";
import { authenticatedAccountId, serviceClient } from "../_shared/supabase.ts";

const DRAWINGS_BUCKET = "drawings";
const DELETION_STARTED_KEY = "account_deletion_started";
const DELETION_PAIRINGS_KEY = "account_deletion_pairing_ids";
const STORAGE_PAGE_SIZE = 1000;
const STORAGE_REMOVE_BATCH_SIZE = 100;

interface DeleteAccountRequest {
  readonly confirmed?: unknown;
}

interface SessionRef {
  readonly sessionId: string;
  readonly kind: "realtime" | "async" | "quiz";
}

interface NotificationRow {
  readonly recipient_account_id: string;
  readonly category: string;
  readonly payload: unknown;
  readonly dedupe_key: string;
  readonly created_at: string;
}

interface DeletionRpcRow {
  readonly result_code?: string;
  readonly deleted_pairing_ids?: string[] | null;
  readonly remaining_partner_id?: string | null;
  readonly terminated_session_ids?: string[] | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "delete-account must be called with POST.",
      405,
    );
  }

  const actorId = await authenticatedAccountId(req);
  if (!actorId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to delete an account.",
      401,
    );
  }

  let body: DeleteAccountRequest;
  try {
    body = (await req.json()) as DeleteAccountRequest;
  } catch {
    body = {};
  }

  // An absent, false, or non-boolean confirmation is an explicit no-op. This
  // keeps an accidental invocation incapable of removing anything (Req 12.8).
  if (body.confirmed !== true) {
    return jsonResponse({ deleted: false, confirmed: false });
  }

  const db = serviceClient();
  const { data: authData, error: authError } = await db.auth.admin.getUserById(
    actorId,
  );
  const authUser = authData?.user;
  if (authError || !authUser?.email) {
    return errorResponse(
      "UNAUTHENTICATED",
      "The authenticated account no longer exists.",
      401,
    );
  }

  const metadata = authUser.app_metadata ?? {};
  const markedPairings = Array.isArray(metadata[DELETION_PAIRINGS_KEY])
    ? (metadata[DELETION_PAIRINGS_KEY] as unknown[]).filter((
      value,
    ): value is string => typeof value === "string")
    : [];

  const { data: actor, error: actorError } = await db
    .from("accounts")
    .select("id, pairing_id, created_at")
    .eq("id", actorId)
    .maybeSingle();

  if (actorError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the requesting account.",
      500,
    );
  }

  // If the database transaction committed but Storage/Auth cleanup failed, the
  // account row is already gone. Resume from the marker rather than stranding
  // the credential and its email address permanently.
  if (!actor) {
    if (metadata[DELETION_STARTED_KEY] !== true) {
      return errorResponse(
        "UNAUTHENTICATED",
        "The authenticated account no longer exists.",
        401,
      );
    }

    const cleanup = await finishExternalDeletion(db, actorId, markedPairings);
    if (cleanup !== null) return cleanup;
    return jsonResponse({ deleted: true, accountId: actorId });
  }

  // `verify_jwt` proves the token is signed and unexpired; the application also
  // has a single-session epoch. This destructive endpoint must reject a token
  // displaced by a newer login instead of relying on table RLS (the writes below
  // intentionally use service_role and therefore bypass it).
  const { data: registry, error: registryError } = await db
    .from("account_session")
    .select("epoch")
    .eq("account_id", actorId)
    .maybeSingle();
  const presentedEpoch = tokenEpoch(req);
  if (
    registryError || !registry || presentedEpoch === null ||
    presentedEpoch !== registry.epoch
  ) {
    return errorResponse(
      "SESSION_SUPERSEDED",
      "This session is no longer active.",
      401,
    );
  }

  const pairingId = typeof actor.pairing_id === "string"
    ? actor.pairing_id
    : null;
  const now = Date.now();
  let pairing: Record<string, unknown> | null = null;
  let partner: Record<string, unknown> | null = null;
  let activeSessions: SessionRef[] = [];

  if (pairingId !== null) {
    const context = await loadPairingContext(db, pairingId, actorId);
    if (context instanceof Response) return context;
    pairing = context.pairing;
    partner = context.partner;
    activeSessions = context.activeSessions;
  }

  const decision = deleteAccount(
    {
      account: {
        id: actorId,
        email: authUser.email,
        pairingId,
        createdAt: Date.parse(actor.created_at) || now,
      },
      confirmed: true,
      pairingContext: pairing && partner
        ? {
          pairing: {
            id: pairing.id,
            memberA: pairing.member_a,
            memberB: pairing.member_b,
            status: pairing.status,
            createdAt: Date.parse(pairing.created_at as string) || now,
          },
          partner: {
            id: partner.id,
            email: "",
            pairingId: partner.pairing_id ?? null,
            createdAt: Date.parse(partner.created_at as string) || now,
          },
          activeSessions,
        }
        : null,
      now,
    } as unknown as Parameters<typeof deleteAccount>[0],
  );

  if (!decision.ok) {
    return errorResponse(
      decision.error.code,
      decision.error.message,
      statusForErrorCode(decision.error.code),
    );
  }

  // The request was normalized to literal true above. Keep this defensive
  // branch so the discriminated union remains exhaustively handled if the pure
  // helper's input contract changes later.
  if (!decision.value.confirmed) {
    return jsonResponse({ deleted: false, confirmed: false });
  }

  const notifications: NotificationRow[] = decision.value.notifications.map(
    (notification) => ({
      recipient_account_id: notification.recipientAccountId,
      category: notification.category,
      payload: notification.payload,
      dedupe_key: notification.dedupeKey,
      created_at: new Date(notification.createdAt).toISOString(),
    }),
  );

  const { data: rpcRows, error: rpcError } = await db.rpc(
    "delete_account_data",
    {
      p_account: actorId,
      p_epoch: presentedEpoch,
      p_pairing: pairingId,
      p_now: new Date(now).toISOString(),
      p_notifications: notifications,
    },
  );

  if (rpcError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to remove the account data.",
      500,
    );
  }

  const result = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | DeletionRpcRow
    | null;
  const resultCode = result?.result_code ?? "INTERNAL_ERROR";
  if (resultCode !== "OK") {
    return errorResponse(
      resultCode,
      "The account could not be deleted.",
      resultCode === "INTERNAL_ERROR" ? 500 : statusForErrorCode(resultCode),
    );
  }

  // The durable pairing-ended notification is authoritative. Broadcast is a
  // best-effort fast path for a partner who is connected right now (Req 12.3).
  if (pairingId && result?.remaining_partner_id) {
    try {
      await broadcast(
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        [{
          topic: accountTopic(result.remaining_partner_id),
          event: "pairing_ended",
          payload: {
            pairingId,
            terminatedSessions: result.terminated_session_ids ?? [],
            endedAt: new Date(now).toISOString(),
          },
        }],
      );
    } catch {
      // Durable notification delivery covers a missed live signal.
    }
  }

  const deletedPairings = result?.deleted_pairing_ids ?? [];
  const cleanup = await finishExternalDeletion(db, actorId, deletedPairings);
  if (cleanup !== null) return cleanup;

  return jsonResponse({
    deleted: true,
    accountId: actorId,
    pairingIds: deletedPairings,
  });
});

async function loadPairingContext(
  db: ReturnType<typeof serviceClient>,
  pairingId: string,
  actorId: string,
): Promise<
  {
    pairing: Record<string, unknown>;
    partner: Record<string, unknown>;
    activeSessions: SessionRef[];
  } | Response
> {
  const { data: pairing, error: pairingError } = await db
    .from("pairings")
    .select("id, member_a, member_b, status, created_at")
    .eq("id", pairingId)
    .maybeSingle();
  if (pairingError || !pairing) {
    return errorResponse(
      "INVALID_DELETION_STATE",
      "The account's active pairing could not be loaded.",
      409,
    );
  }

  const partnerId = pairing.member_a === actorId
    ? pairing.member_b
    : pairing.member_b === actorId
    ? pairing.member_a
    : null;
  if (!partnerId) {
    return errorResponse(
      "INVALID_DELETION_STATE",
      "The account is not a member of its referenced pairing.",
      409,
    );
  }

  const [partnerResult, rt, asyncGames, quizzes] = await Promise.all([
    db.from("accounts").select("id, pairing_id, created_at").eq("id", partnerId)
      .maybeSingle(),
    db.from("rt_sessions").select("id").eq("pairing_id", pairingId).neq(
      "state",
      "terminal",
    ),
    db.from("async_sessions").select("id").eq("pairing_id", pairingId).neq(
      "state",
      "terminal",
    ),
    db.from("quiz_sessions").select("id").eq("pairing_id", pairingId).neq(
      "phase",
      "complete",
    ),
  ]);

  if (
    partnerResult.error || !partnerResult.data || rt.error ||
    asyncGames.error || quizzes.error
  ) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the account deletion context.",
      500,
    );
  }

  return {
    pairing,
    partner: partnerResult.data,
    activeSessions: [
      ...(rt.data ?? []).map((row) => ({
        sessionId: row.id as string,
        kind: "realtime" as const,
      })),
      ...(asyncGames.data ?? []).map((row) => ({
        sessionId: row.id as string,
        kind: "async" as const,
      })),
      ...(quizzes.data ?? []).map((row) => ({
        sessionId: row.id as string,
        kind: "quiz" as const,
      })),
    ],
  };
}

async function finishExternalDeletion(
  db: ReturnType<typeof serviceClient>,
  accountId: string,
  pairingIds: readonly string[],
): Promise<Response | null> {
  for (const pairingId of pairingIds) {
    const storageError = await removeStoragePrefix(db, pairingId);
    if (storageError !== null) {
      return errorResponse(
        "INTERNAL_ERROR",
        "Failed to remove stored account data. The deletion can be retried.",
        500,
      );
    }
  }

  const { error } = await db.auth.admin.deleteUser(accountId, false);
  if (error) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to remove the account credential. The deletion can be retried.",
      500,
    );
  }
  return null;
}

/** Remove every object below a pairing prefix, including unexpected nesting. */
async function removeStoragePrefix(
  db: ReturnType<typeof serviceClient>,
  pairingId: string,
): Promise<Error | null> {
  const files: string[] = [];
  const pending = [pairingId];

  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    let offset = 0;

    while (true) {
      const { data, error } = await db.storage.from(DRAWINGS_BUCKET).list(
        prefix,
        {
          limit: STORAGE_PAGE_SIZE,
          offset,
          sortBy: { column: "name", order: "asc" },
        },
      );
      if (error) return error;

      for (const entry of data ?? []) {
        const path = `${prefix}/${entry.name}`;
        if (entry.id === null) pending.push(path);
        else files.push(path);
      }

      if ((data?.length ?? 0) < STORAGE_PAGE_SIZE) break;
      offset += STORAGE_PAGE_SIZE;
    }
  }

  for (
    let index = 0;
    index < files.length;
    index += STORAGE_REMOVE_BATCH_SIZE
  ) {
    const { error } = await db.storage.from(DRAWINGS_BUCKET).remove(
      files.slice(index, index + STORAGE_REMOVE_BATCH_SIZE),
    );
    if (error) return error;
  }

  return null;
}

/** Read the already-verified JWT's integer epoch claim without trusting it. */
function tokenEpoch(req: Request): number | null {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const encodedPayload = token?.split(".")[1];
  if (!encodedPayload) return null;

  try {
    const normalized = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const nested = payload.app_metadata;
    const raw = payload.epoch ?? (
      nested && typeof nested === "object"
        ? (nested as Record<string, unknown>).epoch
        : undefined
    );
    return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
  } catch {
    return null;
  }
}
