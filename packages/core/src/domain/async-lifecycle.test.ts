import { describe, expect, it } from 'vitest';

import {
  accountId,
  gameId,
  notificationId,
  pairingId,
  sessionId,
} from './common.js';
import type { AsyncSession } from './game.js';
import type { Pairing } from './pairing.js';
import {
  TURN_NUDGE_THRESHOLD_MS,
  type AsyncTurnNotificationPayload,
  deriveTurnHandoffNotification,
  deriveTurnNudge,
  isAsyncSessionActive,
  isTurnNudgeDue,
} from './async-lifecycle.js';

const HOLDER = accountId('holder');
const OTHER = accountId('other');
const NOW = 1_000_000_000_000;

function makeSession(overrides: Partial<AsyncSession> = {}): AsyncSession {
  return {
    id: sessionId('s1'),
    pairingId: pairingId('p1'),
    gameId: gameId('battleship'),
    state: 'active',
    activeTurnHolder: HOLDER,
    turnPendingSince: NOW,
    gameState: {},
    ...overrides,
  };
}

function makePairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    id: pairingId('p1'),
    memberA: HOLDER,
    memberB: OTHER,
    createdAt: NOW,
    status: 'active',
    ...overrides,
  };
}

describe('isAsyncSessionActive (Req 7.11)', () => {
  it('stays active for an active session with an active pairing regardless of inactivity', () => {
    const session = makeSession();
    const pairing = makePairing();
    expect(isAsyncSessionActive(session, pairing)).toBe(true);
  });

  it('ends only on a terminal state', () => {
    expect(isAsyncSessionActive(makeSession({ state: 'terminal' }), makePairing())).toBe(false);
  });

  it('ends only on a dissolved pairing', () => {
    expect(isAsyncSessionActive(makeSession(), makePairing({ status: 'dissolved' }))).toBe(false);
  });
});

describe('isTurnNudgeDue / deriveTurnNudge (Req 7.12)', () => {
  it('is not due before 48 continuous hours', () => {
    const session = makeSession({ turnPendingSince: NOW });
    const now = NOW + TURN_NUDGE_THRESHOLD_MS - 1;
    expect(isTurnNudgeDue(session, now)).toBe(false);
    expect(deriveTurnNudge(session, now, notificationId('n1'))).toBeNull();
  });

  it('is due exactly at the 48-hour boundary and targets the holder without terminating', () => {
    const session = makeSession({ turnPendingSince: NOW });
    const now = NOW + TURN_NUDGE_THRESHOLD_MS;
    expect(isTurnNudgeDue(session, now)).toBe(true);

    const nudge = deriveTurnNudge(session, now, notificationId('n1'));
    expect(nudge).not.toBeNull();
    expect(nudge?.recipientAccountId).toBe(HOLDER);
    expect(nudge?.category).toBe('async_turn');
    expect((nudge?.payload as AsyncTurnNotificationPayload).kind).toBe('turn_reminder');
    // Deriving a nudge never changes the session's active status.
    expect(isAsyncSessionActive(session, makePairing())).toBe(true);
  });

  it('never nudges a terminal session', () => {
    const session = makeSession({ state: 'terminal', turnPendingSince: NOW });
    const now = NOW + TURN_NUDGE_THRESHOLD_MS * 10;
    expect(isTurnNudgeDue(session, now)).toBe(false);
    expect(deriveTurnNudge(session, now, notificationId('n1'))).toBeNull();
  });
});

describe('deriveTurnHandoffNotification (Req 7.6)', () => {
  it('targets the new active turn holder with a your-turn notification', () => {
    // After applyTurn, ownership has transferred: activeTurnHolder is now OTHER.
    const postTurn = makeSession({ activeTurnHolder: OTHER, turnPendingSince: NOW + 5 });
    const notification = deriveTurnHandoffNotification(postTurn, NOW + 5, notificationId('n2'));

    expect(notification.recipientAccountId).toBe(OTHER);
    expect(notification.category).toBe('async_turn');
    expect((notification.payload as AsyncTurnNotificationPayload).kind).toBe('your_turn');
    expect(notification.createdAt).toBe(NOW + 5);
    expect(notification.acknowledgedAt).toBeNull();
    expect(notification.deliveredAt).toBeNull();
  });
});
