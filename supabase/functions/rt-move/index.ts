// Real-time game session Edge Function (Requirements 6.1, 6.2, 6.4, 6.5, 6.11).
//
// This is the single server-authoritative entry point for live play. Clients
// never write `rt_sessions` themselves (RLS grants them SELECT only); they POST
// an intent here and the function decides, persists, and fans the result out over
// a Realtime **Broadcast** channel so both partners see it in well under 2
// seconds (Req 6.4) without waiting for a database change feed.
//
// Actions (`body.action`, defaulting to `move`):
//   * `games`  — the catalog of available real-time games for a paired user (6.1)
//   * `invite` — create a `pending` session and notify the partner within 5s (6.2)
//   * `join`   — record a partner as joined; both joined inside the 60s window
//                activates the session with one identical initial state (6.3)
//   * `move`   — validate a move authoritatively and fan the new state out (6.4)
//
// Every decision is made by the pure, property-tested `@ldr/core` logic re-exported
// from `../_shared/rt-core.ts` (`requirePairing`, `joinSession`, `applyMove`); this
// module only performs I/O around it. Two consequences matter:
//   * an unpaired caller is rejected with PAIRING_REQUIRED before anything is
//     written (Req 6.5), and
//   * an invalid move returns INVALID_MOVE and performs NO write at all, so the
//     authoritative state is retained byte-for-byte (Req 6.11).
//
// Writes use a compare-and-set on `updated_at` so two moves racing on the same
// session can never interleave into a state neither client saw.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
import {
  accountTopic,
  type BroadcastMessage,
  broadcast,
  gameChannelTopic,
} from "../_shared/realtime.ts";
import {
  accountId,
  applyMove,
  gameId,
  getRuleset,
  joinSession,
  listRulesets,
  pairingId,
  requirePairing,
  sessionId,
} from "../_shared/rt-core.ts";
import { type SupabaseClient } from "@supabase/supabase-js";

/** Service-role key used to publish Broadcast messages from server code. */
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/**
 * Columns of a session row this function reads.
 *
 * Kept as ONE string literal rather than a concatenation: `supabase-js` parses
 * the select list at the type level, and a concatenation widens to `string`,
 * which collapses every row type to `GenericStringError`.
 */
const SESSION_COLUMNS =
  "id, pairing_id, game_id, state, game_state, outcome, pending_since, paused_since, joined_accounts, updated_at";

/**
 * Publish Broadcast messages, best-effort. Broadcast is the low-latency path; the
 * durable `rt_sessions` row (readable by both partners) and the notification row
 * remain the source of truth if a message is missed.
 */
async function fanOut(messages: readonly BroadcastMessage[]): Promise<void> {
  if (!SERVICE_ROLE_KEY) return;
  try {
    await broadcast(SERVICE_ROLE_KEY, messages);
  } catch {
    // Delivery is best-effort: clients re-derive state from the session row.
  }
}

/** The caller's pairing context: who they are, and who their partner is. */
interface CallerContext {
  readonly actor: string;
  readonly pairing: string;
  /** Both pairing members, in the pairing's own (stable) member order. */
  readonly members: readonly [string, string];
  readonly partner: string;
}

type ContextResult =
  | { readonly ok: true; readonly ctx: CallerContext }
  | { readonly ok: false; readonly res: Response };

/**
 * Resolve the caller's active pairing. Rejects an unpaired caller with
 * PAIRING_REQUIRED via the shared `requirePairing` guard (Req 6.5) — no session
 * may be listed, created, joined, or moved in without a partner.
 */
