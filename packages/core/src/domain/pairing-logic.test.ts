import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId, sessionId } from './common.js';
import type { Account } from './account.js';
import type { Invitation, Pairing } from './pairing.js';
import {
  INVITATION_VALIDITY_MS,
  acceptInvitation,
  computeInvitationExpiry,
  createInvitation,
  dissolvePairing,
  isInvitationExpired,
  isPaired,
  requirePairing,
} from './pairing-logic.js';

const NOW = 1_700_000_000_000;
const INVITER = accountId('inviter');
const INVITEE = accountId('invitee');
const PAIRING = pairingId('pair-1');
const CODE = invitationCode('ABC123');

function makeAccount(id: string, pairing: string | null = null): Account {
  return {
    id: accountId(id),
    email: `${id}@example.com`,
    pairingId: pairing === null ? null : pairingId(pairing),
    createdAt: NOW - 1000,
  };
}

function makeInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    code: CODE,
    inviterAccountId: INVITER,
    createdAt: NOW,
    expiresAt: computeInvitationExpiry(NOW),
    status: 'pending',
    ...overrides,
  };
}

function makePairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    id: PAIRING,
    memberA: INVITER,
    memberB: INVITEE,
    createdAt: NOW,
    status: 'active',
    ...overrides,
  };
}

describe('isPaired', () => {
  it('is false for an unpaired account and true for a paired one', () => {
    expect(isPaired(makeAccount('a'))).toBe(false);
    expect(isPaired(makeAccount('a', 'pair-1'))).toBe(true);
  });
});

describe('invitation expiry', () => {
  it('expiry is exactly creation + 72h', () => {
    expect(computeInvitationExpiry(NOW)).toBe(NOW + INVITATION_VALIDITY_MS);
    expect(INVITATION_VALIDITY_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('is not expired within the window, including the exact boundary', () => {
    const inv = makeInvitation();
    expect(isInvitationExpired(inv, NOW)).toBe(false);
    expect(isInvitationExpired(inv, inv.expiresAt)).toBe(false);
  });

  it('is expired one millisecond past the boundary', () => {
    const inv = makeInvitation();
    expect(isInvitationExpired(inv, inv.expiresAt + 1)).toBe(true);
  });
});

describe('createInvitation', () => {
  it('creates a pending invitation valid for 72h from now', () => {
    const result = createInvitation({ code: CODE, inviter: makeAccount('inviter'), now: NOW });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.status).toBe('pending');
      expect(result.value.createdAt).toBe(NOW);
      expect(result.value.expiresAt).toBe(NOW + INVITATION_VALIDITY_MS);
      expect(result.value.inviterAccountId).toBe(INVITER);
    }
  });

  it('rejects an inviter that is already paired (Req 3.7)', () => {
    const result = createInvitation({
      code: CODE,
      inviter: makeAccount('inviter', 'pair-x'),
      now: NOW,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
    }
  });
});

describe('acceptInvitation', () => {
  it('creates a pairing linking exactly the two accounts within the window (Req 3.2)', () => {
    const result = acceptInvitation({
      invitation: makeInvitation(),
      inviter: makeAccount('inviter'),
      invitee: makeAccount('invitee'),
      pairingId: PAIRING,
      now: NOW + 1000,
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.pairing.memberA).toBe(INVITER);
      expect(result.value.pairing.memberB).toBe(INVITEE);
      expect(result.value.pairing.status).toBe('active');
      expect(result.value.invitation.status).toBe('consumed');
      expect(result.value.inviter.pairingId).toBe(PAIRING);
      expect(result.value.invitee.pairingId).toBe(PAIRING);
    }
  });

  it('rejects acceptance after the 72h window (Req 3.5)', () => {
    const inv = makeInvitation();
    const result = acceptInvitation({
      invitation: inv,
      inviter: makeAccount('inviter'),
      invitee: makeAccount('invitee'),
      pairingId: PAIRING,
      now: inv.expiresAt + 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.INVITATION_EXPIRED);
    }
  });

  it('rejects a consumed invitation (Req 3.8)', () => {
    const result = acceptInvitation({
      invitation: makeInvitation({ status: 'consumed' }),
      inviter: makeAccount('inviter'),
      invitee: makeAccount('invitee'),
      pairingId: PAIRING,
      now: NOW,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.INVITATION_ALREADY_CONSUMED);
    }
  });

  it('rejects when the invitee (target) is already paired (Req 3.3)', () => {
    const result = acceptInvitation({
      invitation: makeInvitation(),
      inviter: makeAccount('inviter'),
      invitee: makeAccount('invitee', 'pair-x'),
      pairingId: PAIRING,
      now: NOW,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
    }
  });

  it('rejects when the inviter (originator) is already paired (Req 3.4)', () => {
    const result = acceptInvitation({
      invitation: makeInvitation(),
      inviter: makeAccount('inviter', 'pair-x'),
      invitee: makeAccount('invitee'),
      pairingId: PAIRING,
      now: NOW,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
    }
  });
});

describe('dissolvePairing', () => {
  it('unpairs both, retains individual data, and notifies both partners (Req 4.1-4.4)', () => {
    const memberA = makeAccount('inviter', 'pair-1');
    const memberB = makeAccount('invitee', 'pair-1');
    const result = dissolvePairing({ pairing: makePairing(), memberA, memberB, now: NOW });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.pairing.status).toBe('dissolved');
      expect(result.value.memberA.pairingId).toBeNull();
      expect(result.value.memberB.pairingId).toBeNull();
      // Individual data retained.
      expect(result.value.memberA.email).toBe(memberA.email);
      expect(result.value.memberB.email).toBe(memberB.email);
      // One pairing-ended notification per partner.
      expect(result.value.notifications).toHaveLength(2);
      expect(result.value.notifications.every((n) => n.category === 'pairing')).toBe(true);
      const recipients = result.value.notifications.map((n) => n.recipientAccountId);
      expect(recipients).toContain(memberA.id);
      expect(recipients).toContain(memberB.id);
      expect(result.value.terminatedSessions).toEqual([]);
    }
  });

  it('terminates an active session and notifies both partners (Req 4.6)', () => {
    const result = dissolvePairing({
      pairing: makePairing(),
      memberA: makeAccount('inviter', 'pair-1'),
      memberB: makeAccount('invitee', 'pair-1'),
      activeSessions: [{ sessionId: sessionId('s1'), kind: 'quiz' }],
      now: NOW,
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.terminatedSessions).toEqual([sessionId('s1')]);
      // 2 pairing-ended + 2 session-ended.
      expect(result.value.notifications).toHaveLength(4);
      const sessionEnded = result.value.notifications.filter(
        (n) => (n.payload as { type: string }).type === 'session_ended',
      );
      expect(sessionEnded).toHaveLength(2);
    }
  });

  it('rejects dissolving a pairing that is not active', () => {
    const result = dissolvePairing({
      pairing: makePairing({ status: 'dissolved' }),
      memberA: makeAccount('inviter'),
      memberB: makeAccount('invitee'),
      now: NOW,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.NOT_PAIRED);
    }
  });
});

describe('requirePairing', () => {
  it('returns the pairing id when the account is paired', () => {
    const result = requirePairing(makeAccount('a', 'pair-1'));
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(pairingId('pair-1'));
    }
  });

  it('rejects with PAIRING_REQUIRED when the account is unpaired (Req 6.5, 7.9, 8.10)', () => {
    const result = requirePairing(makeAccount('a'));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
    }
  });
});
