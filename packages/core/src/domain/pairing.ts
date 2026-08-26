/**
 * Pairing invitation and pairing shapes (Requirements 3 and 4).
 */
import type { AccountId, InvitationCode, PairingId, Timestamp } from './common.js';

/** Lifecycle status of a pairing invitation. */
export type InvitationStatus = 'pending' | 'consumed' | 'expired';

/**
 * A time-limited, single-use pairing invitation. `expiresAt` equals
 * `createdAt + 72h` (Requirement 3.1); once consumed to create a pairing it can
 * never be reused (Requirement 3.8).
 */
export interface Invitation {
  readonly code: InvitationCode;
  readonly inviterAccountId: AccountId;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly status: InvitationStatus;
}

/** Lifecycle status of a pairing. */
export type PairingStatus = 'active' | 'dissolved';

/**
 * An exclusive one-to-one link between two accounts. Exclusivity (at most one
 * active pairing per account, Requirement 3.6) is additionally enforced by a
 * partial UNIQUE index on active membership in the database.
 */
export interface Pairing {
  readonly id: PairingId;
  readonly memberA: AccountId;
  readonly memberB: AccountId;
  readonly createdAt: Timestamp;
  readonly status: PairingStatus;
}
