import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { PasswordCriterion } from './account.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePasswordPolicy,
} from './auth-validation.js';

// Feature: ldr-companion-app, Property 1: Password policy reports every unmet criterion
//
// For any password string, `validatePasswordPolicy` accepts it if and only if
// it is 12-128 characters and contains at least one uppercase letter, one
// lowercase letter, one digit, and one non-alphanumeric character; when
// rejected, the set of reported unmet criteria equals exactly the set of
// criteria the password actually violates.
//
// The test derives the expected set of violated criteria independently from the
// acceptance criteria (a separate oracle), then asserts (a) `valid` is true iff
// nothing is violated and (b) the reported unmet set equals the violated set.
//
// Validates: Requirements 1.1, 1.3, 1.5

/** The five criteria, in a canonical order used only for set comparison. */
const ALL_CRITERIA: readonly PasswordCriterion[] = [
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'nonAlphanumeric',
];

/**
 * Independent oracle: compute exactly the criteria a password violates, derived
 * straight from the acceptance criteria (Requirements 1.1, 1.3, 1.5). A missing
 * / empty password violates every criterion (Requirement 1.5).
 */
function violatedCriteria(value: string): Set<PasswordCriterion> {
  const violated = new Set<PasswordCriterion>();
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    violated.add('length');
  }
  if (!/[A-Z]/.test(value)) violated.add('uppercase');
  if (!/[a-z]/.test(value)) violated.add('lowercase');
  if (!/[0-9]/.test(value)) violated.add('digit');
  if (!/[^A-Za-z0-9]/.test(value)) violated.add('nonAlphanumeric');
  return violated;
}

/** Sort a criteria collection into canonical order for order-independent equality. */
const asSortedSet = (criteria: Iterable<PasswordCriterion>): PasswordCriterion[] =>
  ALL_CRITERIA.filter((c) => new Set(criteria).has(c));

// A character pool that spans every policy category plus letters/digits/symbols
// and whitespace, so generated passwords land in all combinations of met/unmet
// criteria rather than trivially satisfying (or failing) the same ones.
const CHAR_POOL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{};:,.<>/?`~| \t'.split(
    '',
  );

const poolChar = fc.constantFrom(...CHAR_POOL);

/** Build a password of an exact length from the pool (used for boundary probing). */
const exactLength = (n: number) =>
  fc.array(poolChar, { minLength: n, maxLength: n }).map((chars) => chars.join(''));

// Boundary lengths mandated by the task: 11 (just below min), 12 (min),
// 128 (max), 129 (just above max). These pin down the inclusive 12-128 window.
const boundaryPassword = fc.oneof(exactLength(11), exactLength(12), exactLength(128), exactLength(129));

// General coverage: arbitrary-length strings from the pool, including the empty
// string, spanning the whole 0..140 range so both the min and max edges are hit.
const generalPassword = fc
  .array(poolChar, { minLength: 0, maxLength: 140 })
  .map((chars) => chars.join(''));

// Also fold in fully arbitrary unicode strings so the property is not limited to
// the curated pool (e.g. astral characters, control chars, non-ASCII letters).
const arbitraryPassword = fc.oneof(boundaryPassword, generalPassword, fc.string({ maxLength: 140 }));

describe('validatePasswordPolicy (Property 1: Password policy reports every unmet criterion)', () => {
  // Feature: ldr-companion-app, Property 1: Password policy reports every unmet criterion
  it('is valid iff no criterion is violated, and reports exactly the violated criteria', () => {
    fc.assert(
      fc.property(arbitraryPassword, (password) => {
        const expected = violatedCriteria(password);
        const result = validatePasswordPolicy(password);

        // valid iff nothing is violated.
        expect(result.valid).toBe(expected.size === 0);
        // The reported unmet set equals exactly the violated set.
        expect(asSortedSet(result.unmetCriteria)).toEqual(asSortedSet(expected));
        // A valid result reports no unmet criteria.
        expect(result.unmetCriteria.length === 0).toBe(result.valid);
      }),
      { numRuns: 500 },
    );
  });

  // Feature: ldr-companion-app, Property 1: Password policy reports every unmet criterion
  it('treats the 12-128 length window as inclusive at the 11/12/128/129 boundaries', () => {
    fc.assert(
      fc.property(boundaryPassword, (password) => {
        const lengthViolated = validatePasswordPolicy(password).unmetCriteria.includes('length');
        const outsideWindow =
          password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH;
        expect(lengthViolated).toBe(outsideWindow);
      }),
      { numRuns: 200 },
    );
  });
});
