import type { AccountId, Answer, QuizQuestion, QuizSessionSnapshot } from '@ldr/core';

export function nextQuizQuestion(
  questions: readonly QuizQuestion[],
  snapshot: QuizSessionSnapshot,
  self: AccountId,
): QuizQuestion | null {
  if (snapshot.session.phase === 'complete') return null;
  const completed =
    snapshot.session.phase === 'self_answer'
      ? snapshot.selfAnswers.filter((answer) => answer.accountId === self)
      : snapshot.guesses.filter((guess) => guess.accountId === self);
  return (
    questions.find((question) => !completed.some((entry) => entry.questionId === question.id)) ??
    null
  );
}

export function quizProgress(
  questions: readonly QuizQuestion[],
  snapshot: QuizSessionSnapshot,
  self: AccountId,
): { readonly completed: number; readonly total: number } {
  const entries =
    snapshot.session.phase === 'self_answer'
      ? snapshot.selfAnswers.filter((answer) => answer.accountId === self)
      : snapshot.guesses.filter((guess) => guess.accountId === self);
  return { completed: entries.length, total: questions.length };
}

/** Questions still open to this player. A partially sent round can resume safely. */
export function editableQuizQuestions(
  questions: readonly QuizQuestion[],
  snapshot: QuizSessionSnapshot,
  self: AccountId,
): readonly QuizQuestion[] {
  if (snapshot.session.phase === 'complete') return [];
  const submitted =
    snapshot.session.phase === 'self_answer' ? snapshot.selfAnswers : snapshot.guesses;
  const answered = new Set(
    submitted.filter((entry) => entry.accountId === self).map((entry) => entry.questionId),
  );
  return questions.filter((question) => !answered.has(question.id));
}

/** A round may be submitted only after every remaining question has a draft. */
export function quizDraftComplete(
  questions: readonly QuizQuestion[],
  drafts: Readonly<Record<string, string>>,
): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => {
      const value = drafts[question.id]?.trim();
      return value !== undefined && value.length > 0;
    })
  );
}

export function answerForQuestion(
  snapshot: QuizSessionSnapshot,
  account: AccountId,
  questionId: QuizQuestion['id'],
): Answer | null {
  return (
    snapshot.selfAnswers.find(
      (answer) => answer.accountId === account && answer.questionId === questionId,
    )?.answer ?? null
  );
}

export function answerLabel(answer: Answer | null): string {
  return answer?.value ?? 'No answer';
}
