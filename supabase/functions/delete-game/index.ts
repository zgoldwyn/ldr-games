// Participant-authorized permanent game deletion.
// The database RPC owns the transaction so the session, cascaded placements,
// and session-linked notifications cannot be partially removed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import { accountTopic, broadcast } from "../_shared/realtime.ts";
import {
  authenticatedAccountId,
  serviceClient,
  tokenEpoch,
} from "../_shared/supabase.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DeleteGameRow {
  readonly result_code?: string;
  readonly deleted_pairing_id?: string | null;
  readonly member_a?: string | null;
  readonly member_b?: string | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "delete-game must be called with POST.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse("UNAUTHENTICATED", "Sign in to delete a game.", 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Invalid JSON is handled as missing required fields below.
  }
  if (body.confirmed !== true) {
    return jsonResponse({ deleted: false, confirmed: false });
  }

  const sessionId = body.sessionId;
  const kind = body.kind;
  if (
    typeof sessionId !== "string" || !UUID.test(sessionId) ||
    (kind !== "rt" && kind !== "async")
  ) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A valid game session is required.",
      400,
    );
  }

  const epoch = tokenEpoch(req);
  if (epoch === null) {
    return errorResponse(
      "SESSION_SUPERSEDED",
      "This session is no longer active.",
      401,
    );
  }

  const db = serviceClient();
  const { data, error } = await db.rpc("delete_game_session", {
    p_session_id: sessionId,
    p_kind: kind,
    p_actor: actor,
    p_epoch: epoch,
  });
  if (error) {
    return errorResponse(
      "INTERNAL_ERROR",
      "The game could not be deleted.",
      500,
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as DeleteGameRow | null;
  const code = row?.result_code ?? "INTERNAL_ERROR";
  if (code !== "OK") {
    return errorResponse(
      code,
      code === "SESSION_NOT_FOUND"
        ? "That game no longer exists."
        : "The game could not be deleted.",
      statusForErrorCode(code),
    );
  }

  const recipients = [row?.member_a, row?.member_b].filter(
    (value): value is string => typeof value === "string",
  );
  if (SERVICE_ROLE_KEY && recipients.length > 0) {
    try {
      await broadcast(
        SERVICE_ROLE_KEY,
        recipients.map((recipient) => ({
          topic: accountTopic(recipient),
          event: "game_deleted",
          payload: { sessionId, kind },
        })),
      );
    } catch {
      // Best effort; async DELETE replication and the next refresh are durable fallbacks.
    }
  }

  return jsonResponse({ deleted: true, sessionId, kind });
});
