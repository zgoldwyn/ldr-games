import { describe, expect, it } from 'vitest';
import {
  accountId,
  gameId,
  notificationId,
  pairingId,
  sessionId,
  SPEED_GAME_ID,
  type Notification,
  type RTSession,
} from '@ldr/core';
import { pendingLiveRequest } from './live-game-request';

const ID = sessionId('11111111-1111-4111-8111-111111111111');
const notification: Notification = {
  id: notificationId('22222222-2222-4222-8222-222222222222'),
  recipientAccountId: accountId('33333333-3333-4333-8333-333333333333'),
  category: 'game_invite',
  payload: { type: 'rt_game_invite', sessionId: ID, gameId: SPEED_GAME_ID },
  createdAt: 1,
  dedupeKey: `rt-invite:${ID}`,
  acknowledgedAt: null,
  deliveredAt: null,
};
const session: RTSession = {
  id: ID,
  pairingId: pairingId('44444444-4444-4444-8444-444444444444'),
  gameId: gameId(SPEED_GAME_ID),
  state: 'pending',
  gameState: {},
};

describe('blocking live game requests', () => {
  it('shows a supported pending invitation with a destination', () => {
    expect(pendingLiveRequest([notification], [session])).toMatchObject({
      name: 'Speed',
      route: 'Speed',
      session,
    });
  });

  it('ignores accepted, removed, and acknowledged invitations', () => {
    expect(pendingLiveRequest([notification], [{ ...session, state: 'active' }])).toBeNull();
    expect(pendingLiveRequest([notification], [])).toBeNull();
    expect(pendingLiveRequest([{ ...notification, acknowledgedAt: 2 }], [session])).toBeNull();
  });
});
