/**
 * Pure credential-validation helpers shared by the client and the registration
 * Edge Function (Requirements 1.1, 1.3, 1.4, 1.5).
 *
 * These functions are deterministic and side-effect free so they can be reused
 * on both the client (for immediate feedback) and the server (as the
 * authoritative re-validation before an account is created). They perform only
 * syntactic policy checks — email uniqueness (1.2) and password hashing (1.6)
 * are enforced elsewhere by Supabase Auth.
 */
import type { PasswordCriterion, PasswordValidation } from './account.js';

/** Minimum allowed password length, inclusive (Requirement 1.1/1.3). */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum allowed password length, inclusive (Requirement 1.1/1.3). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The password-policy criteria in a stable, deterministic reporting order.
 * `validatePasswordPolicy` reports unmet criteria in exactly this order so the
 * output is predictable for callers and tests.
 */
const PASSWORD_CRITERIA_ORDER: readonly PasswordCriterion[] = [
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'nonAlphanumeric',
];

/** True when `value` contains at least one ASCII uppercase letter. */
const hasUppercase = (value: string): boolean => /[A-Z]/.test(value);
/** True when `value` contains at least one ASCII lowercase letter. */
const hasLowercase = (value: string): boolean => /[a-z]/.test(value);
/** True when `value` contains at least one digit. */
const hasDigit = (value: string): boolean => /[0-9]/.test(value);
/**
 * True when `value` contains at least one non-alphanumeric character, i.e. any
 * character that is not an ASCII letter or digit (punctuation, symbols, or
 * whitespace all qualify).
 */
const hasNonAlphanumeric = (value: string): boolean => /[^A-Za-z0-9]/.test(value);

/**
 * Evaluate a password against the registration policy: 12-128 characters with
 * at least one uppercase letter, one lowercase letter, one digit, and one
 * non-alphanumeric character (Requirements 1.1, 1.3).
 *
 * Every unmet criterion is reported in {@link PasswordValidation.unmetCriteria},
 * in the stable order length → uppercase → lowercase → digit → nonAlphanumeric,
 * so the caller can describe each failing rule (Requirement 1.3). A missing or
 * empty password (Requirement 1.5) fails every criterion; the registration
 * layer maps that missing-field case to its own error while this helper still
 * returns a well-formed, invalid result.
 *
 * @param password - The candidate password. Non-string or absent input is
 *   treated as an empty password (all criteria unmet).
 * @returns A {@link PasswordValidation} whose `valid` flag is true only when
 *   `unmetCriteria` is empty.
 */
export function validatePasswordPolicy(password: string): PasswordValidation {
  const value = typeof password === 'string' ? password : '';

  const met: Record<PasswordCriterion, boolean> = {
    length: value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH,
    uppercase: hasUppercase(value),
    lowercase: hasLowercase(value),
    digit: hasDigit(value),
    nonAlphanumeric: hasNonAlphanumeric(value),
  };

  const unmetCriteria = PASSWORD_CRITERIA_ORDER.filter((criterion) => !met[criterion]);

  return {
    valid: unmetCriteria.length === 0,
    unmetCriteria,
  };
}

/** Maximum total email length permitted (RFC 5321 addr-spec limit). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A pragmatic, RFC-5322-inspired email pattern: a dot-atom local part, a single
 * `@`, and a domain of one or more dot-separated labels ending in a valid label
 * (so the domain must contain at least one dot). Labels are 1-63 characters,
 * may contain hyphens internally but not at their boundaries, and leading or
 * trailing whitespace is not permitted.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Check whether `email` is in a syntactically valid email format
 * (Requirement 1.4). Rejects missing/empty input, addresses longer than
 * {@link EMAIL_MAX_LENGTH}, and anything not matching {@link EMAIL_PATTERN}
 * (missing `@`, missing domain dot, consecutive dots, surrounding whitespace,
 * and similar malformations).
 *
 * @param email - The candidate email address.
 * @returns `true` when the address is well-formed, `false` otherwise.
 */
export function validateEmailFormat(email: string): boolean {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_MAX_LENGTH) {
    return false;
  }
  // Reject consecutive dots anywhere (e.g. "a..b@x.com" or "a@x..com").
  if (email.includes('..')) {
    return false;
  }
  return EMAIL_PATTERN.test(email);
}
