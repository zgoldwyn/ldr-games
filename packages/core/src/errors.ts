/**
 * Stable, machine-readable error vocabulary for the LDR Companion App.
 *
 * Error codes are the contract between the domain core, the Edge Functions, and
 * the platform shells: they are stable string literals (never localized text) so
 * they can be matched on programmatically and mapped to user-facing copy per
 * platform. Each code traces back to one or more acceptance criteria.
 *
 * The codes are grouped into per-domain string-literal unions; {@link ErrorCode}
 * is the union of all of them. The {@link AppError} envelope pairs a code with a
 * human-readable message and optional structured `details` (for example, the set
 * of unmet password criteria). Domain-specific error aliases (`RegistrationError`,
 * `AuthError`, …) constrain the code to that domain's subset.
 */

// ---------------------------------------------------------------------------
// Per-domain error-code unions
// ---------------------------------------------------------------------------

/** Registration failures (Requirement 1). */
export type RegistrationErrorCode =
  | 'EMAIL_ALREADY_REGISTERED' // 1.2 email already associated with an account
  | 'INVALID_EMAIL_FORMAT' // 1.4 syntactically invalid email
  | 'INVALID_PASSWORD' // 1.3 password fails length/character-class policy
  | 'MISSING_REQUIRED_FIELD'; // 1.5 email or password empty/absent

/** Authentication and session failures (Requirement 2). */
export type AuthErrorCode =
  | 'AUTH_FAILED' // 2.2 uniform failure that does not reveal which field was wrong
  | 'ACCOUNT_LOCKED' // 2.3 temporarily locked after 5 failures in 15 minutes
  | 'MISSING_REQUIRED_FIELD'; // credentials empty/absent

/** Failures reading or validating the current session (Requirement 2). */
export type SessionErrorCode =
  | 'UNAUTHENTICATED' // 2.5 no valid session -> route to sign-in
  | 'SESSION_EXPIRED' // 2.6 inactivity expiry (30 days)
  | 'SESSION_SUPERSEDED'; // 2.7-2.9 a newer login displaced this session (stale epoch)

/** Pairing lifecycle failures (Requirements 3 and 4). */
export type PairingErrorCode =
  | 'ALREADY_PAIRED' // 3.3, 3.4, 3.7 invite/accept from or targeting a paired account
  | 'INVITATION_NOT_FOUND' // unknown invitation code
  | 'INVITATION_EXPIRED' // 3.5 accepted after the 72h window
  | 'INVITATION_ALREADY_CONSUMED' // 3.8 single-use invitation reused
  | 'NOT_PAIRED'; // unlink requested while not in a pairing

/** Synchronization / conflict-resolution failures (Requirement 5). */
export type SyncErrorCode =
  | 'STALE_WRITE' // 5.5 a stale offline write lost last-write-wins to a newer value
  | 'UNKNOWN_ITEM_TYPE'; // unrecognized shared-item type

/** Real-time game failures (Requirement 6). */
export type RTErrorCode =
  | 'PAIRING_REQUIRED' // 6.5 cannot start without a partner
  | 'SESSION_NOT_FOUND'
  | 'INVALID_MOVE' // 6.11 invalid move, state unchanged
  | 'JOIN_WINDOW_EXPIRED' // 6.9 partner did not join within 60s
  | 'REJOIN_WINDOW_EXPIRED' // 6.10 no rejoin within 5 minutes
  | 'INVALID_SESSION_STATE'; // action not allowed in the current session state

/** Asynchronous game failures (Requirement 7). */
export type AsyncErrorCode =
  | 'PAIRING_REQUIRED' // 7.9 cannot start without a partner
  | 'SESSION_NOT_FOUND'
  | 'NOT_YOUR_TURN' // 7.7 non-holder attempted a turn
  | 'INVALID_TURN' // 7.8 holder attempted an invalid turn
  | 'INVALID_SESSION_STATE'; // turn attempted on a terminal session

/** Quiz failures (Requirement 8). */
export type QuizErrorCode =
  | 'PAIRING_REQUIRED' // 8.10 cannot start without a partner
  | 'QUIZ_NOT_FOUND'
  | 'QUIZ_SESSION_IN_PROGRESS' // 8.11 one active session per pairing
  | 'SESSION_NOT_FOUND'
  | 'QUESTION_NOT_FOUND'
  | 'INVALID_ANSWER' // 8.3, 8.12 self-answer invalid
  | 'ALREADY_ANSWERED' // 8.12 question already self-answered
  | 'INVALID_GUESS' // 8.13 guess invalid
  | 'ALREADY_GUESSED' // 8.13 question already guessed
  | 'WRONG_PHASE'; // 8.13 guess submitted outside the guessing phase

/** Relationship-date (calendar) failures (Requirement 9). */
export type CalendarErrorCode =
  | 'INVALID_TITLE' // 9.4 missing/empty/whitespace/too-long title
  | 'INVALID_DATE' // 9.5 missing or invalid calendar date
  | 'DATE_NOT_FOUND'; // 9.6 edit/delete of a non-existent date

