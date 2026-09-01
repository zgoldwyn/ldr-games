// takeTurn Edge Function for asynchronous turn-based games
// (Requirements 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10).
//
// This is the server-authoritative path for applying one turn. It layers three
// concerns, in order:
//
//   1. AUTHORIZATION. The caller must have a valid session and must be in an
//      active pairing (`requirePairing`, Req 7.9), and the session must belong to
//      that pairing. Because the whole game lives in Postgres, the turn works
//      whether or not the partner is currently online (Req 7.3).
//   2. PURE DECISION. The shared `@ldr/core` `applyTurn` engine decides what the
//      turn means: it rejects a non-holder with NOT_YOUR_TURN (Req 7.7) and an
//      illegal turn with INVALID_TURN (Req 7.8) — in both cases nothing is
//      written, so the stored state is retained unchanged. On success it records
//      the turn, applies the game-specific effect, and transfers the
//      Active_Turn_Holder designation to the partner (Req 7.4, 7.5).
//   3. ATOMIC COMMIT. The `public.async_take_turn` RPC commits the new state, the
//      holder transfer, the refreshed turn-pending stamp, the terminal outcome,
//      and the derived notifications in ONE transaction, re-checking the holder
//      and the turn count under a row lock so a concurrent turn cannot be applied
//      on top of a stale read.
//
// The partner observes the committed row change and the your-turn notification
// through **Postgres Changes** on `async_sessions` / `notifications` (both added
// to the `supabase_realtime` publication in migration 20260826062557), so the
// update arrives within seconds while they are online (Req 7.6) and is waiting
// for them as a durable notification row when they are not (Req 7.6, 7.10).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { applyTurn, type AsyncEngineState } from "@ldr/core/async-engine";
import { deriveTurnHandoffNotification } from "@ldr/core/async-lifecycle";
// Aliased because `sessionId` / `gameId` are also used as local request-scoped
// variable names below; these are the pure brand casts.
import {
  accountId as asAccountId,
  gameId as asGameId,
  notificationId as asNotificationId,
  sessionId as asSessionId,
} from "@ldr/core/common";
import type { AsyncGameState, TurnAction } from "@ldr/core/game";
import { requirePairing } from "@ldr/core/pairing-logic";
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

/**
 * The engine state persisted in `async_sessions.game_state`.
 *
 * This is core's own `AsyncEngineState` — the structured view of the opaque
 * `AsyncGameState` that `applyTurn` accepts and returns. Using it directly
 * (rather than a local restatement) keeps the branded `AccountId` / `GameId`
 * types, so a raw uuid from Postgres cannot be passed where an account id is
 * expected without going through an explicit cast.
 */
type EngineState = AsyncEngineState;

/** A notification row for `app.insert_derived_notifications` to insert. */
interface DerivedNotification {
  recipient: string;
  category: string;
  payload: unknown;
  dedupe_key: string;
}

