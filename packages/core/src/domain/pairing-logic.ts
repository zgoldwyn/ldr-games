/**
 * Pure pairing lifecycle logic: invitation creation and expiry, single-use
 * consumption, exclusivity enforcement, acceptance, dissolution, and the shared
 * `requirePairing` guard (Requirements 3 and 4, plus 6.5 / 7.9 / 8.10).
 *
 * Every function here is **pure and deterministic**: it performs no I/O, reads
 * no wall clock (callers pass `now`), and generates no randomness (callers pass
 * the invitation code and any identifiers). Business rules are expressed as
 * state transformations that return the new entity states together with the
 * side effects to enact (notifications to insert, sessions to terminate), so the
 * Edge Functions (task 13.x) and the property tests (tasks 10.2–10.9) can drive
 * this logic without a database.
 *
 * All rejections leave the supplied state unchanged — the caller simply never
 * receives a new state on the `Err` branch (Requirements 3.3, 3.4, 3.5).
 */
import { ERROR_CODES, type AppError, type PairingError } from '../errors.js';
import { type Result, err, ok } from '../result.js';
import type {
  AccountId,
  InvitationCode,
  NotificationId,
  PairingId,
  SessionId,
  Timestamp,
} from './common.js';
import type { Account } from './account.js';
import type { Invitation, Pairing } from './pairing.js';
import type { Notification } from './notification.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a pairing invitation stays valid after creation: 72 hours (Req 3.1). */
export const INVITATION_VALIDITY_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small predicates
// ---------------------------------------------------------------------------

/** Whether an account currently belongs to an active pairing (Req 3.6). */
export function isPaired(account: Pick<Account, 'pairingId'>): boolean {
  return account.pairingId !== null;
}

/**
 * The moment an invitation created at `createdAt` expires: exactly
 * `createdAt + 72h` (Req 3.1).
 */
export function computeInvitationExpiry(createdAt: Timestamp): Timestamp {
  return createdAt + INVITATION_VALIDITY_MS;
}

/**
 * Whether an invitation is expired at `now`. It is expired iff `now` is strictly
 * greater than its expiry (`createdAt + 72h`); accepting exactly at the boundary
 * is still within the window (Req 3.2, 3.5).
 */
export function isInvitationExpired(
  invitation: Pick<Invitation, 'expiresAt'>,
  now: Timestamp,
): boolean {
  return now > invitation.expiresAt;
}

// ---------------------------------------------------------------------------
// Invitation creation (Req 3.1, 3.7)
// ---------------------------------------------------------------------------

/** Inputs to {@link createInvitation}. */
export interface CreateInvitationInput {
  /** The pre-generated unique invitation code. */
  readonly code: InvitationCode;
  /** The account requesting the invitation. */
  readonly inviter: Account;
  /** Reference "current" time; becomes the invitation's `createdAt`. */
  readonly now: Timestamp;
}

/**
 * Create a pending invitation valid for 72 hours from `now`.
 *
 * Rejects with `ALREADY_PAIRED` when the inviter is already in a pairing, since
 * a paired account may not invite a partner (Req 3.7); the state is left
 * unchanged. On success the invitation's `expiresAt` is `now + 72h` (Req 3.1).
 */
export function createInvitation(
  input: CreateInvitationInput,
): Result<Invitation, PairingError> {
  const { code, inviter, now } = input;

  if (isPaired(inviter)) {
    return err({
      code: ERROR_CODES.ALREADY_PAIRED,
      message: 'Account is already in a pairing and cannot create an invitation.',
    });
  }

  return ok({
    code,
    inviterAccountId: inviter.id,
    createdAt: now,
    expiresAt: computeInvitationExpiry(now),
    status: 'pending',
  });
}

// ---------------------------------------------------------------------------
// Invitation acceptance (Req 3.2, 3.3, 3.4, 3.5, 3.8)
// ---------------------------------------------------------------------------

/** Inputs to {@link acceptInvitation}. */
export interface AcceptInvitationInput {
  /** The invitation being accepted. */
  readonly invitation: Invitation;
  /** The account that created the invitation (`invitation.inviterAccountId`). */
  readonly inviter: Account;
  /** The account accepting the invitation. */
  readonly invitee: Account;
  /** Identifier to assign to the newly created pairing. */
  readonly pairingId: PairingId;
  /** Reference "current" time; becomes the pairing's `createdAt`. */
  readonly now: Timestamp;
}

