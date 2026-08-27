// Stable, machine-readable error vocabulary for the Edge Functions.
//
// Deno-compatible port of the registration-relevant subset of
// `packages/core/src/errors.ts`. Error codes are the contract between the
// domain core, the Edge Functions, and the platform shells: they are stable
// string literals (never localized text) so shells can match on them and map
// to user-facing copy. Each code traces back to one or more acceptance
// criteria. Keep in sync with the core vocabulary; later auth tasks extend this
// with the remaining `AuthErrorCode`/`SessionErrorCode` members.

/** Registration failures (Requirement 1). */
export type RegistrationErrorCode =
  | "EMAIL_ALREADY_REGISTERED" // 1.2 email already associated with an account
  | "INVALID_EMAIL_FORMAT" // 1.4 syntactically invalid email
  | "INVALID_PASSWORD" // 1.3 password fails length/character-class policy
  | "MISSING_REQUIRED_FIELD"; // 1.5 email or password empty/absent

/** Authentication and lockout failures (Requirement 2). */
export type AuthErrorCode =
  | "AUTH_FAILED" // 2.2 uniform failure that does not reveal which field was wrong
  | "ACCOUNT_LOCKED" // 2.3 temporarily locked after 5 failures in 15 minutes
  | "MISSING_REQUIRED_FIELD"; // credentials empty/absent

/** Failures reading or validating the current session (Requirement 2). */
export type SessionErrorCode =
  | "UNAUTHENTICATED" // 2.5 no valid session -> route to sign-in
  | "SESSION_EXPIRED" // 2.6 inactivity expiry (30 days)
  | "SESSION_SUPERSEDED"; // 2.7-2.9 a newer login displaced this session

/**
 * The structured error envelope returned in the `error` field of a failed
 * response. `code` is the stable machine-readable identifier; `message` is a
 * developer-facing description; `details` optionally carries structured context
 * (for example `{ unmetCriteria: [...] }` for `INVALID_PASSWORD`, or
 * `{ fields: ['email'] }` for `MISSING_REQUIRED_FIELD`).
 */
export interface AppError<C extends string = string> {
  readonly code: C;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RegistrationError = AppError<RegistrationErrorCode>;
export type AuthError = AppError<AuthErrorCode>;
export type SessionError = AppError<SessionErrorCode>;

/** Symbolic lookup so callers avoid scattering raw string literals. */
export const REGISTRATION_ERROR_CODES = {
  EMAIL_ALREADY_REGISTERED: "EMAIL_ALREADY_REGISTERED",
  INVALID_EMAIL_FORMAT: "INVALID_EMAIL_FORMAT",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
} as const satisfies Record<string, RegistrationErrorCode>;

/** Symbolic lookup for auth/session error codes (Requirement 2). */
export const AUTH_ERROR_CODES = {
  AUTH_FAILED: "AUTH_FAILED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_SUPERSEDED: "SESSION_SUPERSEDED",
} as const satisfies Record<string, AuthErrorCode | SessionErrorCode>;
