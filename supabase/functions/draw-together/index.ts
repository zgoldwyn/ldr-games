import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  beginDrawTogetherTurn,
  completeDrawTogetherTurn,
  DRAW_TOGETHER,
  type DrawTogetherDifficulty,
  type DrawTogetherState,
  type DrawTogetherWordChoice,
  drawTogetherWordMask,
  finishDrawTogetherMatch,
  isCorrectDrawTogetherGuess,
  isDrawTogetherState,
  parseDrawTogetherMatchSeconds,
  startDrawTogetherMatch,
} from "@ldr/core/rt-draw-together";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import { broadcast, gameChannelTopic } from "../_shared/realtime.ts";
import { authenticatedAccountId, serviceClient } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SESSION_COLUMNS =
  "id, pairing_id, game_id, state, game_state, outcome, updated_at";

interface SessionRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly game_id: string;
  readonly state: string;
  readonly game_state: unknown;
  readonly outcome: unknown;
  readonly updated_at: string;
}

interface SecretRow {
  readonly choice_word_ids: readonly string[];
  readonly active_word_id: string | null;
  readonly choice_deadline: string | null;
  readonly active_started_at: string | null;
}

interface WordRow {
  readonly id: string;
  readonly word: string;
  readonly difficulty: DrawTogetherDifficulty;
}

type Loaded = {
  readonly row: SessionRow;
  readonly state: DrawTogetherState;
  readonly secret: SecretRow | null;
};

function sessionView(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    pairingId: row.pairing_id,
    gameId: row.game_id,
    state: row.state,
    gameState: row.game_state,
    outcome: row.outcome ?? null,
  };
}

async function load(
  db: SupabaseClient,
  actor: string,
  rawSessionId: unknown,
): Promise<Loaded | Response> {
  if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `sessionId` is required.",
      400,
      { fields: ["sessionId"] },
    );
  }

  const { data: row, error } = await db
    .from("rt_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", rawSessionId)
    .maybeSingle();
  if (error) {
    return errorResponse("INTERNAL_ERROR", "Failed to load the game.", 500);
  }
  if (!row || row.game_id !== DRAW_TOGETHER) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No Draw Together session exists for the supplied id.",
      statusForErrorCode("SESSION_NOT_FOUND"),
    );
  }

  const { data: pairing } = await db
    .from("pairings")
    .select("member_a, member_b, status")
    .eq("id", row.pairing_id)
    .maybeSingle();
  if (
    !pairing ||
    pairing.status !== "active" ||
    (pairing.member_a !== actor && pairing.member_b !== actor)
  ) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No Draw Together session exists for the supplied id.",
      statusForErrorCode("SESSION_NOT_FOUND"),
    );
  }
  if (row.state !== "active" && row.state !== "terminal") {
    return errorResponse(
      "INVALID_SESSION_STATE",
      "Both partners must join before the match can continue.",
      statusForErrorCode("INVALID_SESSION_STATE"),
    );
  }
  if (!isDrawTogetherState(row.game_state)) {
    return errorResponse(
      "INTERNAL_ERROR",
      "The Draw Together state is invalid.",
      500,
    );
  }

  const { data: secret, error: secretError } = await db
    .from("draw_together_secrets")
    .select(
      "choice_word_ids, active_word_id, choice_deadline, active_started_at",
    )
    .eq("session_id", row.id)
    .maybeSingle();
  if (secretError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the private game state.",
      500,
    );
  }

  return {
    row: row as SessionRow,
    state: row.game_state as DrawTogetherState,
    secret: secret as SecretRow | null,
  };
}

function randomRow(rows: readonly WordRow[]): WordRow | undefined {
  if (rows.length === 0) return undefined;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return rows[random[0] % rows.length];
}

async function newChoices(
  db: SupabaseClient,
  state: DrawTogetherState,
): Promise<readonly WordRow[] | null> {
  const used = new Set(state.attempts.map((attempt) => attempt.word));
  const { data, error } = await db
    .from("draw_together_words")
    .select("id, word, difficulty")
    .eq("enabled", true)
    .eq("catalog_version", 1);
  if (error || data === null) return null;

  const result: WordRow[] = [];
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const available = (data as WordRow[]).filter(
      (word) => word.difficulty === difficulty && !used.has(word.word),
    );
    const selected = randomRow(
      available.length > 0
        ? available
        : (data as WordRow[]).filter((word) => word.difficulty === difficulty),
    );
    if (selected === undefined) return null;
    result.push(selected);
  }
  return result;
}