async function loadContext(
  db: SupabaseClient,
  actor: string,
): Promise<ContextResult> {
  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("id, pairing_id")
    .eq("id", actor)
    .maybeSingle();

  if (accountErr) {
    return {
      ok: false,
      res: errorResponse("INTERNAL_ERROR", "Failed to load the account.", 500),
    };
  }
  if (!account) {
    return {
      ok: false,
      res: errorResponse(
        "UNAUTHENTICATED",
        "The authenticated account no longer exists.",
        401,
      ),
    };
  }

  // Pure guard: a partner is required to play a real-time game (Req 6.5).
  const guard = requirePairing({
    pairingId: account.pairing_id === null
      ? null
      : pairingId(account.pairing_id),
  });
  if (!guard.ok) {
    return {
      ok: false,
      res: errorResponse(
        guard.error.code,
        guard.error.message,
        statusForErrorCode(guard.error.code),
      ),
    };
  }

  const { data: pairing, error: pairingErr } = await db
    .from("pairings")
    .select("id, member_a, member_b, status")
    .eq("id", guard.value)
    .maybeSingle();

  if (pairingErr) {
    return {
      ok: false,
      res: errorResponse("INTERNAL_ERROR", "Failed to load the pairing.", 500),
    };
  }
  if (!pairing || pairing.status !== "active") {
    return {
      ok: false,
      res: errorResponse(
        "PAIRING_REQUIRED",
        "A partner pairing is required to start a session.",
        statusForErrorCode("PAIRING_REQUIRED"),
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      actor,
      pairing: pairing.id,
      members: [pairing.member_a, pairing.member_b],
      partner: pairing.member_a === actor ? pairing.member_b : pairing.member_a,
    },
  };
}

/** The JSON shape of a session returned to clients. */
function sessionView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    pairingId: row.pairing_id,
    gameId: row.game_id,
    state: row.state,
    gameState: row.game_state,
    outcome: row.outcome ?? null,
    pendingSince: row.pending_since ?? null,
  };
}

/**
 * The catalog of real-time games available to a paired user (Req 6.1). It is
 * derived from the registered rulesets, so the list a client sees is exactly the
 * set the server can validate moves for.
 */
function handleGames(): Response {
  return jsonResponse({
    games: listRulesets().map((ruleset) => ({
      id: ruleset.game,
      name: ruleset.name,
    })),
  });
}

/**
 * Invite the partner to a real-time game (Req 6.2): creates the session in the
 * `pending` state with the 60-second join deadline (`pending_since`), records the
 * inviter as already joined, and delivers the invitation two ways — a durable
 * `notifications` row (so it survives the partner being offline) plus an
 * immediate Broadcast on the partner's account topic, which is what keeps
 * delivery inside 5 seconds while both clients are connected.
 */
async function handleInvite(
  db: SupabaseClient,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const requested = typeof body.gameId === "string" ? body.gameId : "";
  if (requested.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `gameId` is required to invite a partner to a real-time game.",
      400,
      { fields: ["gameId"] },
    );
  }
  if (!getRuleset(requested)) {
    return errorResponse(
      "GAME_NOT_FOUND",
      `No real-time game is available for id "${requested}".`,
      statusForErrorCode("GAME_NOT_FOUND"),
    );
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const { data: created, error: insertErr } = await db
    .from("rt_sessions")
    .insert({
      pairing_id: ctx.pairing,
      game_id: requested,
      state: "pending",
      game_state: {},
      // Drives the 60-second join window / expiry job (Req 6.3, 6.9).
      pending_since: nowIso,
      // The inviter counts as joined; element 0 marks them as the first mover.
      joined_accounts: [ctx.actor],
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select(SESSION_COLUMNS)
    .single();

  if (insertErr || !created) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to create the real-time game session.",
      500,
    );
  }

  const payload = {
    type: "rt_game_invite",
    sessionId: created.id,
    gameId: created.game_id,
    pairingId: ctx.pairing,
    fromAccountId: ctx.actor,
    pendingSince: nowIso,
  };

  // Durable invitation notification for the partner (Req 6.2, 11.4). The
  // (recipient, dedupe_key) unique index makes a retry idempotent.
  const { error: notifyErr } = await db.from("notifications").upsert(
    {
      recipient_account_id: ctx.partner,
      category: "game_invite",
      payload,
      dedupe_key: `rt-invite:${created.id}`,
      created_at: nowIso,
    },
    { onConflict: "recipient_account_id,dedupe_key", ignoreDuplicates: true },
  );
  if (notifyErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to record the invitation notification.",
      500,
    );
  }

  // Live signal so the partner is prompted within 5 seconds (Req 6.2).
  await fanOut([
    { topic: accountTopic(ctx.partner), event: "game_invite", payload },
    {
      topic: gameChannelTopic(created.id),
      event: "session_state",
      payload: sessionView(created),
    },
  ]);

  return jsonResponse({ session: sessionView(created) }, 201);
}

type SessionResult =
  // deno-lint-ignore no-explicit-any
  | { readonly ok: true; readonly row: any }
  | { readonly ok: false; readonly res: Response };

