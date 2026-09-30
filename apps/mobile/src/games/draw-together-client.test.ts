import { describe, expect, it } from 'vitest';
import { gameId, pairingId, sessionId, type RTSession } from '@ldr/core';

import { drawTogetherState } from './draw-together-client';

describe('Draw Together client mapping', () => {
  it('narrows only Draw Together session state', () => {
    const session: RTSession = {
      id: sessionId('session'),
      pairingId: pairingId('pairing'),
      gameId: gameId('draw-together'),
      state: 'active',
      gameState: { game: 'draw-together', score: 42 },
    };
    expect(drawTogetherState(session)?.score).toBe(42);
    expect(drawTogetherState({ ...session, gameId: gameId('tic-tac-toe') })).toBeNull();
  });
});
