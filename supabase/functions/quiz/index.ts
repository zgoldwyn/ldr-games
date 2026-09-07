// Server-authoritative quiz lifecycle endpoint (Requirement 8).
//
// Clients submit intents to this single endpoint; all quiz state is read,
// validated with the shared pure state machine, then committed through a
// service-role RPC. This keeps self-answer withholding and answer validation
// identical in every client while the locked database transaction remains the
// authority for phase advancement and scoring under concurrency.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  accountId,
  pairingId,
  questionId,
  quizId,
  sessionId,
} from "@ldr/core/common";
import type { Answer, QuizQuestion, QuizSession } from "@ldr/core/quiz";
import {
  buildQuizResults,
  buildQuizSessionView,
  createQuizSession,
  type QuizSessionState,
  recordGuess,
  recordSelfAnswer,
} from "@ldr/core/quiz-session";
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
  tokenEpoch,
} from "../_shared/supabase.ts";

type QuizAction = "start" | "self_answer" | "guess";

interface PairingContext {
  readonly actor: string;
  readonly pairingId: string;
  readonly members: readonly [string, string];
}

interface SessionRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly quiz_id: string;
  readonly phase: "self_answer" | "guessing" | "complete";
  readonly scores: unknown;
}

interface AnswerRow {
  readonly account_id: string;
  readonly question_id: string;
  readonly answer?: unknown;
  readonly guess?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnswer(value: unknown): value is Answer {
  return isRecord(value) &&
    (value.kind === "choice" || value.kind === "text") &&
    typeof value.value === "string";
}

function isAction(value: unknown): value is QuizAction {
  return value === "start" || value === "self_answer" || value === "guess";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

/** Accept the long operation names as a compatibility-friendly request form. */
function normalizeAction(value: unknown): QuizAction | null {
  switch (value) {
    case "start":
    case "startSession":
      return "start";
    case "self_answer":
    case "submitSelfAnswer":
      return "self_answer";
    case "guess":
    case "submitGuess":
      return "guess";
    default:
      return isAction(value) ? value : null;
  }
}

function asQuestion(row: Record<string, unknown>): QuizQuestion | null {
  if (
    typeof row.id !== "string" || typeof row.quiz_id !== "string" ||
    typeof row.prompt !== "string" ||
    (row.type !== "multiple_choice" && row.type !== "short_answer")
  ) return null;

  if (row.type === "multiple_choice") {
    if (
      !Array.isArray(row.choices) ||
      !row.choices.every((c) => typeof c === "string")
    ) {
      return null;
    }
    return {
      id: questionId(row.id),
      quizId: quizId(row.quiz_id),
      type: "multiple_choice",
      prompt: row.prompt,
      choices: row.choices,
    };
  }

  return {
    id: questionId(row.id),
    quizId: quizId(row.quiz_id),
    type: "short_answer",
    prompt: row.prompt,
  };
}

function asScores(
  value: unknown,
  members: readonly [string, string],
): Record<ReturnType<typeof accountId>, number> {
  const raw = isRecord(value) ? value : {};
  return {
    [accountId(members[0])]: typeof raw[members[0]] === "number"
      ? raw[members[0]]
      : 0,
    [accountId(members[1])]: typeof raw[members[1]] === "number"
      ? raw[members[1]]
      : 0,
  } as Record<ReturnType<typeof accountId>, number>;
}

async function activePairing(actor: string): Promise<
  { ok: true; value: PairingContext } | { ok: false; response: Response }
> {
  const db = serviceClient();
  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("pairing_id")
    .eq("id", actor)
    .maybeSingle();
  if (accountError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the account.",
        500,
      ),
    };
  }

  const required = requirePairing({ pairingId: account?.pairing_id ?? null });
  if (!required.ok) {
    return {
      ok: false,
      response: errorResponse(
        required.error.code,
        required.error.message,
        statusForErrorCode(required.error.code),
      ),
    };
  }