/**
 * The consistent set of new states produced by a successful acceptance: the new
 * active pairing, the now-consumed invitation, and both accounts updated to
 * reference the pairing.
 */
export interface AcceptInvitationOutput {
  readonly pairing: Pairing;
  /** The invitation with `status: 'consumed'` so it can never be reused (Req 3.8). */
  readonly invitation: Invitation;
  readonly inviter: Account;
  readonly invitee: Account;
}

/**
 * Accept a pending invitation, creating a pairing that links exactly the inviter
 * and invitee accounts (Req 3.2).
 *
 * Rejections leave all state unchanged:
 * - `INVITATION_ALREADY_CONSUMED` — the invitation was already used (Req 3.8).
 * - `INVITATION_EXPIRED` — accepted more than 72h after creation (Req 3.5).
 * - `ALREADY_PAIRED` — the invitation originates from, or targets, an already
 *   paired account (Req 3.3, 3.4). Exclusivity means at most one active pairing
 *   per account (Req 3.6).
 */
export function acceptInvitation(
  input: AcceptInvitationInput,
): Result<AcceptInvitationOutput, PairingError> {
  const { invitation, inviter, invitee, pairingId, now } = input;

  if (invitation.status === 'consumed') {
    return err({
      code: ERROR_CODES.INVITATION_ALREADY_CONSUMED,
      message: 'Invitation has already been used to create a pairing.',
    });
  }

  if (invitation.status === 'expired' || isInvitationExpired(invitation, now)) {
    return err({
      code: ERROR_CODES.INVITATION_EXPIRED,
      message: 'Invitation was accepted after its 72-hour validity window.',
    });
  }

  // Exclusivity: reject when either the originating (inviter) or targeted
  // (invitee) account is already paired (Req 3.3, 3.4, 3.6).
  if (isPaired(inviter) || isPaired(invitee)) {
    return err({
      code: ERROR_CODES.ALREADY_PAIRED,
      message: 'One of the accounts is already in a pairing.',
    });
  }

  const pairing: Pairing = {
    id: pairingId,
    memberA: inviter.id,
    memberB: invitee.id,
    createdAt: now,
    status: 'active',
  };

  return ok({
    pairing,
    invitation: { ...invitation, status: 'consumed' },
    inviter: { ...inviter, pairingId },
    invitee: { ...invitee, pairingId },
  });
}

// ---------------------------------------------------------------------------
// Dissolution / unlink (Req 4.1–4.6)
// ---------------------------------------------------------------------------

/** The kind of session that may be active for a pairing. */
export type SessionKind = 'realtime' | 'async' | 'quiz';

/** A reference to an active game or quiz session owned by the pairing (Req 4.6). */
export interface ActiveSessionRef {
  readonly sessionId: SessionId;
  readonly kind: SessionKind;
}

/** Inputs to {@link dissolvePairing}. */
export interface DissolvePairingInput {
  /** The pairing to dissolve. */
  readonly pairing: Pairing;
  /** One member account of the pairing. */
  readonly memberA: Account;
  /** The other member account of the pairing. */
  readonly memberB: Account;
  /**
   * Any active game/quiz sessions owned by the pairing that must be terminated
   * (Req 4.6). Omit or pass an empty array when none are active.
   */
  readonly activeSessions?: readonly ActiveSessionRef[];
  /** Reference "current" time; stamps the produced notifications. */
  readonly now: Timestamp;
}

/**
 * The new states and side effects produced by dissolving a pairing.
 *
 * `memberA`/`memberB` are the accounts with `pairingId` cleared (Req 4.3); every
 * other field is preserved so each account's individual data is retained (Req
 * 4.4). Because the accounts no longer reference the pairing, all pairing-owned
 * data becomes unreachable to both former partners (Req 4.4, enforced by RLS).
 */
