import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  type BattleshipFleet,
  validateBattleshipFleet,
} from "@ldr/core/async-battleship";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import {
  authenticatedAccountId,
  serviceClient,
  tokenEpoch,
} from "../_shared/supabase.ts";

function normalizeFleet(value: unknown): BattleshipFleet | null {
  if (!Array.isArray(value)) return null;
  const fleet = value.map((ship) => {
    if (!Array.isArray(ship)) return null;
    return ship.map((cell) => {
      if (cell === null || typeof cell !== "object") return null;
      const item = cell as Record<string, unknown>;
      return typeof item.row === "number" && typeof item.col === "number"
        ? { row: item.row, col: item.col }
        : null;
    });
  });
  if (
    fleet.some((ship) => ship === null || ship.some((cell) => cell === null))
  ) return null;
  return fleet as BattleshipFleet;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "Fleet placement must use POST.",
      405,
    );
  }
  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse("UNAUTHENTICATED", "Sign in to place a fleet.", 401);
  }

  let sessionId: unknown;
  let rawFleet: unknown;
  try {
    const body = await req.json();
    sessionId = body?.sessionId;
    rawFleet = body?.fleet;
  } catch {
    // handled below
  }
  const fleet = normalizeFleet(rawFleet);
  const validation = fleet === null
    ? { ok: false as const, error: "wrong-fleet" }
    : validateBattleshipFleet(fleet);
  if (
    typeof sessionId !== "string" || sessionId.length === 0 || fleet === null ||
    !validation.ok
  ) {
    return errorResponse(
      "INVALID_TURN",
      "Place all five ships in straight, contiguous, non-overlapping positions on the board.",
      statusForErrorCode("INVALID_TURN"),
      { placementError: validation.error },
    );
  }

  const db = serviceClient();
  const { data: registry } = await db
    .from("account_session")
    .select("epoch")
    .eq("account_id", actor)
    .maybeSingle();
  if (tokenEpoch(req) === null || registry?.epoch !== tokenEpoch(req)) {
    return errorResponse(
      "SESSION_SUPERSEDED",
      "This session is no longer active.",
      401,
    );
  }
  const { data: account } = await db.from("accounts").select("pairing_id").eq(
    "id",
    actor,
  ).maybeSingle();
  const { data: session } = await db
    .from("async_sessions")
    .select("id, pairing_id, game_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (
    !account?.pairing_id || !session ||
    session.pairing_id !== account.pairing_id ||
    session.game_id !== "battleship"
  ) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No Battleship session exists for the supplied id.",
      404,
    );
  }

  const { data, error } = await db.rpc("battleship_place_fleet", {
    p_session: sessionId,
    p_actor: actor,
    p_fleet: fleet,
    p_now: new Date().toISOString(),
  });
  if (error) {
    console.error("battleship_place_fleet failed", error);
    return errorResponse("INTERNAL_ERROR", "Could not save the fleet.", 500);
  }
  const committed = Array.isArray(data) ? data[0] : data;
  if (committed?.result_code !== "OK") {
    const code = committed?.result_code ?? "INTERNAL_ERROR";
    return errorResponse(
      code,
      "The fleet could not be placed.",
      statusForErrorCode(code),
    );
  }

  return jsonResponse({
    fleet,
    session: {
      id: committed.session_id,
      pairingId: committed.pairing_id,
      gameId: committed.game_id,
      state: committed.state,
      activeTurnHolder: committed.active_turn_holder,
      turnPendingSince: Date.parse(committed.turn_pending_since),
      gameState: committed.game_state,
      outcome: committed.outcome ?? undefined,
    },
  });
});
