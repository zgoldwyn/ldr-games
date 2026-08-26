// Feature: ldr-companion-app, Property 32: Each quiz question belongs to exactly one quiz
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { questionId, quizId } from './common.js';
import type { QuizDef, QuizQuestion } from './quiz.js';
import {
  findQuizCatalogViolations,
  isQuizCatalogValid,
  type QuizCatalog,
} from './quiz-session.js';

/**
 * Property 32 (task 7.9) — Each quiz question belongs to exactly one quiz
 * (Requirement 8.9).
 *
 * For any quiz question in the catalog it must appear in the question set of
 * exactly one quiz and no other. This exercises the pure catalog-integrity
 * check {@link findQuizCatalogViolations} / {@link isQuizCatalogValid}.
 *
 * The generator builds a *well-formed* catalog (every question assigned to
 * exactly one owning quiz, with a matching `quizId` back-reference) and then
 * optionally injects a single, known integrity violation:
 * - `share`  — a question is additionally listed by a second quiz (belongs to
 *   two quizzes), or
 * - `orphan` — a question is dropped from its owning quiz's list (belongs to
 *   no quiz).
 *
 * The property asserts the check agrees with the construction: a well-formed
 * catalog is valid with no violations, and an injected violation is detected
 * and correctly attributed to the offending question.
 */

/** A well-formed catalog plus a description of any injected violation. */
interface CatalogPlan {
  readonly catalog: QuizCatalog;
  /** The mutation applied to the well-formed baseline. */
  readonly mutation: 'none' | 'share' | 'orphan';
  /** The question id the mutation targets (for `share`/`orphan`). */
  readonly targetQuestion?: string;
  /** For `share`: the extra quiz id that now also claims the question. */
  readonly extraQuizId?: string;
}

const catalogPlanArb: fc.Arbitrary<CatalogPlan> = fc
  .record({
    quizCount: fc.integer({ min: 1, max: 4 }),
    // One owning-quiz index per question; length drives the question count.
    owners: fc.array(fc.nat({ max: 3 }), { minLength: 0, maxLength: 12 }),
    mutation: fc.constantFrom('none', 'share', 'orphan'),
    // Selectors resolved against the generated sizes below.
    targetSel: fc.nat({ max: 1000 }),
    extraQuizSel: fc.nat({ max: 1000 }),
  })
  .map(({ quizCount, owners, mutation, targetSel, extraQuizSel }) => {
    const quizIdStr = (i: number): string => `quiz-${i}`;
    const questionIdStr = (i: number): string => `q-${i}`;

    // Clamp each owner index into the valid quiz range.
    const ownerOf = owners.map((o) => o % quizCount);
    const questionCount = ownerOf.length;

    // Well-formed baseline: quiz.questionIds lists exactly its owned questions,
    // and each question's quizId back-reference names that owner.
    const quizQuestionIds: string[][] = Array.from({ length: quizCount }, () => []);
    for (let qi = 0; qi < questionCount; qi++) {
      quizQuestionIds[ownerOf[qi]].push(questionIdStr(qi));
    }

    const quizzes: QuizDef[] = Array.from({ length: quizCount }, (_unused, i) => ({
      id: quizId(quizIdStr(i)),
      theme: `theme-${i}`,
      questionIds: quizQuestionIds[i].map((s) => questionId(s)),
    }));
    const questions: QuizQuestion[] = Array.from({ length: questionCount }, (_unused, qi) => ({
      id: questionId(questionIdStr(qi)),
      quizId: quizId(quizIdStr(ownerOf[qi])),
      type: 'short_answer',
      prompt: `prompt-${qi}`,
    }));

    const baseline: CatalogPlan = {
      catalog: { quizzes, questions },
      mutation: 'none',
    };

    // `share` requires >=2 quizzes and >=1 question so we can add a second
    // claimant; `orphan` just requires >=1 question. Fall back to `none` when
    // the precondition is not met so every generated case is meaningful.
    if (questionCount === 0) return baseline;

    const targetIdx = targetSel % questionCount;
    const targetQ = questionIdStr(targetIdx);
    const owner = ownerOf[targetIdx];

    if (mutation === 'orphan') {
      const mutatedQuizzes = quizzes.map((quiz, i) =>
        i === owner
          ? { ...quiz, questionIds: quiz.questionIds.filter((qid) => qid !== questionId(targetQ)) }
          : quiz,
      );
      return {
        catalog: { quizzes: mutatedQuizzes, questions },
        mutation: 'orphan',
        targetQuestion: targetQ,
      };
    }

    if (mutation === 'share' && quizCount >= 2) {
      // Pick a different quiz to also claim the target question.
      const extraIdx = (owner + 1 + (extraQuizSel % (quizCount - 1))) % quizCount;
      const mutatedQuizzes = quizzes.map((quiz, i) =>
        i === extraIdx
          ? { ...quiz, questionIds: [...quiz.questionIds, questionId(targetQ)] }
          : quiz,
      );
      return {
        catalog: { quizzes: mutatedQuizzes, questions },
        mutation: 'share',
        targetQuestion: targetQ,
        extraQuizId: quizIdStr(extraIdx),
      };
    }

    return baseline;
  });

describe('quiz catalog integrity (property)', () => {
  // Feature: ldr-companion-app, Property 32: Each quiz question belongs to exactly one quiz
  // Validates: Requirements 8.9
  it('is valid iff every question belongs to exactly one quiz, and pinpoints violations', () => {
    fc.assert(
      fc.property(catalogPlanArb, (plan) => {
        const violations = findQuizCatalogViolations(plan.catalog);

        if (plan.mutation === 'none') {
          // A well-formed catalog: each question belongs to exactly one quiz.
          expect(violations).toEqual([]);
          expect(isQuizCatalogValid(plan.catalog)).toBe(true);
          return;
        }

        // An injected violation must be detected and attributed to the target.
        expect(isQuizCatalogValid(plan.catalog)).toBe(false);
        const target = questionId(plan.targetQuestion!);
        const offending = violations.find((v) => v.questionId === target);
        expect(offending).toBeDefined();

        if (plan.mutation === 'orphan') {
          // Belongs to no quiz.
          expect(offending!.quizIds).toEqual([]);
        } else {
          // Shared: belongs to its owner plus the extra quiz (two quizzes).
          expect(offending!.quizIds).toHaveLength(2);
          expect(offending!.quizIds).toContain(quizId(plan.extraQuizId!));
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: ldr-companion-app, Property 32: Each quiz question belongs to exactly one quiz
  // Validates: Requirements 8.9
  it('reports every question that is not claimed by exactly one quiz', () => {
    fc.assert(
      fc.property(catalogPlanArb, (plan) => {
        const violations = findQuizCatalogViolations(plan.catalog);
        // Independently recompute, for each catalog question, how many distinct
        // quizzes list it; a violation is any count other than exactly one.
        for (const q of plan.catalog.questions) {
          const claimants = new Set(
            plan.catalog.quizzes
              .filter((quiz) => quiz.questionIds.includes(q.id))
              .map((quiz) => quiz.id),
          );
          const flagged = violations.some((v) => v.questionId === q.id);
          expect(flagged).toBe(claimants.size !== 1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
