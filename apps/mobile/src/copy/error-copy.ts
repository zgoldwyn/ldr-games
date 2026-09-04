import { ERROR_CODES, PASSWORD_MIN_LENGTH } from '@ldr/core';
import type { AppError, PasswordCriterion } from '@ldr/core';

const CRITERION_COPY: Record<PasswordCriterion, string> = {
  length: `at least ${PASSWORD_MIN_LENGTH} characters`,
  uppercase: 'an uppercase letter',
  lowercase: 'a lowercase letter',
  digit: 'a number',
  nonAlphanumeric: 'a symbol',
};

function unmetCopy(details: AppError['details']): string | null {
  const unmet = details?.unmetCriteria;
  if (!Array.isArray(unmet) || unmet.length === 0) return null;
  const parts = unmet
    .filter((item): item is PasswordCriterion => item in CRITERION_COPY)
    .map((item) => CRITERION_COPY[item]);
  if (parts.length === 0) return null;
  return `Use ${parts.join(', ')}.`;
}

/**
 * Map a machine-readable error onto user-facing copy.
 *
 * AUTH_FAILED is a fixed sentence on purpose (Req 2.2): the server message must
 * not leak whether the email or the password was wrong.
 */
export function messageForError(error: AppError): string {
  switch (error.code) {
    case ERROR_CODES.AUTH_FAILED:
      return 'Invalid email or password.';
    case ERROR_CODES.ACCOUNT_LOCKED:
      return 'Too many sign-in attempts. Try again in a few minutes.';
    case ERROR_CODES.EMAIL_ALREADY_REGISTERED:
      return 'That email already has an account. Sign in instead.';
    case ERROR_CODES.INVALID_EMAIL_FORMAT:
      return 'That does not look like an email address.';
    case ERROR_CODES.INVALID_PASSWORD:
      return unmetCopy(error.details) ?? 'The password does not meet the required policy.';
    case ERROR_CODES.MISSING_REQUIRED_FIELD:
      return 'Email and password are both needed.';
    case ERROR_CODES.UNAUTHENTICATED:
    case ERROR_CODES.SESSION_EXPIRED:
    case ERROR_CODES.SESSION_SUPERSEDED:
      return 'Please sign in again.';
    case ERROR_CODES.ALREADY_PAIRED:
      return 'This account is already paired.';
    case ERROR_CODES.INVITATION_NOT_FOUND:
      return 'That invitation code was not found.';
    case ERROR_CODES.INVITATION_EXPIRED:
      return 'That invitation has expired. Ask your partner for a new one.';
    case ERROR_CODES.INVITATION_ALREADY_CONSUMED:
      return 'That invitation has already been used.';
    case ERROR_CODES.NOT_PAIRED:
      return 'You are not paired yet.';
    case ERROR_CODES.PAIRING_REQUIRED:
      return 'Pair with your partner before starting a game.';
    case ERROR_CODES.SESSION_NOT_FOUND:
      return 'That game could not be found.';
    case ERROR_CODES.INVALID_MOVE:
      return 'That move is not allowed.';
    case ERROR_CODES.NOT_YOUR_TURN:
      return 'It is not your turn.';
    case ERROR_CODES.INVALID_TURN:
      return 'That turn is not allowed.';
    case ERROR_CODES.JOIN_WINDOW_EXPIRED:
      return 'The invite expired before your partner joined.';
    case ERROR_CODES.REJOIN_WINDOW_EXPIRED:
      return 'The pause window ended, so this game closed.';
    case ERROR_CODES.INVALID_SESSION_STATE:
      return 'This game cannot take that action right now.';
    default:
      return error.message;
  }
}
