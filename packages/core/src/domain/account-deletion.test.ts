import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, pairingId, sessionId } from './common.js';
import type { Account } from './account.js';
import type { Pairing } from './pairing.js';
import { deleteAccount } from './account-deletion.js';

const NOW = 1_700_000_000_000;
const PAIRING_ID = pairingId('pair-1');

function makeAccount(id: string, pairing = PAIRING_ID): Account {
  return {
    id: accountId(id),
    email: `${id}@example.com`,
    pairingId: pairing,
    createdAt: NOW - 1_000,
  };
}

function makePairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    id: PAIRING_ID,
    memberA: accountId('a'),
    memberB: accountId('b'),
    createdAt: NOW - 500,
    status: 'active',
    ...overrides,
  };
}

describe('deleteAccount', () => {
  it('returns an explicit no-op when the request is not confirmed (Req 12.8)', () => {
    const account = makeAccount('a');
    const partner = makeAccount('b');
    const pairing = makePairing();

    const result = deleteAccount({
      account,
      confirmed: false,
      pairingContext: { pairing, partner },
      now: NOW,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confirmed).toBe(false);
      expect(result.value.account).toBe(account);
      expect(result.value.pairing).toBe(pairing);
      expect(result.value.partner).toBe(partner);
      expect(result.value.steps).toEqual([]);
    }
  });

  it('plans only account removal steps for a confirmed unpaired deletion', () => {
    const account = { ...makeAccount('a'), pairingId: null };

    const result = deleteAccount({ account, confirmed: true, now: NOW });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confirmed).toBe(true);
      expect(result.value.pairingDissolution).toBeNull();
      expect(result.value.remainingPartner).toBeNull();
      expect(result.value.pairingOwnedDataToDelete).toEqual([]);
      expect(result.value.notifications).toEqual([]);
      expect(result.value.steps.map((step) => step.kind)).toEqual([
        'terminate_authenticated_sessions',
        'delete_account_row',
        'delete_auth_user',
      ]);
    }
  });

  it('dissolves the pairing before deleting a confirmed paired account (Req 12.3)', () => {
    const account = makeAccount('a');
    const partner = makeAccount('b');
    const pairing = makePairing();
    const activeSessions = [
      { sessionId: sessionId('rt-1'), kind: 'realtime' as const },
      { sessionId: sessionId('quiz-1'), kind: 'quiz' as const },
    ];

    const result = deleteAccount({
      account,
      confirmed: true,
      pairingContext: { pairing, partner, activeSessions },
      now: NOW,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confirmed).toBe(true);
      expect(result.value.steps.map((step) => step.kind)).toEqual([
        'dissolve_pairing',
        'delete_pairing_owned_data',
        'terminate_authenticated_sessions',
        'delete_account_row',
        'delete_auth_user',
      ]);
      expect(result.value.pairingDissolution?.pairing.status).toBe('dissolved');
      expect(result.value.remainingPartner).toEqual({ ...partner, pairingId: null });
      expect(result.value.pairingOwnedDataToDelete).toEqual([PAIRING_ID]);
      expect(result.value.terminatedSessions).toEqual(activeSessions);
      expect(result.value.notifications).toBe(result.value.pairingDissolution?.notifications);
    }
  });

  it('rejects a confirmed paired deletion without pairing context', () => {
    const result = deleteAccount({ account: makeAccount('a'), confirmed: true, now: NOW });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.INVALID_DELETION_STATE);
    }
  });

  it('rejects a pairing context whose partner does not match the pairing', () => {
    const result = deleteAccount({
      account: makeAccount('a'),
      confirmed: true,
      pairingContext: {
        pairing: makePairing(),
        partner: makeAccount('not-b'),
      },
      now: NOW,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.INVALID_DELETION_STATE);
    }
  });
});