/**
 * Load a session the caller is allowed to act on. A session belonging to another
 * pairing is reported as SESSION_NOT_FOUND rather than as a permission error, so
 * the function never confirms the existence of another pairing's session.
 */
async function loadSession(
  db: SupabaseClient,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<SessionResult> {
  const id = typeof body.sessionId === "string" ? body.sessionId : "";
  if (id.length === 0) {
    return {
      ok: false,
      res: errorResponse(
        "MISSING_REQUIRED_FIELD",
        "A `sessionId` is required.",
        400,
        { fields: ["sessionId"] },
      ),
    };
  }

  const { data: row, error } = await db
    .from("rt_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      res: errorResponse("INTERNAL_ERROR", "Failed to load the session.", 500),
    };
  }
  if (!row || row.pairing_id !== ctx.pairing) {
    return {
      ok: false,
      res: errorResponse(
        "SESSION_NOT_FOUND",
        "No real-time game session exists for this pairing with that id.",
        statusForErrorCode("SESSION_NOT_FOUND"),
      ),
    };
  }
  return { ok: true, row };
}

/**
 * Join a pending session (Req 6.3). The pure `joinSession` transition decides:
 * it rejects a session that is not pending (INVALID_SESSION_STATE) or whose
 * 60-second window has elapsed (JOIN_WINDOW_EXPIRED), keeps the session pending
 * while only one partner is present, and activates it once both are — seeding the
 * single authoritative initial state that both partners then render identically.
 */