  const { data: pairing, error: pairingError } = await db
    .from("pairings")
    .select("id, member_a, member_b, status")
    .eq("id", required.value)
    .maybeSingle();
  if (pairingError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the pairing.",
        500,
      ),
    };
  }
  if (!pairing || pairing.status !== "active") {
    return {
      ok: false,
      response: errorResponse(
        "PAIRING_REQUIRED",
        "A partner pairing is required to play a quiz.",
        statusForErrorCode("PAIRING_REQUIRED"),
      ),
    };
  }

  return {
    ok: true,
    value: {
      actor,
      pairingId: pairing.id,
      members: [pairing.member_a, pairing.member_b],
    },
  };
}

async function loadState(
  session: string,
  ctx: PairingContext,
): Promise<
  | { ok: true; state: QuizSessionState; questions: readonly QuizQuestion[] }
  | { ok: false; response: Response }
> {
  const db = serviceClient();
  const { data: sessionData, error: sessionError } = await db
    .from("quiz_sessions")
    .select("id, pairing_id, quiz_id, phase, scores")
    .eq("id", session)
    .maybeSingle();
  if (sessionError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load the quiz session.",
        500,
      ),
    };
  }
  const row = sessionData as SessionRow | null;
  // Do not disclose a session id from a different pairing.
  if (!row || row.pairing_id !== ctx.pairingId) {
    return {
      ok: false,
      response: errorResponse(
        "SESSION_NOT_FOUND",
        "No quiz session exists for the supplied id.",
        statusForErrorCode("SESSION_NOT_FOUND"),
      ),
    };
  }

  const [
    { data: questionRows, error: questionError },
    { data: selfRows, error: selfError },
    { data: guessRows, error: guessError },
  ] = await Promise.all([
    db.from("quiz_questions").select("id, quiz_id, type, prompt, choices").eq(
      "quiz_id",
      row.quiz_id,
    ),
    db.from("quiz_self_answers").select("account_id, question_id, answer").eq(
      "session_id",
      row.id,
    ),
    db.from("quiz_guesses").select("account_id, question_id, guess").eq(
      "session_id",
      row.id,
    ),
  ]);
  if (questionError || selfError || guessError) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "Failed to load quiz state.",
        500,
      ),
    };
  }

  const questions = (questionRows ?? []).flatMap((raw) => {
    const question = asQuestion(raw as Record<string, unknown>);
    return question === null ? [] : [question];
  });
  // A malformed catalog must fail closed. A valid quiz always has questions,
  // and treating unreadable rows as absent could advance a phase incorrectly.
  if (
    questions.length !== (questionRows ?? []).length || questions.length === 0
  ) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "The quiz catalog is invalid.",
        500,
      ),
    };
  }

  const selfAnswers = (selfRows as AnswerRow[] ?? []).flatMap((answer) =>
    isAnswer(answer.answer)
      ? [{
        sessionId: sessionId(row.id),
        accountId: accountId(answer.account_id),
        questionId: questionId(answer.question_id),
        answer: answer.answer,
      }]
      : []
  );
  const guesses = (guessRows as AnswerRow[] ?? []).flatMap((guess) =>
    isAnswer(guess.guess)
      ? [{
        sessionId: sessionId(row.id),
        accountId: accountId(guess.account_id),
        questionId: questionId(guess.question_id),
        guess: guess.guess,
      }]
      : []
  );
  if (
    selfAnswers.length !== (selfRows ?? []).length ||
    guesses.length !== (guessRows ?? []).length
  ) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL_ERROR",
        "The stored quiz state is invalid.",
        500,
      ),
    };
  }

  const quizSession: QuizSession = {
    id: sessionId(row.id),
    pairingId: pairingId(row.pairing_id),
    quizId: quizId(row.quiz_id),
    phase: row.phase,
    scores: asScores(row.scores, ctx.members),
  };
  return {
    ok: true,
    state: { session: quizSession, selfAnswers, guesses },
    questions,
  };
}