/** Whether a value looks like a persisted engine state we can apply a turn to. */
function isEngineState(value: unknown): value is EngineState {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    Array.isArray(s.players) &&
    s.players.length === 2 &&
    typeof s.ruleset === "object" &&
    s.ruleset !== null
  );
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "takeTurn must be called with POST.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to take a turn.",
      401,
    );
  }

  let sessionId: unknown;
  let action: unknown;
  try {
    const body = await req.json();
    sessionId = body?.sessionId;
    action = body?.action ?? body?.turn;
  } catch {
    sessionId = undefined;
    action = undefined;
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `sessionId` is required.",
      400,
      { fields: ["sessionId"] },
    );
  }
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "An `action` object describing the turn is required.",
      400,
      { fields: ["action"] },
    );
  }

  const db = serviceClient();

  // --- 1. Authorization -----------------------------------------------------

  const { data: account, error: accErr } = await db
    .from("accounts")
    .select("id, pairing_id")
    .eq("id", actor)
    .maybeSingle();

  if (accErr) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the account.", 500);
  }

  // A turn belongs to a pairing-owned session, so the caller must be paired
  // (Req 7.9). The same guard that gates starting a session gates playing one.
  const paired = requirePairing({ pairingId: account?.pairing_id ?? null });
  if (!paired.ok) {
    return errorResponse(
      paired.error.code,
      paired.error.message,
      statusForErrorCode(paired.error.code),
    );
  }

  const { data: row, error: sessErr } = await db
    .from("async_sessions")
    .select(
      "id, pairing_id, game_id, state, active_turn_holder, turn_pending_since, game_state, outcome",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (sessErr) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the session.", 500);
  }
  // A session outside the caller's pairing is reported as not found rather than
  // forbidden, so the response never reveals another pairing's session ids.
  if (!row || row.pairing_id !== paired.value) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No asynchronous game session exists for the supplied id.",
      statusForErrorCode("SESSION_NOT_FOUND"),
    );
  }

  if (!isEngineState(row.game_state)) {
    return errorResponse(
      "INTERNAL_ERROR",
      "The stored session state is not a valid asynchronous game state.",
      500,
    );
  }

  // --- 2. Pure decision -----------------------------------------------------

  // The row columns are the authoritative holder/lifecycle record (they are what
  // RLS and the 48h nudge job read), so they win over the embedded copy.
  const stored = row.game_state as EngineState;
  const engine: EngineState = {
    ...stored,
    activeTurnHolder: asAccountId(row.active_turn_holder),
    status: row.state === "terminal" ? "terminal" : "active",
  };
  const expectedTurnCount = Array.isArray(engine.turns) ? engine.turns.length : 0;

  // `applyTurn` speaks the opaque `AsyncGameState`; the structured
  // `AsyncEngineState` is the same object viewed concretely, which is exactly the
  // round trip core performs internally.
  const applied = applyTurn(
    engine as unknown as AsyncGameState,
    asAccountId(actor),
    action as TurnAction,
  );
  if (!applied.ok) {
    // NOT_YOUR_TURN (Req 7.7) / INVALID_TURN (Req 7.8): nothing is written, so
    // the stored game state is retained exactly as it was.
    return errorResponse(
      applied.error.code,
      applied.error.message,
      statusForErrorCode(applied.error.code),
    );
  }

  const next = applied.value as unknown as EngineState;
  const terminal = next.status === "terminal";
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // --- 3. Derived notifications --------------------------------------------

  const notifications: DerivedNotification[] = [];
  if (terminal) {
    // Terminal state: record the outcome and address the result to BOTH partners
    // so a partner without a current session receives it on next sign-in
    // (Req 7.10).
    for (const recipient of next.players) {
      notifications.push({
        recipient,
        category: "async_turn",
        payload: {
          kind: "session_result",
          sessionId: row.id,
          gameId: row.game_id,
          winner: next.winner ?? null,
        },
        dedupe_key: `async_turn:session_result:${row.id}:${recipient}`,
      });
    }
  } else {
    // Hand-off: the pure core derives the "your turn" notification for the new
    // Active_Turn_Holder (Req 7.6). `turnPendingSince` is the fresh stamp the
    // transaction is about to write, which keys the dedupe to this turn.
    const handoff = deriveTurnHandoffNotification(
      {
        id: asSessionId(row.id),
        gameId: asGameId(row.game_id),
        activeTurnHolder: next.activeTurnHolder,
        turnPendingSince: nowMs,
      },
      nowMs,
      asNotificationId(crypto.randomUUID()),
    );
    notifications.push({
      recipient: handoff.recipientAccountId,
      category: handoff.category,
      payload: handoff.payload,
      dedupe_key: handoff.dedupeKey,
    });
  }

  const outcome = terminal
    ? { kind: "completed", winner: next.winner ?? null, recordedAt: nowMs }
    : null;

  // --- 4. Atomic commit -----------------------------------------------------

  const { data: rpcRows, error: rpcErr } = await db.rpc("async_take_turn", {
    p_session: row.id,
    p_actor: actor,
    p_expected_holder: row.active_turn_holder,
    p_expected_turn_count: expectedTurnCount,
    p_game_state: next,
    p_next_holder: next.activeTurnHolder,
    p_next_state: terminal ? "terminal" : "active",
    p_outcome: outcome,
    p_now: nowIso,
    p_notifications: notifications,
  });

  if (rpcErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to commit the turn transaction.",
      500,
    );
  }

  const committed = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const resultCode: string = committed?.result_code ?? "INTERNAL_ERROR";

  if (resultCode !== "OK") {
    // A concurrent turn (or a state change between the read and the
    // transaction) is reported with the same stable codes, state unchanged.
    const status = resultCode === "INTERNAL_ERROR"
      ? 500
      : statusForErrorCode(resultCode);
    return errorResponse(resultCode, "The turn could not be applied.", status);
  }

  return jsonResponse({
    session: {
      id: committed.session_id,
      pairingId: committed.pairing_id,
      gameId: committed.game_id,
      state: committed.state,
      activeTurnHolder: committed.active_turn_holder,
      turnPendingSince: Date.parse(committed.turn_pending_since) || nowMs,
      gameState: committed.game_state,
      outcome: committed.outcome ?? undefined,
    },
  });
});
