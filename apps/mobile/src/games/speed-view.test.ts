import { describe, expect, it } from 'vitest';
import { accountId, speedRuleset } from '@ldr/core';

import { asSpeedState, legalPileForCard, rankLabel, speedStatus, suitSymbol } from './speed-view';

const A = accountId('alice');
const B = accountId('bob');

describe('Speed presentation', () => {
  it('recognizes Speed state and finds a legal center pile', () => {
    const state = speedRuleset.createInitialState([A, B], A, 'view-test');
    expect(asSpeedState(state)).toBe(state);
    expect(asSpeedState({ game: 'tic-tac-toe' })).toBeNull();
    const top = state.centerPiles[0].at(-1)!;
    const adjacent = {
      id: 'test',
      suit: 'hearts' as const,
      rank: top.rank === 13 ? 1 : top.rank + 1,
    };
    expect(legalPileForCard(state, adjacent)).toBe(0);
  });

  it('formats face cards and suits', () => {
    expect([1, 11, 12, 13].map(rankLabel)).toEqual(['A', 'J', 'Q', 'K']);
    expect(suitSymbol('hearts')).toBe('♥');
  });

  it('describes pending and terminal games', () => {
    const state = speedRuleset.createInitialState([A, B], A, 'status-test');
    expect(
      speedStatus({ sessionState: 'pending', state: null, self: A, partnerName: 'Sam' }).title,
    ).toBe('Waiting for Sam');
    expect(
      speedStatus({
        sessionState: 'terminal',
        state: { ...state, status: 'won', winner: A },
        self: A,
      }).title,
    ).toBe('You won!');
  });
});
