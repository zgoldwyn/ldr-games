// unlink Edge Function (Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6).
//
// An authenticated partner confirms an unlink; the pairing is dissolved and both
// accounts are returned to an unpaired state. The function is the only path
// allowed to perform this transition (design.md: sensitive transitions run in
// Edge Functions with service-role privileges).
//
// Two layers cooperate, mirroring the acceptInvitation pattern (task 13.1):
//   1. PURE decision with the shared `@ldr/core` `dissolvePairing`. It rejects a
//      non-active pairing with NOT_PAIRED and, on success, returns the dissolved
//      pairing, both unpaired accounts, the sessions to terminate (Req 4.6), and
//      the pairing-ended / session-ended notifications to insert (Req 4.2, 4.6)
//      with their deterministic dedupe keys.
//   2. An ATOMIC Postgres transaction (`public.dissolve_pairing` RPC,
//      migration 20260826062553) performs the authoritative mutation: it locks
//      the pairing, re-checks membership and active status, terminates every
//      active rt/async/quiz session (Req 4.6), marks the pairing dissolved (Req
//      4.1), clears both accounts' `pairing_id` (Req 4.3 — which is also what
//      revokes pairing-scoped RLS access while individual data is retained, Req
//      4.4), and inserts the notifications with `delivered_at` NULL so delivery
//      is deferred until each partner next has a session (Req 4.5).
//
// After the transaction commits, a best-effort Realtime Broadcast on each
// partner's `account:{id}` channel lets a still-connected client react within
// the 5s budget (Req 4.1, 4.2). A missed broadcast costs nothing: the durable
// notification rows are the source of truth and are delivered on next session.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { dissolvePairing } from "@ldr/core/pairing-logic";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import { broadcast } from "../_shared/realtime.ts";
import { authenticatedAccountId, serviceClient } from "../_shared/supabase.ts";

/** A session that must be terminated when the pairing dissolves (Req 4.6). */
interface SessionRef {
  readonly sessionId: string;
  readonly kind: "realtime" | "async" | "quiz";
}

