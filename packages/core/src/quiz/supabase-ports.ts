/**
 * Authenticated Supabase adapter for {@link QuizPorts}.
 *
 * The client supplied here must be the caller's regular authenticated client,
 * never a service-role client. `fetchSession` intentionally reads the answer
 * rows directly under RLS, making the database's phase-based withholding rule
 * effective even if a shell is modified. All writes are delegated to `quiz`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { accountId, pairingId, questionId, quizId, sessionId } from '../domain/common.js';
import type {
  Answer,
  QuizDef,
  QuizGuess,
  QuizQuestion,
  QuizResults,
  QuizSelfAnswer,
  QuizSession,
} from '../domain/quiz.js';
import { buildQuizResults } from '../domain/quiz-session.js';
import { ERROR_CODES, type QuizErrorCode } from '../errors.js';
import { narrowCode, readErrorEnvelope } from '../supabase/function-error.js';
import type { QuizMutationOutcome, QuizPorts, QuizSessionSnapshot } from './quiz-module.js';

const QUIZ_CODES: readonly string[] = [
  ERROR_CODES.PAIRING_REQUIRED,
  ERROR_CODES.QUIZ_NOT_FOUND,
  ERROR_CODES.QUIZ_SESSION_IN_PROGRESS,
  ERROR_CODES.SESSION_NOT_FOUND,
  ERROR_CODES.QUESTION_NOT_FOUND,
  ERROR_CODES.INVALID_ANSWER,
  ERROR_CODES.ALREADY_ANSWERED,
  ERROR_CODES.INVALID_GUESS,
  ERROR_CODES.ALREADY_GUESSED,
  ERROR_CODES.WRONG_PHASE,
];

interface QuizSessionWire {
  readonly id: string;
  readonly pairingId: string;
  readonly quizId: string;
  readonly phase: QuizSession['phase'];
  readonly scores: unknown;
}

interface AnswerWire {
  readonly sessionId: string;
  readonly accountId: string;
  readonly questionId: string;
  readonly answer?: unknown;
  readonly guess?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAnswer(value: unknown): value is Answer {
  return (
    isRecord(value) &&
    (value.kind === 'choice' || value.kind === 'text') &&
    typeof value.value === 'string'
  );
}

function isPhase(value: unknown): value is QuizSession['phase'] {
  return value === 'self_answer' || value === 'guessing' || value === 'complete';
}

function asScores(value: unknown): QuizSession['scores'] | null {
  if (!isRecord(value) || !Object.values(value).every((score) => typeof score === 'number')) {
    return null;
  }
  return value as QuizSession['scores'];
}

function sessionFromWire(value: unknown): QuizSession | null {
  if (!isRecord(value)) return null;
  const {
    id,
    pairingId: pairingIdRaw,
    quizId: quizIdRaw,
    phase,
    scores,
  } = value as unknown as QuizSessionWire;
  const mappedScores = asScores(scores);
  if (
    typeof id !== 'string' ||
    typeof pairingIdRaw !== 'string' ||
    typeof quizIdRaw !== 'string' ||
    !isPhase(phase) ||
    mappedScores === null
  ) {
    return null;
  }
  return {
    id: sessionId(id),
    pairingId: pairingId(pairingIdRaw),
    quizId: quizId(quizIdRaw),
    phase,
    scores: mappedScores,
  };
}

function questionFromRow(value: unknown): QuizQuestion | null {
  if (!isRecord(value)) return null;
  const { id, quiz_id: quizIdRaw, type, prompt, choices } = value;
  if (typeof id !== 'string' || typeof quizIdRaw !== 'string' || typeof prompt !== 'string')
    return null;
  if (type === 'multiple_choice') {
    if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === 'string'))
      return null;
    return {
      id: questionId(id),
      quizId: quizId(quizIdRaw),
      type,
      prompt,
      choices,
    };
  }
  if (type !== 'short_answer' || choices !== null) return null;
  return { id: questionId(id), quizId: quizId(quizIdRaw), type, prompt };
}

function selfAnswerFromWire(value: unknown): QuizSelfAnswer | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as AnswerWire;
  if (
    typeof wire.sessionId !== 'string' ||
    typeof wire.accountId !== 'string' ||
    typeof wire.questionId !== 'string' ||
    !isAnswer(wire.answer)
  ) {
    return null;
  }
  return {
    sessionId: sessionId(wire.sessionId),
    accountId: accountId(wire.accountId),
    questionId: questionId(wire.questionId),
    answer: wire.answer,
  };
}

function guessFromWire(value: unknown): QuizGuess | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as AnswerWire;
  if (
    typeof wire.sessionId !== 'string' ||
    typeof wire.accountId !== 'string' ||
    typeof wire.questionId !== 'string' ||
    !isAnswer(wire.guess)
  ) {
    return null;
  }
  return {
    sessionId: sessionId(wire.sessionId),
    accountId: accountId(wire.accountId),
    questionId: questionId(wire.questionId),
    guess: wire.guess,
  };
}

function snapshotFromFunction(value: unknown): QuizSessionSnapshot | null {
  if (!isRecord(value)) return null;
  const session = sessionFromWire(value.session);
  if (session === null) return null;
  const selfAnswers = Array.isArray(value.selfAnswers)
    ? value.selfAnswers.map(selfAnswerFromWire)
    : [];
  const guesses = Array.isArray(value.guesses) ? value.guesses.map(guessFromWire) : [];
  if (selfAnswers.some((answer) => answer === null) || guesses.some((guess) => guess === null)) {
    return null;
  }
  const results = value.results as QuizResults | undefined;
  // The function only includes results for complete sessions. Reject a malformed
  // envelope rather than making a shell believe early answers are visible.
  if (session.phase !== 'complete' && results !== undefined) return null;
  return {
    session,
    selfAnswers: selfAnswers as QuizSelfAnswer[],
    guesses: guesses as QuizGuess[],
    ...(results === undefined ? {} : { results }),
  };
}

/** Build QuizPorts over a caller-scoped authenticated Supabase client. */
export function createSupabaseQuizPorts(client: SupabaseClient): QuizPorts {
  async function mutate(body: Record<string, unknown>): Promise<QuizMutationOutcome> {
    const { data, error } = await client.functions.invoke('quiz', { body });
    if (error) {
      const envelope = await readErrorEnvelope(error);
      return {
        ok: false,
        error: {
          code: narrowCode<QuizErrorCode>(
            envelope?.code,
            QUIZ_CODES,
            ERROR_CODES.SESSION_NOT_FOUND,
          ),
          message: envelope?.message ?? 'The quiz request failed.',
          ...(envelope?.details === undefined ? {} : { details: envelope.details }),
        },
      };
    }
    const snapshot = snapshotFromFunction(data);
    if (snapshot === null) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.SESSION_NOT_FOUND,
          message: 'The quiz server returned an invalid session view.',
        },
      };
    }
    return { ok: true, snapshot };
  }

  return {
    async listQuizzes(): Promise<readonly QuizDef[]> {
      const [{ data: quizRows, error: quizError }, { data: questionRows, error: questionError }] =
        await Promise.all([
          client.from('quiz_defs').select('id, theme'),
          client.from('quiz_questions').select('id, quiz_id, type, prompt, choices'),
        ]);
      if (quizError || questionError) return [];

      const questions = (questionRows ?? []).map(questionFromRow);
      if (questions.some((question) => question === null)) return [];
      const byQuiz = new Map<string, ReturnType<typeof questionId>[]>();
      for (const question of questions as QuizQuestion[]) {
        const ids = byQuiz.get(question.quizId) ?? [];
        ids.push(question.id);
        byQuiz.set(question.quizId, ids);
      }

      const quizzes: QuizDef[] = [];
      for (const row of quizRows ?? []) {
        const raw = row as { id?: unknown; theme?: unknown };
        if (typeof raw.id !== 'string' || typeof raw.theme !== 'string') return [];
        quizzes.push({
          id: quizId(raw.id),
          theme: raw.theme,
          questionIds: byQuiz.get(raw.id) ?? [],
        });
      }
      return quizzes;
    },

    async fetchSession(requestedSession): Promise<QuizSessionSnapshot | null> {
      const { data: sessionRow, error: sessionError } = await client
        .from('quiz_sessions')
        .select('id, pairing_id, quiz_id, phase, scores')
        .eq('id', requestedSession)
        .maybeSingle();
      if (sessionError || sessionRow === null) return null;

      const row = sessionRow as {
        id?: unknown;
        pairing_id?: unknown;
        quiz_id?: unknown;
        phase?: unknown;
        scores?: unknown;
      };
      const session = sessionFromWire({
        id: row.id,
        pairingId: row.pairing_id,
        quizId: row.quiz_id,
        phase: row.phase,
        scores: row.scores,
      });
      if (session === null) return null;

      const [questionsResult, selfResult, guessesResult] = await Promise.all([
        client
          .from('quiz_questions')
          .select('id, quiz_id, type, prompt, choices')
          .eq('quiz_id', session.quizId),
        client
          .from('quiz_self_answers')
          .select('session_id, account_id, question_id, answer')
          .eq('session_id', session.id),
        client
          .from('quiz_guesses')
          .select('session_id, account_id, question_id, guess')
          .eq('session_id', session.id),
      ]);
      if (questionsResult.error || selfResult.error || guessesResult.error) return null;

      const questions = (questionsResult.data ?? []).map(questionFromRow);
      const selfAnswers = (selfResult.data ?? []).map((raw) =>
        selfAnswerFromWire({
          sessionId: raw.session_id,
          accountId: raw.account_id,
          questionId: raw.question_id,
          answer: raw.answer,
        }),
      );
      const guesses = (guessesResult.data ?? []).map((raw) =>
        guessFromWire({
          sessionId: raw.session_id,
          accountId: raw.account_id,
          questionId: raw.question_id,
          guess: raw.guess,
        }),
      );
      if (
        questions.some((question) => question === null) ||
        selfAnswers.some((answer) => answer === null) ||
        guesses.some((guess) => guess === null)
      ) {
        return null;
      }

      const snapshot: QuizSessionSnapshot = {
        session,
        selfAnswers: selfAnswers as QuizSelfAnswer[],
        guesses: guesses as QuizGuess[],
      };
      return session.phase === 'complete'
        ? {
            ...snapshot,
            results: buildQuizResults(
              { session, selfAnswers: snapshot.selfAnswers, guesses: snapshot.guesses },
              questions as QuizQuestion[],
            ),
          }
        : snapshot;
    },

    startSession: (requestedQuiz) => mutate({ action: 'startSession', quizId: requestedQuiz }),
    submitSelfAnswer: (requestedSession, requestedQuestion, answer) =>
      mutate({
        action: 'submitSelfAnswer',
        sessionId: requestedSession,
        questionId: requestedQuestion,
        answer,
      }),
    submitGuess: (requestedSession, requestedQuestion, guess) =>
      mutate({
        action: 'submitGuess',
        sessionId: requestedSession,
        questionId: requestedQuestion,
        guess,
      }),
  };
}
