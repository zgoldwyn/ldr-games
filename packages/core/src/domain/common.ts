/**
 * Shared primitive and identifier types used across every domain module.
 *
 * Identifiers are **branded** strings: structurally they are still `string`
 * (so they serialize, index `Record`s, and compare exactly as strings), but the
 * phantom brand prevents accidentally passing, say, a `PairingId` where an
 * `AccountId` is expected. Branded values are produced through the small
 * casting helpers at the bottom of this file — these are pure casts, not
 * validation or business logic.
 */

declare const __brand: unique symbol;

/** Attach a compile-time-only phantom brand `B` to a base type `T`. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// Branded identifier types
// ---------------------------------------------------------------------------

/** An account identifier (equals the Supabase `auth.users.id` uuid). */
export type AccountId = Brand<string, 'AccountId'>;
/** A pairing identifier. */
export type PairingId = Brand<string, 'PairingId'>;
/** A game or quiz session identifier. */
export type SessionId = Brand<string, 'SessionId'>;
/** A game definition identifier (real-time or asynchronous). */
export type GameId = Brand<string, 'GameId'>;
/** A quiz definition identifier. */
export type QuizId = Brand<string, 'QuizId'>;
/** A quiz-question identifier. */
export type QuestionId = Brand<string, 'QuestionId'>;
/** A relationship-date identifier. */
export type DateId = Brand<string, 'DateId'>;
/** A reminder identifier. */
export type ReminderId = Brand<string, 'ReminderId'>;
/** A notification identifier. */
export type NotificationId = Brand<string, 'NotificationId'>;
/** A single-use pairing-invitation code. */
export type InvitationCode = Brand<string, 'InvitationCode'>;

// ---------------------------------------------------------------------------
// Time and platform primitives
// ---------------------------------------------------------------------------

/** A point in time as milliseconds since the Unix epoch (UTC). */
export type Timestamp = number;

/** A span of time in milliseconds (for example a reminder lead time). */
export type Duration = number;

/**
 * A calendar date without a time component, used for relationship dates. Months
 * are 1-12 and days are 1-31; validity is enforced by `isValidCalendarDate` in a
 * later task, not by this shape.
 */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The platform a client is running on. */
export type Platform = 'mobile' | 'desktop';

/** Identifying information about the client that owns a session. */
export interface ClientInfo {
  readonly platform: Platform;
  /** Optional human-friendly device label (for example "Zoe's iPhone"). */
  readonly device?: string;
}

/**
 * An established authenticated session. The `epoch` matches the account's
 * single-session registry (`AccountSession.epoch`); a token whose epoch is
 * stale is rejected, enforcing the single active session invariant
 * (Requirements 2.7-2.9).
 */
export interface Session {
  readonly accountId: AccountId;
  readonly epoch: number;
  readonly client: ClientInfo;
  readonly issuedAt: Timestamp;
  readonly lastActivityAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Branded-id casting helpers (pure casts; no validation)
// ---------------------------------------------------------------------------

export const accountId = (raw: string): AccountId => raw as AccountId;
export const pairingId = (raw: string): PairingId => raw as PairingId;
export const sessionId = (raw: string): SessionId => raw as SessionId;
export const gameId = (raw: string): GameId => raw as GameId;
export const quizId = (raw: string): QuizId => raw as QuizId;
export const questionId = (raw: string): QuestionId => raw as QuestionId;
export const dateId = (raw: string): DateId => raw as DateId;
export const reminderId = (raw: string): ReminderId => raw as ReminderId;
export const notificationId = (raw: string): NotificationId => raw as NotificationId;
export const invitationCode = (raw: string): InvitationCode => raw as InvitationCode;
