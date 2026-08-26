/**
 * Account, single-session registry, lockout tracking, and credential-validation
 * shapes (Requirements 1 and 2).
 */
import type { AccountId, ClientInfo, PairingId, Timestamp } from './common.js';

/**
 * A registered account. The password is held by Supabase Auth as a bcrypt hash
 * and is never present in application tables (Requirement 1.6). `pairingId` is
 * the current active pairing and serves as the primary RLS predicate for
 * pairing-owned data; it is `null` while the account is unpaired.
 */
export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly pairingId: PairingId | null;
  readonly createdAt: Timestamp;
}

/**
 * Single-session registry row (one per account). Overrides Supabase's default
 * multi-session behavior: `epoch` increments on every new login and a token
 * whose epoch does not match is rejected (Requirements 2.7-2.9).
 */
export interface AccountSession {
  readonly accountId: AccountId;
  readonly epoch: number;
  readonly client: ClientInfo;
  /** Drives the 30-day inactivity expiry (Requirement 2.6). */
  readonly lastActivityAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Failed-attempt tracking backing the lockout policy (Requirement 2.3). */
export interface AuthAttempts {
  readonly accountId: AccountId;
  readonly failedCount: number;
  readonly windowStart: Timestamp;
  readonly lockedUntil: Timestamp | null;
}

/** The individual password-policy criteria checked during registration. */
export type PasswordCriterion =
  | 'length' // 12-128 characters
  | 'uppercase' // at least one uppercase letter
  | 'lowercase' // at least one lowercase letter
  | 'digit' // at least one digit
  | 'nonAlphanumeric'; // at least one non-alphanumeric character

/**
 * Result of evaluating a password against the policy. `valid` is true only when
 * `unmetCriteria` is empty; when invalid, `unmetCriteria` reports exactly the
 * criteria the password violates (Requirements 1.1, 1.3, 1.5).
 */
export interface PasswordValidation {
  readonly valid: boolean;
  readonly unmetCriteria: readonly PasswordCriterion[];
}
