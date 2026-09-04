import { describe, expect, it } from 'vitest';

import { accountId, pairingId, type Pairing, type Session } from '@ldr/core';

import { sessionGate } from './session-gate';

const SESSION: Session = {
  accountId: accountId('11111111-1111-4111-8111-111111111111'),
  epoch: 1,
  client: { platform: 'mobile' },
  issuedAt: 1,
  lastActivityAt: 1,
};

const PAIRING: Pairing = {
  id: pairingId('22222222-2222-4222-8222-222222222222'),
  memberA: SESSION.accountId,
  memberB: accountId('33333333-3333-4333-8333-333333333333'),
  createdAt: 1,
  status: 'active',
};

describe('sessionGate', () => {
  it('routes to sign-in when there is no session (Req 2.5)', () => {
    expect(sessionGate(null, null)).toBe('signedOut');
    expect(sessionGate(null, PAIRING)).toBe('signedOut');
  });

  it('routes to pairing when signed in but unpaired', () => {
    expect(sessionGate(SESSION, null)).toBe('unpaired');
  });

  it('does not treat a dissolved pairing as ready (Req 4.3)', () => {
    expect(sessionGate(SESSION, { ...PAIRING, status: 'dissolved' })).toBe('unpaired');
  });

  it('opens the game list only for an active pairing', () => {
    expect(sessionGate(SESSION, PAIRING)).toBe('ready');
  });
});