/** Reminder failures (Requirement 10). */
export type ReminderErrorCode =
  | 'INVALID_LEAD_TIME' // 10.2 lead time out of range or not in the future
  | 'DATE_NOT_FOUND'; // reminder set on a non-existent date

/** Notification failures (Requirement 11). */
export type NotificationErrorCode = 'NOTIFICATION_NOT_FOUND';

/** Account deletion failures (Requirement 12). */
export type AccountDeletionErrorCode = 'INVALID_DELETION_STATE';

/** Reject reason for the pure real-time move engine (Requirement 6.11). */
export type MoveErrorCode = 'INVALID_MOVE';

/** Reject reasons for the pure asynchronous turn engine (Requirements 7.7, 7.8). */
export type TurnErrorCode = 'NOT_YOUR_TURN' | 'INVALID_TURN';

/**
 * Every error code in the system. This is the exhaustive, stable set of
 * machine-readable failure identifiers.
 */
export type ErrorCode =
  | RegistrationErrorCode
  | AuthErrorCode
  | SessionErrorCode
  | PairingErrorCode
  | SyncErrorCode
  | RTErrorCode
  | AsyncErrorCode
  | QuizErrorCode
  | CalendarErrorCode
  | ReminderErrorCode
  | NotificationErrorCode
  | AccountDeletionErrorCode
  | MoveErrorCode
  | TurnErrorCode;

// ---------------------------------------------------------------------------
// Error envelope and domain-specific aliases
// ---------------------------------------------------------------------------

/**
 * The structured error envelope returned in the `Err` branch of a `Result`.
 * `code` is the stable machine-readable identifier; `message` is a
 * developer-facing description; `details` optionally carries structured context
 * (for example `{ unmetCriteria: [...] }` for `INVALID_PASSWORD`, or
 * `{ fields: ['email'] }` for `MISSING_REQUIRED_FIELD`).
 */
export interface AppError<C extends ErrorCode = ErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RegistrationError = AppError<RegistrationErrorCode>;
export type AuthError = AppError<AuthErrorCode>;
export type SessionError = AppError<SessionErrorCode>;
export type PairingError = AppError<PairingErrorCode>;
export type SyncError = AppError<SyncErrorCode>;
export type RTError = AppError<RTErrorCode>;
export type AsyncError = AppError<AsyncErrorCode>;
export type QuizError = AppError<QuizErrorCode>;
export type CalendarError = AppError<CalendarErrorCode>;
export type ReminderError = AppError<ReminderErrorCode>;
export type NotificationError = AppError<NotificationErrorCode>;
export type AccountDeletionError = AppError<AccountDeletionErrorCode>;
export type MoveError = AppError<MoveErrorCode>;
export type TurnError = AppError<TurnErrorCode>;

/**
 * Runtime lookup of every error code, keyed by its own name. Use this to
 * reference codes symbolically (`ERROR_CODES.ALREADY_PAIRED`) instead of
 * scattering raw string literals. The `satisfies` clause guarantees each value
 * is a member of {@link ErrorCode}, so the runtime table can never drift from
 * the type-level union.
 */
export const ERROR_CODES = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_EMAIL_FORMAT: 'INVALID_EMAIL_FORMAT',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  AUTH_FAILED: 'AUTH_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_SUPERSEDED: 'SESSION_SUPERSEDED',
  ALREADY_PAIRED: 'ALREADY_PAIRED',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_ALREADY_CONSUMED: 'INVITATION_ALREADY_CONSUMED',
  NOT_PAIRED: 'NOT_PAIRED',
  STALE_WRITE: 'STALE_WRITE',
  UNKNOWN_ITEM_TYPE: 'UNKNOWN_ITEM_TYPE',
  PAIRING_REQUIRED: 'PAIRING_REQUIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_MOVE: 'INVALID_MOVE',
  JOIN_WINDOW_EXPIRED: 'JOIN_WINDOW_EXPIRED',
  REJOIN_WINDOW_EXPIRED: 'REJOIN_WINDOW_EXPIRED',
  INVALID_SESSION_STATE: 'INVALID_SESSION_STATE',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_TURN: 'INVALID_TURN',
  QUIZ_SESSION_IN_PROGRESS: 'QUIZ_SESSION_IN_PROGRESS',
  QUIZ_NOT_FOUND: 'QUIZ_NOT_FOUND',
  QUESTION_NOT_FOUND: 'QUESTION_NOT_FOUND',
  INVALID_ANSWER: 'INVALID_ANSWER',
  ALREADY_ANSWERED: 'ALREADY_ANSWERED',
  INVALID_GUESS: 'INVALID_GUESS',
  ALREADY_GUESSED: 'ALREADY_GUESSED',
  WRONG_PHASE: 'WRONG_PHASE',
  INVALID_TITLE: 'INVALID_TITLE',
  INVALID_DATE: 'INVALID_DATE',
  DATE_NOT_FOUND: 'DATE_NOT_FOUND',
  INVALID_LEAD_TIME: 'INVALID_LEAD_TIME',
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  INVALID_DELETION_STATE: 'INVALID_DELETION_STATE',
} as const satisfies Record<string, ErrorCode>;