async function handleJoin(
  db: SupabaseClient,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const loaded = await loadSession(db, ctx, body);
  if (!loaded.ok) return loaded.res;
  const row = loaded.row;

  const ruleset = getRuleset(row.game_id);
  if (!ruleset) {
    return errorResponse(
      "GAME_NOT_FOUND",
      `No real-time game is available for id "${row.game_id}".`,
      statusForErrorCode("GAME_NOT_FOUND"),
    );
  }

  const now = Date.now();
  const joined: readonly string[] = row.joined_accounts ?? [];
  const present = [...new Set([...joined, ctx.actor])];
  // The inviter (recorded first at invite time) moves first; falling back to the
  // pairing's first member keeps the choice deterministic for both partners.
  const first = joined[0] ?? ctx.members[0];

  const initialState = ruleset.createInitialState(
    [accountId(ctx.members[0]), accountId(ctx.members[1])],
    accountId(first),
  );

  const decision = joinSession(
    {
      id: sessionId(row.id),
      pairingId: pairingId(row.pairing_id),
      gameId: gameId(row.game_id),
      state: row.state,
      gameState: row.game_state ?? {},
      pendingSince: row.pending_since
        ? Date.parse(row.pending_since)
        : undefined,
    },
    present.map(accountId),
    { a: accountId(ctx.members[0]), b: accountId(ctx.members[1]) },
    initialState,
    now,
  );

  if (!decision.ok) {
    return errorResponse(
      decision.error.code,
      decision.error.message,
      statusForErrorCode(decision.error.code),
    );
  }

  const next = decision.value;
  const activated = next.state === "active";

  // Compare-and-set on `updated_at`: if the other partner's join landed first,
  // this update matches no row and the caller retries against fresh state.
  const { data: saved, error: updateErr } = await db
    .from("rt_sessions")
    .update({
      joined_accounts: present,
      state: next.state,
      game_state: next.gameState,
      // The join deadline only matters while pending (Req 6.9).
      pending_since: activated ? null : row.pending_since,
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (updateErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to record the join.",
      500,
    );
  }
  if (!saved) {
    return errorResponse(
      "INVALID_SESSION_STATE",
      "The session was modified concurrently; reload it and retry.",
      statusForErrorCode("INVALID_SESSION_STATE"),
    );
  }

  // Both partners receive the same state message, so activation presents
  // identical game state on both clients (Req 6.3).
  await fanOut([
    {
      topic: gameChannelTopic(saved.id),
      event: "session_state",
      payload: { ...sessionView(saved), joinedAccounts: present },
    },
  ]);

  return jsonResponse({ session: sessionView(saved) });
}

/**
 * Validate and apply a move (Req 6.4, 6.11).
 *
 * The authoritative `applyMove` engine decides. On rejection the function
 * returns INVALID_MOVE and writes nothing at all, so the stored state is retained
 * exactly as it was (Req 6.11) — the unchanged state is echoed back in `details`
 * so a client that guessed wrong can resynchronise without an extra round trip.
 * On acceptance the new state is persisted and immediately broadcast, which is
 * what reflects the move on both clients inside 2 seconds (Req 6.4). A move that
 * ends the game also records the outcome (Req 6.8).
 */
async function handleMove(
  db: SupabaseClient,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const move = body.move;
  if (typeof move !== "object" || move === null || Array.isArray(move)) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `move` object is required.",
      400,
      { fields: ["move"] },
    );
  }

  const loaded = await loadSession(db, ctx, body);
  if (!loaded.ok) return loaded.res;
  const row = loaded.row;

  if (row.state !== "active") {
    return errorResponse(
      "INVALID_SESSION_STATE",
      `Moves are only accepted while the session is active (state: "${row.state}").`,
      statusForErrorCode("INVALID_SESSION_STATE"),
    );
  }

  const now = Date.now();
  const result = applyMove(
    row.game_state ?? {},
    accountId(ctx.actor),
    move as Record<string, unknown>,
  );

  if (!result.ok) {
    // Rejected: no write happened, so the authoritative state is unchanged.
    return errorResponse(
      result.error.code,
      result.error.message,
      statusForErrorCode(result.error.code),
      { gameState: row.game_state ?? {} },
    );
  }

  const nextState = result.value;
  const ruleset = getRuleset(
    typeof nextState.game === "string" ? nextState.game : row.game_id,
  );
  if (!ruleset) {
    return errorResponse(
      "GAME_NOT_FOUND",
      `No real-time game is available for id "${row.game_id}".`,
      statusForErrorCode("GAME_NOT_FOUND"),
    );
  }

  // The ruleset owns terminal detection and outcome derivation (Req 6.8). The
  // engine returns the open `GameState` shape, so it is handed back to the
  // ruleset that just produced it.
  // deno-lint-ignore no-explicit-any
  const rulesetState = nextState as any;
  const terminal = ruleset.isTerminal(rulesetState);
  const outcome = terminal ? ruleset.outcome(rulesetState, now) : null;

  // Compare-and-set on `updated_at` serialises concurrent moves: the loser sees
  // no updated row and retries against the state the winner produced.
  const { data: saved, error: updateErr } = await db
    .from("rt_sessions")
    .update({
      game_state: nextState,
      state: terminal ? "terminal" : "active",
      outcome,
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (updateErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to persist the authoritative game state.",
      500,
    );
  }
  if (!saved) {
    return errorResponse(
      "INVALID_SESSION_STATE",
      "The session was modified concurrently; reload it and retry.",
      statusForErrorCode("INVALID_SESSION_STATE"),
    );
  }

  // Fan out the authoritative state to both partners (<2s, Req 6.4).
  await fanOut([
    {
      topic: gameChannelTopic(saved.id),
      event: "move",
      payload: {
        sessionId: saved.id,
        actor: ctx.actor,
        move,
        ...sessionView(saved),
      },
    },
  ]);

  return jsonResponse({ session: sessionView(saved) });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "rt-move must be called with POST.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to play a real-time game.",
      401,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const action = typeof body.action === "string" ? body.action : "move";

  const db = serviceClient();
  // Every action requires an active pairing (Req 6.1, 6.5).
  const context = await loadContext(db, actor);
  if (!context.ok) return context.res;

  switch (action) {
    case "games":
      return handleGames();
    case "invite":
      return await handleInvite(db, context.ctx, body);
    case "join":
      return await handleJoin(db, context.ctx, body);
    case "move":
      return await handleMove(db, context.ctx, body);
    default:
      return errorResponse(
        "MISSING_REQUIRED_FIELD",
        `Unknown action "${action}"; expected games, invite, join, or move.`,
        400,
        { fields: ["action"] },
      );
  }
});

/* To invoke locally once the stack is running:

  # list the available real-time games (Req 6.1)
  curl -i --request POST 'http://127.0.0.1:54321/functions/v1/rt-move' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"action":"games"}'

  # invite the partner (Req 6.2)
  curl -i --request POST 'http://127.0.0.1:54321/functions/v1/rt-move' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"action":"invite","gameId":"tic-tac-toe"}'

  # play a move (Req 6.4)
  curl -i --request POST 'http://127.0.0.1:54321/functions/v1/rt-move' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"action":"move","sessionId":"<SESSION_ID>","move":{"type":"place","cell":4}}'
*/
