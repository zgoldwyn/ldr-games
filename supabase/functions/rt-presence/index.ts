// rt-presence Edge Function: Presence-driven disconnect -> pause
// (Requirements 6.6, 6.8).
//
// Clients subscribed to a real-time game channel track their partner through
// Realtime **Presence**. When a partner stops being present, the still-connected
// client reports the Presence snapshot here; this function is the authority on
// what that snapshot means:
//
//   1. It confirms the caller is one of the session's two partners (an unknown
//      caller is told the session does not exist, so nothing leaks).
//   2. It evaluates the snapshot server-side against the 30-second continuous
//      disconnect rule (`findDisconnectedMember`), clamping future `lastSeenAt`
//      values so a skewed or hostile client cannot fabricate a pause.
//   3. On a confirmed disconnect it applies the pure `pauseSession` transition
//      from `@ldr/core/rt-session` and commits `active -> paused` with a
//      compare-and-set update. `game_state` is never rewritten, so the current
//      game state is PRESERVED across the pause (Req 6.6).
//   4. It records a notification for the remaining partner (Req 6.6) and
//      broadcasts `paused` on the game channel so both clients show the paused
//      session with the preserved state.
//
// When the session is already terminal the recorded outcome is presented instead
// (Req 6.8), and any other non-active state is reported back unchanged so a
// repeated report is a harmless no-op. Terminating a pause that is never
// rejoined is the 5-minute cron job's responsibility (task 20.1), not this
// function's.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { pauseSession } from "@ldr/core/rt-session";

import { handleCors } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import {
  authenticatedAccountId,
  serviceClient,
} from "../_shared/supabase.ts";
import {
  commitPause,
  loadSession,
  publishSessionEvent,
  recordNotification,
} from "../_shared/rt-presence-store.ts";
import {
  DISCONNECT_THRESHOLD_MS,
  findDisconnectedMember,
  isMember,
  pausedNotification,
  type PresenceSample,
  remainingMember,
  RT_EVENTS,
  type RTSessionSnapshot,
} from "../_shared/rt-presence.ts";

/** The core `RTSession` shape (its ids are compile-time branded strings). */
type CoreSession = Parameters<typeof pauseSession>[0];

/**
 * Normalize one reported Presence entry. `lastSeenAt` accepts epoch
 * milliseconds or an ISO timestamp; anything unusable is dropped rather than
 * guessed, since a missing last-seen instant is no evidence of a 30s absence.
 */
function toSample(raw: unknown): PresenceSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const accountId = typeof entry.accountId === "string" ? entry.accountId : "";
  if (accountId.length === 0) return null;

  const online = entry.online === true;

  let lastSeenAt: number | null = null;
  if (typeof entry.lastSeenAt === "number" && Number.isFinite(entry.lastSeenAt)) {
    lastSeenAt = entry.lastSeenAt;
  } else if (typeof entry.lastSeenAt === "string") {
    const parsed = Date.parse(entry.lastSeenAt);
    if (!Number.isNaN(parsed)) lastSeenAt = parsed;
  }
  if (lastSeenAt === null) {
    // An online partner needs no last-seen instant; an offline one does.
    if (!online) return null;
    lastSeenAt = Date.now();
  }

  return { accountId, online, lastSeenAt };
}

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
      "rt-presence must be called with POST.",
      405,
    );
  }

  const callerId = await authenticatedAccountId(req);
  if (!callerId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to report presence.",
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

  const rawPresence = Array.isArray(body.presence) ? body.presence : [];
  const samples = rawPresence
    .map(toSample)
    .filter((sample): sample is PresenceSample => sample !== null);

  const db = serviceClient();
  const loaded = await loadSession(db, sessionId);

  // Unknown session, or a caller outside this pairing: identical response, so
  // membership in someone else's game is never observable.
  if (!loaded || !isMember(loaded.members, callerId)) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No real-time session exists for the supplied id.",
      404,
    );
  }

  const { session, members } = loaded;
  const now = Date.now();

  // Terminal: present the recorded outcome to whoever asks (Req 6.8).
  if (session.state === "terminal") {
    await publishSessionEvent(sessionId, RT_EVENTS.outcome, {
      sessionId,
      outcome: session.outcome ?? null,
      gameState: session.gameState,
    });
    return jsonResponse({
      paused: false,
      session: sessionView(session),
      outcome: session.outcome ?? null,
    });
  }

  // Only an active session can pause; anything else (pending, already paused)
  // is reported back unchanged so repeated reports are idempotent.
  if (session.state !== "active") {
    return jsonResponse({ paused: false, session: sessionView(session) });
  }

  const disconnected = findDisconnectedMember(samples, members, now);
  if (disconnected === null) {
    // Nobody has been absent for the full 30 seconds: play continues.
    return jsonResponse({
      paused: false,
      session: sessionView(session),
      disconnectThresholdMs: DISCONNECT_THRESHOLD_MS,
    });
  }

  // Authoritative transition (preserves game state, stamps the pause instant
  // that the 5-minute rejoin window runs from).
  const transition = pauseSession(session as unknown as CoreSession, now);
  if (!transition.ok) {
    return errorResponse(
      transition.error.code,
      transition.error.message,
      400,
    );
  }
  const paused = transition.value as unknown as RTSessionSnapshot;
  const pausedSince = paused.pausedSince ?? now;

  const committed = await commitPause(db, sessionId, pausedSince);
  if (!committed) {
    // A concurrent report paused (or a move terminated) the session first.
    const current = await loadSession(db, sessionId);
    return jsonResponse({
      paused: false,
      session: sessionView(current?.session ?? session),
    });
  }

  const remaining = remainingMember(members, disconnected);
  if (remaining) {
    await recordNotification(
      db,
      pausedNotification({
        recipient: remaining,
        sessionId,
        gameId: committed.gameId,
        disconnectedPartner: disconnected,
        pausedSince,
      }),
    );
  }

  // Both clients render the paused session from the preserved state.
  await publishSessionEvent(sessionId, RT_EVENTS.paused, {
    sessionId,
    disconnectedPartner: disconnected,
    pausedSince: new Date(pausedSince).toISOString(),
    gameState: committed.gameState,
  });

  return jsonResponse({
    paused: true,
    disconnectedPartner: disconnected,
    notifiedPartner: remaining,
    session: sessionView(committed),
  });
});

/* To invoke locally once the stack is running:

  curl -i --location --request POST \
    'http://127.0.0.1:54321/functions/v1/rt-presence' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{
      "sessionId": "<SESSION_UUID>",
      "presence": [
        { "accountId": "<ME>", "online": true },
        { "accountId": "<PARTNER>", "online": false,
          "lastSeenAt": "2026-08-26T06:25:00Z" }
      ]
    }'
*/