async function wordsByIds(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<readonly WordRow[]> {
  if (ids.length === 0) return [];
  const { data } = await db
    .from("draw_together_words")
    .select("id, word, difficulty")
    .in("id", [...ids]);
  const rows = (data ?? []) as WordRow[];
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

async function wordById(
  db: SupabaseClient,
  id: string | null,
): Promise<WordRow | null> {
  if (id === null) return null;
  const { data } = await db
    .from("draw_together_words")
    .select("id, word, difficulty")
    .eq("id", id)
    .maybeSingle();
  return data as WordRow | null;
}

function privateChoices(
  rows: readonly WordRow[],
): readonly DrawTogetherWordChoice[] {
  return rows.map(({ id, word, difficulty }) => ({ id, word, difficulty }));
}

async function publish(row: SessionRow): Promise<void> {
  if (!SERVICE_ROLE_KEY) return;
  try {
    await broadcast(SERVICE_ROLE_KEY, [{
      topic: gameChannelTopic(row.id),
      event: "session_state",
      payload: sessionView(row),
    }]);
  } catch {
    // The durable row is the recovery path.
  }
}

async function commit(
  db: SupabaseClient,
  loaded: Loaded,
  actor: string,
  nextState: DrawTogetherState,
  secret: {
    readonly choiceIds: readonly string[];
    readonly activeWordId: string | null;
    readonly choiceDeadline: number | null;
    readonly activeStartedAt: number | null;
  },
  now: number,
): Promise<SessionRow | Response> {
  const terminal = nextState.phase === "finished";
  const outcome = terminal
    ? { kind: "completed", winner: null, recordedAt: now }
    : null;
  const { data, error } = await db.rpc("draw_together_commit", {
    p_session: loaded.row.id,
    p_actor: actor,
    p_expected_updated_at: loaded.row.updated_at,
    p_game_state: nextState,
    p_session_state: terminal ? "terminal" : "active",
    p_outcome: outcome,
    p_choice_word_ids: [...secret.choiceIds],
    p_active_word_id: secret.activeWordId,
    p_choice_deadline: secret.choiceDeadline === null
      ? null
      : new Date(secret.choiceDeadline).toISOString(),
    p_active_started_at: secret.activeStartedAt === null
      ? null
      : new Date(secret.activeStartedAt).toISOString(),
    p_now: new Date(now).toISOString(),
  });
  if (error) {
    console.error("draw_together_commit failed", error.message);
    return errorResponse("INTERNAL_ERROR", "Failed to save the game.", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as SessionRow | undefined;
  if (!row) {
    return errorResponse(
      "INVALID_SESSION_STATE",
      "The game changed concurrently. Reload and try again.",
      statusForErrorCode("INVALID_SESSION_STATE"),
    );
  }
  await publish(row);
  return row;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function responseFor(
  db: SupabaseClient,
  actor: string,
  row: SessionRow,
  state: DrawTogetherState,
  secret: SecretRow | null,
  extras: Record<string, unknown> = {},
): Promise<Response> {
  const payload: Record<string, unknown> = {
    session: sessionView(row),
    ...extras,
  };
  if (actor === state.drawer && secret !== null) {
    if (state.phase === "choosing") {
      payload.choices = privateChoices(
        await wordsByIds(db, secret.choice_word_ids),
      );
    } else if (state.phase === "drawing") {
      const word = await wordById(db, secret.active_word_id);
      if (word !== null) payload.word = word.word;
    }
  }
  if (state.phase === "finished") {
    const { data } = await db
      .from("draw_together_best_scores")
      .select("score")
      .eq("pairing_id", row.pairing_id)
      .eq("duration_seconds", state.matchDurationSeconds)
      .maybeSingle();
    payload.bestScore = data?.score ?? state.score;
  }
  return jsonResponse(payload);
}

async function finishMiss(
  db: SupabaseClient,
  loaded: Loaded,
  actor: string,
  now: number,
): Promise<Response> {
  const word = await wordById(db, loaded.secret?.active_word_id ?? null);
  if (word === null) {
    return errorResponse(
      "INTERNAL_ERROR",
      "The active word is unavailable.",
      500,
    );
  }
  const completed = completeDrawTogetherTurn(loaded.state, {
    word: word.word,
    difficulty: word.difficulty,
    solved: false,
    now,
  });
  if (!completed.ok) {
    return errorResponse(
      completed.error.code,
      completed.error.message,
      statusForErrorCode(completed.error.code),
    );
  }
  const choices = completed.value.phase === "finished"
    ? []
    : await newChoices(db, completed.value);
  if (choices === null) {
    return errorResponse(
      "INTERNAL_ERROR",
      "No word choices are available.",
      500,
    );
  }
  const row = await commit(db, loaded, actor, completed.value, {
    choiceIds: choices.map((choice) => choice.id),
    activeWordId: null,
    choiceDeadline: completed.value.choiceEndsAt,
    activeStartedAt: null,
  }, now);
  if (isResponse(row)) return row;
  return await responseFor(db, actor, row, completed.value, {
    choice_word_ids: choices.map((choice) => choice.id),
    active_word_id: null,
    choice_deadline: completed.value.choiceEndsAt === null
      ? null
      : new Date(completed.value.choiceEndsAt).toISOString(),
    active_started_at: null,
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "Draw Together accepts POST requests only.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid session is required.",
      401,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = typeof body.action === "string" ? body.action : "state";
  const db = serviceClient();
  const loaded = await load(db, actor, body.sessionId);
  if (isResponse(loaded)) return loaded;
  const now = Date.now();

  if (action === "start") {
    if (loaded.state.drawer !== actor) {
      return errorResponse(
        "INVALID_MOVE",
        "The first drawer starts the match.",
        statusForErrorCode("INVALID_MOVE"),
      );
    }
    const duration = parseDrawTogetherMatchSeconds(body.durationSeconds);
    if (!duration.ok) {
      return errorResponse(
        duration.error.code,
        duration.error.message,
        statusForErrorCode(duration.error.code),
      );
    }
    const started = startDrawTogetherMatch(loaded.state, duration.value, now);
    if (!started.ok) {
      return errorResponse(
        started.error.code,
        started.error.message,
        statusForErrorCode(started.error.code),
      );
    }
    const choices = await newChoices(db, started.value);
    if (choices === null) {
      return errorResponse(
        "INTERNAL_ERROR",
        "No word choices are available.",
        500,
      );
    }
    const row = await commit(db, loaded, actor, started.value, {
      choiceIds: choices.map((word) => word.id),
      activeWordId: null,
      choiceDeadline: started.value.choiceEndsAt,
      activeStartedAt: null,
    }, now);
    if (isResponse(row)) return row;
    return jsonResponse({
      session: sessionView(row),
      choices: privateChoices(choices),
    });
  }

  if (action === "choose") {
    if (loaded.state.phase !== "choosing" || loaded.state.drawer !== actor) {
      return errorResponse(
        "INVALID_MOVE",
        "Only the current drawer can choose a word.",
        statusForErrorCode("INVALID_MOVE"),
      );
    }
    const choices = await wordsByIds(
      db,
      loaded.secret?.choice_word_ids ?? [],
    );
    const deadlinePassed = loaded.state.choiceEndsAt !== null &&
      now >= loaded.state.choiceEndsAt;
    const requested = !deadlinePassed && typeof body.choiceId === "string"
      ? choices.find((word) => word.id === body.choiceId)
      : undefined;
    const selected = requested ??
      choices.find((word) => word.difficulty === "medium");
    if (selected === undefined) {
      return errorResponse(
        "INVALID_MOVE",
        "Choose one of the offered words.",
        statusForErrorCode("INVALID_MOVE"),
      );
    }
    const begun = beginDrawTogetherTurn(
      loaded.state,
      selected.difficulty,
      drawTogetherWordMask(selected.word),
      now,
    );
    if (!begun.ok) {
      return errorResponse(
        begun.error.code,
        begun.error.message,
        statusForErrorCode(begun.error.code),
      );
    }
    const row = await commit(db, loaded, actor, begun.value, {
      choiceIds: [],
      activeWordId: selected.id,
      choiceDeadline: null,
      activeStartedAt: now,
    }, now);
    if (isResponse(row)) return row;
    return jsonResponse({ session: sessionView(row), word: selected.word });
  }

  if (action === "guess") {
    if (loaded.state.phase !== "drawing" || loaded.state.guesser !== actor) {
      return errorResponse(
        "INVALID_MOVE",
        "Only the current guesser can submit a guess.",
        statusForErrorCode("INVALID_MOVE"),
      );
    }
    const word = await wordById(db, loaded.secret?.active_word_id ?? null);
    if (word === null) {
      return errorResponse(
        "INTERNAL_ERROR",
        "The active word is unavailable.",
        500,
      );
    }
    if (loaded.state.turnEndsAt !== null && now >= loaded.state.turnEndsAt) {
      return await finishMiss(db, loaded, actor, now);
    }
    const guess = typeof body.guess === "string" ? body.guess : "";
    if (!isCorrectDrawTogetherGuess(guess, word.word)) {
      return jsonResponse({ session: sessionView(loaded.row), correct: false });
    }
    const completed = completeDrawTogetherTurn(loaded.state, {
      word: word.word,
      difficulty: word.difficulty,
      solved: true,
      now,
    });
    if (!completed.ok) {
      return errorResponse(
        completed.error.code,
        completed.error.message,
        statusForErrorCode(completed.error.code),
      );
    }
    const choices = completed.value.phase === "finished"
      ? []
      : await newChoices(db, completed.value);
    if (choices === null) {
      return errorResponse(
        "INTERNAL_ERROR",
        "No word choices are available.",
        500,
      );
    }
    const row = await commit(db, loaded, actor, completed.value, {
      choiceIds: choices.map((choice) => choice.id),
      activeWordId: null,
      choiceDeadline: completed.value.choiceEndsAt,
      activeStartedAt: null,
    }, now);
    if (isResponse(row)) return row;
    return await responseFor(
      db,
      actor,
      row,
      completed.value,
      {
        choice_word_ids: choices.map((choice) => choice.id),
        active_word_id: null,
        choice_deadline: completed.value.choiceEndsAt === null
          ? null
          : new Date(completed.value.choiceEndsAt).toISOString(),
        active_started_at: null,
      },
      { correct: true },
    );
  }

  if (action === "timeout") {
    if (
      loaded.state.phase !== "drawing" ||
      loaded.state.turnEndsAt === null ||
      now < loaded.state.turnEndsAt
    ) {
      return errorResponse(
        "INVALID_MOVE",
        "The drawing timer has not expired.",
        statusForErrorCode("INVALID_MOVE"),
      );
    }
    return await finishMiss(db, loaded, actor, now);
  }

  // A state read also resolves expired choice/match windows so reconnecting
  // clients cannot leave the game stuck forever.
  if (action === "state") {
    if (
      loaded.state.phase === "choosing" &&
      loaded.state.choiceEndsAt !== null &&
      now >= loaded.state.choiceEndsAt
    ) {
      const choices = await wordsByIds(
        db,
        loaded.secret?.choice_word_ids ?? [],
      );
      const selected = choices.find((word) => word.difficulty === "medium");
      if (selected === undefined) {
        return errorResponse(
          "INTERNAL_ERROR",
          "No default word is available.",
          500,
        );
      }
      const begun = beginDrawTogetherTurn(
        loaded.state,
        selected.difficulty,
        drawTogetherWordMask(selected.word),
        now,
      );
      if (!begun.ok) {
        return errorResponse(
          begun.error.code,
          begun.error.message,
          statusForErrorCode(begun.error.code),
        );
      }
      const row = await commit(db, loaded, actor, begun.value, {
        choiceIds: [],
        activeWordId: selected.id,
        choiceDeadline: null,
        activeStartedAt: now,
      }, now);
      if (isResponse(row)) return row;
      return await responseFor(db, actor, row, begun.value, {
        choice_word_ids: [],
        active_word_id: selected.id,
        choice_deadline: null,
        active_started_at: new Date(now).toISOString(),
      });
    }
    if (
      loaded.state.phase === "drawing" &&
      loaded.state.turnEndsAt !== null &&
      now >= loaded.state.turnEndsAt
    ) {
      return await finishMiss(db, loaded, actor, now);
    }
    return await responseFor(
      db,
      actor,
      loaded.row,
      loaded.state,
      loaded.secret,
    );
  }

  return errorResponse("INVALID_MOVE", "Unknown Draw Together action.", 400);
});