function sessionResponse(
  state: QuizSessionState,
  questions: readonly QuizQuestion[],
  viewer: string,
): Response {
  const view = buildQuizSessionView(state, accountId(viewer));
  return jsonResponse({
    session: view.session,
    selfAnswers: view.selfAnswers,
    guesses: view.guesses,
    ...(state.session.phase === "complete"
      ? { results: buildQuizResults(state, questions) }
      : {}),
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "quiz must be called with POST.",
      405,
    );
  }

  const actor = await authenticatedAccountId(req);
  if (!actor) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to play a quiz.",
      401,
    );
  }

  const db = serviceClient();
  const { data: registry, error: registryError } = await db
    .from("account_session")
    .select("epoch")
    .eq("account_id", actor)
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

  let body: Record<string, unknown>;
  try {
    const candidate = await req.json();
    if (!isRecord(candidate)) throw new Error("body must be an object");
    body = candidate;
  } catch {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A JSON request body is required.",
      400,
    );
  }
  const action = normalizeAction(body.action ?? body.operation);
  if (!action) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "An `action` of `start`, `self_answer`, or `guess` is required.",
      400,
      { fields: ["action"] },
    );
  }

  const pairing = await activePairing(actor);
  if (!pairing.ok) return pairing.response;

  if (action === "start") {
    const requestedQuiz = body.quizId;
    if (typeof requestedQuiz !== "string" || requestedQuiz.length === 0) {
      return errorResponse(
        "MISSING_REQUIRED_FIELD",
        "A `quizId` is required.",
        400,
        { fields: ["quizId"] },
      );
    }
    if (!isUuid(requestedQuiz)) {
      return errorResponse(
        "QUIZ_NOT_FOUND",
        "The requested quiz does not exist.",
        404,
      );
    }
    const { data: quiz, error: quizError } = await db
      .from("quiz_defs")
      .select("id")
      .eq("id", requestedQuiz)
      .maybeSingle();
    if (quizError) {
      return errorResponse("INTERNAL_ERROR", "Failed to load the quiz.", 500);
    }
    if (!quiz) {
      return errorResponse(
        "QUIZ_NOT_FOUND",
        "The requested quiz does not exist.",
        statusForErrorCode("QUIZ_NOT_FOUND"),
      );
    }

    const { count: questionCount, error: questionCountError } = await db
      .from("quiz_questions")
      .select("id", { count: "exact", head: true })
      .eq("quiz_id", requestedQuiz);
    if (questionCountError) {
      return errorResponse(
        "INTERNAL_ERROR",
        "Failed to load quiz questions.",
        500,
      );
    }
    if ((questionCount ?? 0) === 0) {
      return errorResponse(
        "QUIZ_NOT_FOUND",
        "The requested quiz does not contain any questions.",
        statusForErrorCode("QUIZ_NOT_FOUND"),
      );
    }

    // The shared initializer establishes the exact two-partner zero-score
    // shape. Postgres generates the actual id while holding its transaction.
    const id = crypto.randomUUID();
    const initial = createQuizSession({
      id: sessionId(id),
      pairingId: pairingId(pairing.value.pairingId),
      quizId: quizId(requestedQuiz),
      partners: [
        accountId(pairing.value.members[0]),
        accountId(pairing.value.members[1]),
      ],
    });

    const { data, error } = await db.rpc("quiz_start_session", {
      p_pairing: pairing.value.pairingId,
      p_actor: actor,
      p_quiz: requestedQuiz,
      p_now: new Date().toISOString(),
    });
    if (error) {
      return errorResponse(
        "INTERNAL_ERROR",
        "Failed to start the quiz session.",
        500,
      );
    }
    const committed = Array.isArray(data) ? data[0] : data;
    const resultCode = committed?.result_code ?? "INTERNAL_ERROR";
    if (resultCode !== "OK") {
      return errorResponse(
        resultCode,
        "The quiz session could not be started.",
        resultCode === "INTERNAL_ERROR" ? 500 : statusForErrorCode(resultCode),
      );
    }
    return jsonResponse({
      session: {
        id: committed.session_id,
        pairingId: pairing.value.pairingId,
        quizId: requestedQuiz,
        phase: committed.phase,
        scores: committed.scores ?? initial.session.scores,
      },
    }, 201);
  }

  const requestedSession = body.sessionId;
  const requestedQuestion = body.questionId;
  const submitted = action === "self_answer" ? body.answer : body.guess;
  if (
    typeof requestedSession !== "string" || requestedSession.length === 0 ||
    typeof requestedQuestion !== "string" || requestedQuestion.length === 0 ||
    submitted === undefined
  ) {
    return errorResponse(
      "MISSING_REQUIRED_FIELD",
      "A `sessionId`, `questionId`, and valid answer payload are required.",
      400,
      {
        fields: [
          "sessionId",
          "questionId",
          action === "self_answer" ? "answer" : "guess",
        ],
      },
    );
  }
  if (!isUuid(requestedSession)) {
    return errorResponse(
      "SESSION_NOT_FOUND",
      "No quiz session exists for the supplied id.",
      404,
    );
  }
  if (!isUuid(requestedQuestion)) {
    return errorResponse(
      "QUESTION_NOT_FOUND",
      "The question does not belong to this quiz.",
      404,
    );
  }
  if (!isAnswer(submitted)) {
    const code = action === "self_answer" ? "INVALID_ANSWER" : "INVALID_GUESS";
    return errorResponse(code, "The submitted answer payload is invalid.", 400);
  }

  const loaded = await loadState(requestedSession, pairing.value);
  if (!loaded.ok) return loaded.response;
  const transitioned = action === "self_answer"
    ? recordSelfAnswer(loaded.state, loaded.questions, {
      accountId: accountId(actor),
      questionId: questionId(requestedQuestion),
      answer: submitted,
    })
    : recordGuess(loaded.state, loaded.questions, {
      accountId: accountId(actor),
      questionId: questionId(requestedQuestion),
      guess: submitted,
    });
  if (!transitioned.ok) {
    return errorResponse(
      transitioned.error.code,
      transitioned.error.message,
      statusForErrorCode(transitioned.error.code),
    );
  }

  // The SQL functions take a row lock and re-run the phase gates from the
  // locked state. The pure result is pre-validation only: it is never used to
  // overwrite a concurrent submission. For guesses it supplies the matching
  // decision so SQL can atomically increment the *locked* current score.
  const next = transitioned.value;
  const matched = next.session.scores[accountId(actor)] >
    loaded.state.session.scores[accountId(actor)];
  const rpcName = action === "self_answer"
    ? "quiz_submit_self_answer"
    : "quiz_submit_guess";
  const { data, error } = await db.rpc(rpcName, {
    p_session: requestedSession,
    p_actor: actor,
    p_question: requestedQuestion,
    ...(action === "self_answer"
      ? { p_answer: submitted }
      : { p_guess: submitted, p_matched: matched }),
    p_now: new Date().toISOString(),
  });
  if (error) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to commit the quiz submission.",
      500,
    );
  }
  const committed = Array.isArray(data) ? data[0] : data;
  const resultCode = committed?.result_code ?? "INTERNAL_ERROR";
  if (resultCode !== "OK") {
    return errorResponse(
      resultCode,
      "The quiz submission could not be applied.",
      resultCode === "INTERNAL_ERROR" ? 500 : statusForErrorCode(resultCode),
    );
  }

  // A partner can submit between our read and the SQL lock. Reloading ensures
  // the caller receives the actual committed phase, score, and result view.
  const committedState = await loadState(
    committed.session_id ?? requestedSession,
    pairing.value,
  );
  if (!committedState.ok) return committedState.response;
  return sessionResponse(
    committedState.state,
    committedState.questions,
    actor,
  );
});
