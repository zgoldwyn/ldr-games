import { describe, expect, it } from 'vitest';

import { accountId } from './common.js';
import {
  canPlaySpeedCard,
  speedDeck,
  speedHasPlayableCard,
  speedRuleset,
  type SpeedCard,
  type SpeedState,
} from './rt-speed.js';

const A = accountId('alice');
const B = accountId('bob');
const card = (rank: number, id = `card-${rank}`): SpeedCard => ({ id, rank, suit: 'clubs' });

describe('Speed rules', () => {
  it('builds a deterministic, complete, unique deal', () => {
    expect(speedDeck('one')).toEqual(speedDeck('one'));
    expect(speedDeck('one')).not.toEqual(speedDeck('two'));
    expect(new Set(speedDeck('one').map((item) => item.id)).size).toBe(52);

    const state = speedRuleset.createInitialState([A, B], A, 'session-id');
    const dealt = [
      ...state.playerStates.flatMap((player) => [...player.hand, ...player.stock]),
      ...state.reservePiles.flat(),
      ...state.centerPiles.flat(),
    ];
    expect(dealt).toHaveLength(52);
    expect(new Set(dealt.map((item) => item.id)).size).toBe(52);
  });

  it('accepts adjacent ranks and lets aces wrap to kings', () => {
    expect(canPlaySpeedCard(card(6), card(5))).toBe(true);
    expect(canPlaySpeedCard(card(4), card(5))).toBe(true);
    expect(canPlaySpeedCard(card(1), card(13))).toBe(true);
    expect(canPlaySpeedCard(card(8), card(5))).toBe(false);
  });

  it('replenishes a hand after a legal play without enforcing turns', () => {
    const initial = speedRuleset.createInitialState([A, B], A, 'play-test');
    const playable = card(6, 'playable');
    const state: SpeedState = {
      ...initial,
      centerPiles: [[card(5, 'left')], [card(10, 'right')]],
      playerStates: [
        { player: A, hand: [playable], stock: [card(9, 'stock')] },
        initial.playerStates[1],
      ],
    };
    const result = speedRuleset.applyMove(state, A, { type: 'play', cardId: playable.id, pile: 0 });
    if (!result.ok) throw new Error('play should succeed');
    expect(result.value.playerStates[0].hand.map((item) => item.id)).toEqual(['stock']);
    expect(result.value.playerStates[0].stock).toEqual([]);
  });

  it('waits for both players before flipping the shared piles', () => {
    const initial = speedRuleset.createInitialState([A, B], A, 'flip-test');
    const state: SpeedState = {
      ...initial,
      centerPiles: [[card(5, 'left')], [card(10, 'right')]],
      reservePiles: [[card(3, 'left-next')], [card(12, 'right-next')]],
      playerStates: [
        { player: A, hand: [card(8, 'a')], stock: [] },
        { player: B, hand: [card(8, 'b')], stock: [] },
      ],
    };
    expect(speedHasPlayableCard(state)).toBe(false);
    const first = speedRuleset.applyMove(state, A, { type: 'ready_to_flip' });
    if (!first.ok) throw new Error('first readiness should succeed');
    expect(first.value.readyToFlip).toEqual([A]);
    expect(first.value.centerPiles).toEqual(state.centerPiles);

    const second = speedRuleset.applyMove(first.value, B, { type: 'ready_to_flip' });
    if (!second.ok) throw new Error('second readiness should succeed');
    expect(second.value.readyToFlip).toEqual([]);
    expect(second.value.centerPiles[0].at(-1)?.id).toBe('left-next');
    expect(second.value.centerPiles[1].at(-1)?.id).toBe('right-next');
  });

  it('rejects flip readiness while either player has a move', () => {
    const initial = speedRuleset.createInitialState([A, B], A, 'not-blocked');
    const state: SpeedState = {
      ...initial,
      centerPiles: [[card(5, 'left')], [card(10, 'right')]],
      playerStates: [
        { player: A, hand: [card(6, 'a')], stock: [] },
        { player: B, hand: [card(8, 'b')], stock: [] },
      ],
    };
    expect(speedRuleset.applyMove(state, A, { type: 'ready_to_flip' })).toMatchObject({
      ok: false,
    });
  });
});