/** Notification row shape accepted by the `dissolve_pairing` RPC. */
interface NotificationRow {
  readonly recipient_account_id: string;
  readonly category: string;
  readonly payload: unknown;
  readonly dedupe_key: string;
  readonly created_at: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "unlink must be called with POST.",
      405,
    );
  }

  const actorId = await authenticatedAccountId(req);
  if (!actorId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to unlink.",
      401,
    );
  }

  const db = serviceClient();

  // Resolve the caller's current pairing (service role bypasses RLS).
  const { data: actor, error: actorErr } = await db
    .from("accounts")
    .select("id, pairing_id")
    .eq("id", actorId)
    .maybeSingle();

  if (actorErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the requesting account.",
      500,
    );
  }
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "The authenticated account no longer exists.",
      401,
    );
  }
  if (!actor.pairing_id) {
    // Nothing to dissolve.
    return errorResponse(
      "NOT_PAIRED",
      "The account is not currently in a pairing.",
      statusForErrorCode("NOT_PAIRED"),
    );
  }

  const { data: pairing, error: pairingErr } = await db
    .from("pairings")
    .select("id, member_a, member_b, status, created_at")
    .eq("id", actor.pairing_id)
    .maybeSingle();

  if (pairingErr) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the pairing.", 500);
  }
  if (!pairing) {
    return errorResponse(
      "NOT_PAIRED",
      "The referenced pairing no longer exists.",
      statusForErrorCode("NOT_PAIRED"),
    );
  }

  const { data: members, error: membersErr } = await db
    .from("accounts")
    .select("id, pairing_id, created_at")
    .in("id", [pairing.member_a, pairing.member_b]);

  if (membersErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the pairing members.",
      500,
    );
  }

  const memberARow = members?.find((m) => m.id === pairing.member_a);
  const memberBRow = members?.find((m) => m.id === pairing.member_b);
  if (!memberARow || !memberBRow) {
    return errorResponse(
      "NOT_PAIRED",
      "The pairing refers to an account that no longer exists.",
      statusForErrorCode("NOT_PAIRED"),
    );
  }

  // Collect the pairing's active sessions so the pure logic can produce the
  // session-ended notifications (Req 4.6). The RPC re-reads them inside the
  // transaction, so a session started after this read is still terminated.
  const [rt, asyncGames, quizzes] = await Promise.all([
    db.from("rt_sessions").select("id").eq("pairing_id", pairing.id).neq(
      "state",
      "terminal",
    ),
    db.from("async_sessions").select("id").eq("pairing_id", pairing.id).neq(
      "state",
      "terminal",
    ),
    db.from("quiz_sessions").select("id").eq("pairing_id", pairing.id).neq(
      "phase",
      "complete",
    ),
  ]);

  if (rt.error || asyncGames.error || quizzes.error) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the pairing's active sessions.",
      500,
    );
  }

  const activeSessions: SessionRef[] = [
    ...(rt.data ?? []).map((s) => ({
      sessionId: s.id as string,
      kind: "realtime" as const,
    })),
    ...(asyncGames.data ?? []).map((s) => ({
      sessionId: s.id as string,
      kind: "async" as const,
    })),
    ...(quizzes.data ?? []).map((s) => ({
      sessionId: s.id as string,
      kind: "quiz" as const,
    })),
  ];

  const now = Date.now();

  // Pure decision: rejects a non-active pairing with NOT_PAIRED and computes the
  // unpaired accounts, terminated sessions, and notifications to enact.
  const decision = dissolvePairing({
    pairing: {
      id: pairing.id,
      memberA: pairing.member_a,
      memberB: pairing.member_b,
      status: pairing.status,
      createdAt: Date.parse(pairing.created_at) || now,
    },
    memberA: {
      id: memberARow.id,
      email: "",
      pairingId: memberARow.pairing_id ?? null,
      createdAt: Date.parse(memberARow.created_at) || now,
    },
    memberB: {
      id: memberBRow.id,
      email: "",
      pairingId: memberBRow.pairing_id ?? null,
      createdAt: Date.parse(memberBRow.created_at) || now,
    },
    activeSessions,
    now,
  } as unknown as Parameters<typeof dissolvePairing>[0]);

  if (!decision.ok) {
    return errorResponse(
      decision.error.code,
      decision.error.message,
      statusForErrorCode(decision.error.code),
    );
  }

  const outcome = decision.value;

  // Translate the pure notifications to the RPC's row shape. Ids are assigned by
  // the database; `dedupeKey` carries the dedupe identity, and `delivered_at`
  // stays NULL (deferred delivery, Req 4.5).
  const notifications: NotificationRow[] = outcome.notifications.map((n) => ({
    recipient_account_id: n.recipientAccountId,
    category: n.category,
    payload: n.payload,
    dedupe_key: n.dedupeKey,
    created_at: new Date(n.createdAt).toISOString(),
  }));

  // Authoritative, atomic mutation (Req 4.1-4.6 commit together).
  const { data: rpcRows, error: rpcErr } = await db.rpc("dissolve_pairing", {
    p_pairing: pairing.id,
    p_actor: actorId,
    p_now: new Date(now).toISOString(),
    p_notifications: notifications,
  });

  if (rpcErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to complete the unlink transaction.",
      500,
    );
  }

  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const resultCode: string = result?.result_code ?? "INTERNAL_ERROR";

  if (resultCode !== "OK") {
    // A concurrent unlink (or a state change between the pure pre-check and the
    // transaction) is reported with the same stable code.
    const status = resultCode === "INTERNAL_ERROR"
      ? 500
      : statusForErrorCode(resultCode);
    return errorResponse(
      resultCode,
      "The pairing could not be dissolved.",
      status,
    );
  }

  const terminatedSessions: string[] = result?.terminated_session_ids ?? [];

  // Best-effort live signal so a connected partner learns the pairing ended
  // within 5 seconds (Req 4.1, 4.2). The notification rows remain the source of
  // truth for a partner without a session (Req 4.5).
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    await broadcast(
      serviceRoleKey,
      [pairing.member_a, pairing.member_b].map((recipient) => ({
        topic: `account:${recipient}`,
        event: "pairing_ended",
        payload: {
          pairingId: pairing.id,
          terminatedSessions,
          endedAt: new Date(now).toISOString(),
        },
      })),
    );
  } catch {
    // Swallow: durable notifications cover delivery on next session.
  }

  return jsonResponse({
    pairing: {
      id: pairing.id,
      memberA: pairing.member_a,
      memberB: pairing.member_b,
      status: "dissolved",
      dissolvedAt: new Date(now).toISOString(),
    },
    terminatedSessions,
    notifications: notifications.length,
  });
});

/* To invoke locally once the stack is running:

  1. Run `npm run supabase:start` (wraps `supabase start`, requires Docker)
  2. Serve functions: `npm run supabase:functions`
  3. Make an HTTP request with a paired account's access token:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/unlink' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{}'
*/