export interface DissolvePairingOutput {
  /** The pairing with `status: 'dissolved'`. */
  readonly pairing: Pairing;
  readonly memberA: Account;
  readonly memberB: Account;
  /** Sessions to terminate as a result of dissolution (Req 4.6). */
  readonly terminatedSessions: readonly SessionId[];
  /**
   * Notifications to insert: one pairing-ended notification per former partner
   * (Req 4.2), plus one session-ended notification per former partner for each
   * terminated session (Req 4.6). Delivery may be deferred until a partner next
   * establishes a session (Req 4.5), so `deliveredAt` is `null`.
   */
  readonly notifications: readonly Notification[];
}

/**
 * Dissolve an active pairing: unpair both accounts, retain their individual
 * data, revoke access to pairing-owned data, terminate any active game/quiz
 * session, and produce pairing-ended (and, when applicable, session-ended)
 * notifications for both former partners (Req 4.1–4.6).
 *
 * Rejects with `NOT_PAIRED` when the pairing is not active (nothing to
 * dissolve), leaving state unchanged.
 */
export function dissolvePairing(
  input: DissolvePairingInput,
): Result<DissolvePairingOutput, PairingError> {
  const { pairing, memberA, memberB, now } = input;
  const activeSessions = input.activeSessions ?? [];

  if (pairing.status !== 'active') {
    return err({
      code: ERROR_CODES.NOT_PAIRED,
      message: 'Pairing is not active and cannot be dissolved.',
    });
  }

  const partners: readonly AccountId[] = [memberA.id, memberB.id];

  const pairingEnded = partners.map((recipient) =>
    pairingEndedNotification(pairing.id, recipient, now),
  );

  const sessionEnded = activeSessions.flatMap((session) =>
    partners.map((recipient) =>
      sessionEndedNotification(pairing.id, session, recipient, now),
    ),
  );

  return ok({
    pairing: { ...pairing, status: 'dissolved' },
    // Clearing `pairingId` unpairs the account (Req 4.3) and revokes access to
    // pairing-owned data (Req 4.4); all other fields are retained (Req 4.4).
    memberA: { ...memberA, pairingId: null },
    memberB: { ...memberB, pairingId: null },
    terminatedSessions: activeSessions.map((session) => session.sessionId),
    notifications: [...pairingEnded, ...sessionEnded],
  });
}

/** Build the deterministic pairing-ended notification for a former partner (Req 4.2). */
function pairingEndedNotification(
  pairingId: PairingId,
  recipient: AccountId,
  now: Timestamp,
): Notification {
  const dedupeKey = `pairing-ended:${pairingId}:${recipient}`;
  return {
    id: `${dedupeKey}` as NotificationId,
    recipientAccountId: recipient,
    category: 'pairing',
    payload: { type: 'pairing_ended', pairingId },
    createdAt: now,
    dedupeKey,
    acknowledgedAt: null,
    // Deferred delivery until the partner next establishes a session (Req 4.5).
    deliveredAt: null,
  };
}

/** Build the deterministic session-ended notification for a former partner (Req 4.6). */
function sessionEndedNotification(
  pairingId: PairingId,
  session: ActiveSessionRef,
  recipient: AccountId,
  now: Timestamp,
): Notification {
  const dedupeKey = `session-ended:${session.sessionId}:${recipient}`;
  return {
    id: `${dedupeKey}` as NotificationId,
    recipientAccountId: recipient,
    category: 'system',
    payload: {
      type: 'session_ended',
      pairingId,
      sessionId: session.sessionId,
      sessionKind: session.kind,
    },
    createdAt: now,
    dedupeKey,
    acknowledgedAt: null,
    deliveredAt: null,
  };
}

// ---------------------------------------------------------------------------
// requirePairing guard (Req 6.5, 7.9, 8.10)
// ---------------------------------------------------------------------------

/**
 * Shared guard used by real-time, asynchronous, and quiz session starts: an
 * account may only start a session while it is in an active pairing.
 *
 * Returns `ok(pairingId)` when the account is paired, or `err(PAIRING_REQUIRED)`
 * when it is not (Req 6.5, 7.9, 8.10).
 */
export function requirePairing(
  account: Pick<Account, 'pairingId'>,
): Result<PairingId, AppError<'PAIRING_REQUIRED'>> {
  if (account.pairingId === null) {
    return err({
      code: ERROR_CODES.PAIRING_REQUIRED,
      message: 'A partner pairing is required to start a session.',
    });
  }
  return ok(account.pairingId);
}
