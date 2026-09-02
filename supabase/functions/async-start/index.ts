// start Edge Function for asynchronous turn-based games (Requirements 7.2, 7.9).
//
// A paired partner picks an Asynchronous_Game and invites the other partner. The
// function:
//   * requires an active pairing (`requirePairing`, Req 7.9),
//   * builds the game's initial state with the shared pure ruleset factory,
//     which designates the initial Active_Turn_Holder per that game's rules
//     (Req 7.2), and
//   * creates the session row and the partner's invitation notification in ONE
//     transaction (`public.async_start_session`), so a session never exists
//     without its invitation and vice versa (Req 7.2).
//
// The partner sees the new session and the invitation through Postgres Changes on
// `async_sessions` / `notifications`; when they are offline the notification row
// waits for their next sign-in. Turns are then applied by the `async-take-turn`
// function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  BATTLESHIP_GAME_ID,
  createBattleshipGame,
} from "@ldr/core/async-battleship";
import { createDrawingGame, DRAWING_GAME_ID } from "@ldr/core/async-drawing";
import { type AccountId, accountId } from "@ldr/core/common";
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

/** A grid coordinate for Battleship ship placement. */
interface Cell {
  row: number;
  col: number;
}

/** Keeps only well-formed, non-negative integer grid coordinates. */
function normalizeCells(value: unknown): Cell[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((cell) => {
    if (cell === null || typeof cell !== "object") return [];
    const c = cell as Record<string, unknown>;
    const { row, col } = c;
    if (typeof row !== "number" || !Number.isInteger(row) || row < 0) return [];
    if (typeof col !== "number" || !Number.isInteger(col) || col < 0) return [];
    return [{ row, col }];
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "start must be called with POST.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to start a game.",
      401,
    );
  }

  let gameId: unknown;
  let options: Record<string, unknown> = {};
  try {
    const body = await req.json();
    gameId = body?.gameId;
    if (body?.options !== null && typeof body?.options === "object") {
      options = body.options as Record<string, unknown>;
    }
  } catch {
    gameId = undefined;
  }
  if (typeof gameId !== "string" || gameId.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `gameId` is required.",
      400,
      { fields: ["gameId"] },
    );
  }
  if (gameId !== BATTLESHIP_GAME_ID && gameId !== DRAWING_GAME_ID) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "`gameId` must name an available asynchronous game.",
      400,
      { fields: ["gameId"], available: [BATTLESHIP_GAME_ID, DRAWING_GAME_ID] },
    );
  }

  const db = serviceClient();

  const { data: account, error: accErr } = await db
    .from("accounts")
    .select("id, pairing_id")
    .eq("id", actor)
    .maybeSingle();

  if (accErr) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the account.", 500);
  }

  // A partner is required to start an asynchronous session (Req 7.9).
  const paired = requirePairing({ pairingId: account?.pairing_id ?? null });
  if (!paired.ok) {
    return errorResponse(
      paired.error.code,
      paired.error.message,
      statusForErrorCode(paired.error.code),
    );
  }

  const { data: pairing, error: pairErr } = await db
    .from("pairings")
    .select("id, member_a, member_b, status")
    .eq("id", paired.value)
    .maybeSingle();

  if (pairErr) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the pairing.", 500);
  }
  if (!pairing || pairing.status !== "active") {
    return errorResponse(
      "PAIRING_REQUIRED",
      "A partner pairing is required to start a session.",
      statusForErrorCode("PAIRING_REQUIRED"),
    );
  }

  const partner = pairing.member_a === actor ? pairing.member_b : pairing.member_a;
  // The initiator plays first unless the request names the partner explicitly;
  // the ruleset factory turns this into the initial Active_Turn_Holder (Req 7.2).
  const requestedHolder = options.firstHolder;
  const firstHolder = accountId(requestedHolder === partner ? partner : actor);
  // Both ids came out of `pairings`, so branding them asserts what the pairing
  // row already guarantees: these are the two member accounts.
  const players: readonly [AccountId, AccountId] = [
    accountId(actor),
    accountId(partner),
  ];

  const sessionId = crypto.randomUUID();

  // Ship placements are per-partner: the engine treats a coordinate list as that
  // partner's own fleet, and the opponent wins by hitting every one of its cells
  // (see async-battleship.ts).
  const ships = (options.ships ?? {}) as Record<string, unknown>;
  const actorShips = normalizeCells(ships[actor]);
  const partnerShips = normalizeCells(ships[partner]);

  // Both fleets must be non-empty. The ruleset derives "all sunk" from the
  // opponent's ship cells, so a fleet of ZERO cells can never be fully hit and
  // the session could never reach a terminal state (Req 7.10) — a permanently
  // unfinishable game. There is no separate ship-placement endpoint, so the start
  // request is the only place this can be established.
  if (
    gameId === BATTLESHIP_GAME_ID &&
    (actorShips.length === 0 || partnerShips.length === 0)
  ) {
    return errorResponse(
      "INVALID_TURN",
      "Battleship requires a non-empty fleet for both partners; a fleet of zero " +
        "cells can never be sunk, so the session could never end.",
      statusForErrorCode("INVALID_TURN"),
      {
        fields: ["options.ships"],
        missingFor: [
          ...(actorShips.length === 0 ? [actor] : []),
          ...(partnerShips.length === 0 ? [partner] : []),
        ],
      },
    );
  }

  const engine = gameId === BATTLESHIP_GAME_ID
    ? createBattleshipGame({
      players,
      ships: {
        [actor]: actorShips,
        [partner]: partnerShips,
      },
      firstHolder,
      ...(typeof options.size === "number" ? { size: options.size } : {}),
    })
    : createDrawingGame({
      players,
      firstHolder,
      ...(typeof options.maxRounds === "number"
        ? { maxRounds: options.maxRounds }
        : {}),
    });

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Invitation notification for the partner (Req 7.2), inserted in the same
  // transaction as the session row.
  const notifications = [
    {
      recipient: partner,
      category: "game_invite",
      payload: {
        kind: "async_game_invite",
        sessionId,
        gameId,
        initiator: actor,
        activeTurnHolder: firstHolder,
      },
      dedupe_key: `game_invite:async:${sessionId}:${partner}`,
    },
  ];

  const { data: rpcRows, error: rpcErr } = await db.rpc("async_start_session", {
    p_session: sessionId,
    p_pairing: pairing.id,
    p_actor: actor,
    p_game_id: gameId,
    p_holder: firstHolder,
    p_game_state: engine,
    p_now: nowIso,
    p_notifications: notifications,
  });

  if (rpcErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to create the asynchronous game session.",
      500,
    );
  }

  const created = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const resultCode: string = created?.result_code ?? "INTERNAL_ERROR";
  if (resultCode !== "OK") {
    const status = resultCode === "INTERNAL_ERROR"
      ? 500
      : statusForErrorCode(resultCode);
    return errorResponse(
      resultCode,
      "The asynchronous game session could not be created.",
      status,
    );
  }

  return jsonResponse(
    {
      session: {
        id: created.session_id,
        pairingId: pairing.id,
        gameId,
        state: "active",
        activeTurnHolder: firstHolder,
        turnPendingSince: nowMs,
        gameState: engine,
      },
    },
    201,
  );
});
