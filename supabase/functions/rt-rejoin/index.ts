// rt-rejoin Edge Function: resume a paused real-time session, or present its
// recorded outcome (Requirements 6.7, 6.8).
//
// The partner who dropped out calls this when their client reconnects to the
// game channel. The function is the authority on whether the resume is allowed:
//
//   1. It confirms the caller is one of the session's two partners (an unknown
//      caller is told the session does not exist, so nothing leaks).
//   2. It applies the pure `resumeSession` transition from
//      `@ldr/core/rt-session`, which rejects a rejoin more than 5 minutes after
//      the pause (`REJOIN_WINDOW_EXPIRED`) and otherwise restores the preserved
//      state.
//   3. It commits `paused -> active` with a compare-and-set pinned to the very
//      pause that was validated. `game_state` is never rewritten, so play
//      resumes from the preserved state and both partners see identical state
//      (Req 6.7) — reinforced by the `resumed` Broadcast carrying that state.
//
// A session that is already terminal — including one the 5-minute cron job
// (task 20.1) ended without an outcome — responds with the recorded outcome
// instead of an error, which is how the result is presented to both partners
// (Req 6.8). This function never terminates a session itself.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { resumeSession } from "@ldr/core/rt-session";

import { handleCors } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import {
  authenticatedAccountId,
  serviceClient,
} from "../_shared/supabase.ts";
import {
  commitResume,
  loadSession,
  publishSessionEvent,
} from "../_shared/rt-presence-store.ts";
import {
  isMember,
  RT_EVENTS,
  type RTSessionSnapshot,
} from "../_shared/rt-presence.ts";

/** The core `RTSession` shape (its ids are compile-time branded strings). */
type CoreSession = Parameters<typeof resumeSession>[0];

/** Client-facing session view (the preserved game state included). */
function sessionView(session: RTSessionSnapshot): Record<string, unknown> {
  return {
    id: session.id,
    gameId: session.gameId,
    state: session.state,
    gameState: session.gameState,
    ...(session.pausedSince === undefined
      ? {}
      : { pausedSince: new Date(session.pausedSince).toISOString() }),
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "rt-rejoin must be called with POST.",
      405,
    );
  }

  const callerId = await authenticatedAccountId(req);
  if (!callerId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to rejoin a game.",
      401,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "Request body must be JSON.",
      400,
      { fields: ["sessionId"] },
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (sessionId.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `sessionId` is required.",
      400,
      { fields: ["sessionId"] },
    );
  }

  const db = serviceClient();
  const loaded = await loadSession(db, sessionId);

  if (!loaded || !isMember(loaded.members, callerId)) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No real-time session exists for the supplied id.",
      404,
    );
  }

  const { session } = loaded;
  const now = Date.now();

  // Terminal: present the recorded outcome rather than failing (Req 6.8).
  if (session.state === "terminal") {
    return jsonResponse({
      resumed: false,
      session: sessionView(session),
      outcome: session.outcome ?? null,
    });
  }

  // Already active (for example the partner reconnected before the 30s pause
  // threshold): nothing to resume, return the current state.
  if (session.state === "active") {
    return jsonResponse({ resumed: false, session: sessionView(session) });
  }

  // Authoritative transition: enforces the 5-minute window and restores the
  // preserved state.
  const transition = resumeSession(session as unknown as CoreSession, now);
  if (!transition.ok) {
    // REJOIN_WINDOW_EXPIRED -> 410 Gone (the paused session is no longer
    // resumable; the cron job records it as ended without an outcome, Req 6.10).
    // Any other rejection is a state error (for example rejoining a pending
    // session).
    const status = transition.error.code === "REJOIN_WINDOW_EXPIRED" ? 410 : 409;
    return errorResponse(
      transition.error.code,
      transition.error.message,
      status,
      { sessionId, state: session.state },
    );
  }

  const pausedSince = session.pausedSince as number;
  const committed = await commitResume(db, sessionId, pausedSince, now);
  if (!committed) {
    // A concurrent rejoin resumed it, or the cron job terminated it, between the
    // read and the write. Report whatever the authoritative row now says.
    const current = await loadSession(db, sessionId);
    const latest = current?.session ?? session;
    return jsonResponse({
      resumed: false,
      session: sessionView(latest),
      ...(latest.outcome === undefined ? {} : { outcome: latest.outcome }),
    });
  }

  // Both partners resume from the same preserved state (Req 6.7).
  await publishSessionEvent(sessionId, RT_EVENTS.resumed, {
    sessionId,
    rejoinedPartner: callerId,
    resumedAt: new Date(now).toISOString(),
    gameState: committed.gameState,
  });

  return jsonResponse({
    resumed: true,
    rejoinedPartner: callerId,
    session: sessionView(committed),
  });
});

/* To invoke locally once the stack is running:

  curl -i --location --request POST \
    'http://127.0.0.1:54321/functions/v1/rt-rejoin' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{ "sessionId": "<SESSION_UUID>" }'
*/
