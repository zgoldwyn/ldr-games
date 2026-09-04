/**
 * Pure account-deletion decision logic (Requirement 12).
 *
 * The database and Auth removals happen in the `delete-account` Edge Function,
 * but the irreversible ordering is decided here: an unconfirmed request is a
 * no-op, while a confirmed request dissolves the pairing first, then removes
 * pairing-owned data, active auth sessions, account-owned rows, and credentials.
 */
import { ERROR_CODES, type AccountDeletionError, type PairingError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { Account } from './account.js';
import type { AccountId, PairingId, Timestamp } from './common.js';
import type { Notification } from './notification.js';
import type { Pairing } from './pairing.js';
import {
  dissolvePairing,
  type ActiveSessionRef,
  type DissolvePairingOutput,
} from './pairing-logic.js';

/** Context required when the account being deleted belongs to a pairing. */
export interface DeleteAccountPairingContext {
  readonly pairing: Pairing;
  readonly partner: Account;
  readonly activeSessions?: readonly ActiveSessionRef[];
}

/** Inputs to {@link deleteAccount}. */
export interface DeleteAccountInput {
  /** Account requesting deletion. */
  readonly account: Account;
  /** Explicit second-step confirmation from the shell (Req 12.2, 12.8). */
  readonly confirmed: boolean;
  /** Pairing context, when the account is currently paired. */
  readonly pairingContext?: DeleteAccountPairingContext | null;
  /** Reference "current" time, forwarded to pairing dissolution notifications. */
  readonly now: Timestamp;
}

/** Ordered operation for the future server-side deletion transaction. */
export type AccountDeletionStep =
  | { readonly kind: 'dissolve_pairing'; readonly pairingId: PairingId }
  | { readonly kind: 'delete_pairing_owned_data'; readonly pairingId: PairingId }
  | { readonly kind: 'terminate_authenticated_sessions'; readonly accountId: AccountId }
  | { readonly kind: 'delete_account_row'; readonly accountId: AccountId }
  | {
      readonly kind: 'delete_auth_user';
      readonly accountId: AccountId;
      readonly email: string;
    };

/** No-op decision for an unconfirmed deletion request (Req 12.8). */
export interface UnconfirmedDeleteAccountDecision {
  readonly confirmed: false;
  readonly account: Account;
  readonly pairing: Pairing | null;
  readonly partner: Account | null;
  readonly steps: readonly [];
}

/** Confirmed deletion plan, ready for the Edge Function to enact transactionally. */
export interface ConfirmedDeleteAccountDecision {
  readonly confirmed: true;
  /** Original account snapshot; it is removed by the ordered steps below. */
  readonly account: Account;
  readonly accountId: AccountId;
  readonly email: string;
  readonly pairingDissolution: DissolvePairingOutput | null;
  /** The partner after `dissolvePairing` cleared their `pairingId` (Req 12.3). */
  readonly remainingPartner: Account | null;
  /** Pairing-scoped records and Storage prefixes to remove after dissolution. */
  readonly pairingOwnedDataToDelete: readonly PairingId[];
  readonly terminatedSessions: readonly ActiveSessionRef[];
  readonly notifications: readonly Notification[];
  readonly steps: readonly AccountDeletionStep[];
}

export type DeleteAccountDecision =
  | UnconfirmedDeleteAccountDecision
  | ConfirmedDeleteAccountDecision;

export type DeleteAccountError = AccountDeletionError | PairingError;

/**
 * Decide the effects of an account deletion request.
 *
 * Unconfirmed requests succeed as an explicit no-op so callers can prove no
 * state changes were derived. Confirmed paired deletions delegate the unlink
 * effects to `dissolvePairing`, which keeps the remaining partner's state
 * identical to an ordinary unlink (Req 12.3).
 */
export function deleteAccount(
  input: DeleteAccountInput,
): Result<DeleteAccountDecision, DeleteAccountError> {
  const { account, confirmed, now } = input;
  const pairingContext = input.pairingContext ?? null;

  if (!confirmed) {
    return ok({
      confirmed: false,
      account,
      pairing: pairingContext?.pairing ?? null,
      partner: pairingContext?.partner ?? null,
      steps: [],
    });
  }

  if (pairingContext === null) {
    if (account.pairingId !== null) {
      return err(invalidDeletionState('A paired account requires pairing context before deletion.'));
    }

    return ok({
      confirmed: true,
      account,
      accountId: account.id,
      email: account.email,
      pairingDissolution: null,
      remainingPartner: null,
      pairingOwnedDataToDelete: [],
      terminatedSessions: [],
      notifications: [],
      steps: accountRemovalSteps(account),
    });
  }

  const { pairing, partner } = pairingContext;
  const activeSessions = pairingContext.activeSessions ?? [];
  const deletedIsMemberA = pairing.memberA === account.id;
  const deletedIsMemberB = pairing.memberB === account.id;

  if (!deletedIsMemberA && !deletedIsMemberB) {
    return err(invalidDeletionState('The account being deleted is not a member of the pairing.'));
  }

  const expectedPartnerId = deletedIsMemberA ? pairing.memberB : pairing.memberA;
  if (partner.id !== expectedPartnerId) {
    return err(invalidDeletionState('The supplied partner does not match the pairing.'));
  }

  if (account.pairingId !== pairing.id || partner.pairingId !== pairing.id) {
    return err(invalidDeletionState('Both accounts must reference the active pairing before deletion.'));
  }

  const memberA = deletedIsMemberA ? account : partner;
  const memberB = deletedIsMemberA ? partner : account;
  const dissolution = dissolvePairing({ pairing, memberA, memberB, activeSessions, now });
  if (!dissolution.ok) return dissolution;

  const remainingPartner = deletedIsMemberA
    ? dissolution.value.memberB
    : dissolution.value.memberA;

  return ok({
    confirmed: true,
    account,
    accountId: account.id,
    email: account.email,
    pairingDissolution: dissolution.value,
    remainingPartner,
    pairingOwnedDataToDelete: [pairing.id],
    terminatedSessions: activeSessions,
    notifications: dissolution.value.notifications,
    steps: [
      { kind: 'dissolve_pairing', pairingId: pairing.id },
      { kind: 'delete_pairing_owned_data', pairingId: pairing.id },
      ...accountRemovalSteps(account),
    ],
  });
}

function accountRemovalSteps(account: Account): readonly AccountDeletionStep[] {
  return [
    { kind: 'terminate_authenticated_sessions', accountId: account.id },
    { kind: 'delete_account_row', accountId: account.id },
    { kind: 'delete_auth_user', accountId: account.id, email: account.email },
  ];
}

function invalidDeletionState(message: string): AccountDeletionError {
  return { code: ERROR_CODES.INVALID_DELETION_STATE, message };
}
