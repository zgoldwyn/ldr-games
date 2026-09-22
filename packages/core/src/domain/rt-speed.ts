import { err, ok, type Result } from '../result.js';
import type { MoveError } from '../errors.js';
import type { AccountId, Timestamp } from './common.js';
import type { GameOutcome } from './game.js';
import {
  invalidMove,
  registerRuleset,
  type RealTimeRuleset,
  type RTGameStateBase,
} from './rt-engine.js';

export const SPEED_GAME_ID = 'speed';

export type SpeedSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface SpeedCard {
  readonly id: string;
  readonly rank: number;
  readonly suit: SpeedSuit;
}

export interface SpeedPlayerState {
  readonly player: AccountId;
  readonly hand: readonly SpeedCard[];
  readonly stock: readonly SpeedCard[];
}

export interface SpeedState extends RTGameStateBase {
  readonly game: typeof SPEED_GAME_ID;
  readonly playerStates: readonly [SpeedPlayerState, SpeedPlayerState];
  readonly centerPiles: readonly [readonly SpeedCard[], readonly SpeedCard[]];
  readonly reservePiles: readonly [readonly SpeedCard[], readonly SpeedCard[]];
  readonly readyToFlip: readonly AccountId[];
}

export type SpeedMove =
  | { readonly type: 'play'; readonly cardId: string; readonly pile: 0 | 1 }
  | { readonly type: 'ready_to_flip' };

const SUITS: readonly SpeedSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];

function deck(): SpeedCard[] {
  return SUITS.flatMap((suit) =>
    Array.from({ length: 13 }, (_, index) => ({
      id: `${suit}-${index + 1}`,
      rank: index + 1,
      suit,
    })),
  );
}

function seedNumber(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Deterministic so server retries always construct the same opening deal. */
export function speedDeck(seed: string): readonly SpeedCard[] {
  const cards = deck();
  let value = seedNumber(seed);
  for (let i = cards.length - 1; i > 0; i -= 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const j = value % (i + 1);
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  return cards;
}

export function canPlaySpeedCard(card: SpeedCard, top: SpeedCard): boolean {
  const distance = Math.abs(card.rank - top.rank);
  return distance === 1 || distance === 12;
}

export function speedHasPlayableCard(state: SpeedState): boolean {
  const tops = state.centerPiles.map((pile) => pile[pile.length - 1]);
  return state.playerStates.some((player) =>
    player.hand.some((card) => tops.some((top) => top && canPlaySpeedCard(card, top))),
  );
}

function isMove(move: unknown): move is SpeedMove {
  if (move === null || typeof move !== 'object') return false;
  const value = move as Partial<SpeedMove> & { readonly cardId?: unknown; readonly pile?: unknown };
  if (value.type === 'ready_to_flip') return true;
  return (
    value.type === 'play' &&
    typeof value.cardId === 'string' &&
    (value.pile === 0 || value.pile === 1)
  );
}

function replenish(player: SpeedPlayerState): SpeedPlayerState {
  const needed = Math.min(5 - player.hand.length, player.stock.length);
  return {
    ...player,
    hand: [...player.hand, ...player.stock.slice(0, needed)],
    stock: player.stock.slice(needed),
  };
}

function recycleCenterPiles(state: SpeedState): SpeedState {
  const recyclable = [...state.centerPiles[0].slice(0, -1), ...state.centerPiles[1].slice(0, -1)];
  if (recyclable.length < 2) return state;
  const half = Math.floor(recyclable.length / 2);
  return {
    ...state,
    centerPiles: [
      [state.centerPiles[0][state.centerPiles[0].length - 1]!],
      [state.centerPiles[1][state.centerPiles[1].length - 1]!],
    ],
    reservePiles: [recyclable.slice(0, half), recyclable.slice(half)],
  };
}

export const speedRuleset: RealTimeRuleset<SpeedState, SpeedMove> = {
  game: SPEED_GAME_ID,
  name: 'Speed',

  createInitialState(players, first, seed = players.join(':')): SpeedState {
    const cards = speedDeck(seed);
    return {
      game: SPEED_GAME_ID,
      players,
      currentTurn: first,
      status: 'in_progress',
      winner: null,
      playerStates: [
        { player: players[0], hand: cards.slice(0, 5), stock: cards.slice(5, 20) },
        { player: players[1], hand: cards.slice(20, 25), stock: cards.slice(25, 40) },
      ],
      reservePiles: [cards.slice(40, 45), cards.slice(45, 50)],
      centerPiles: [[cards[50]!], [cards[51]!]],
      readyToFlip: [],
    };
  },

  applyMove(state, actor, move): Result<SpeedState, MoveError> {
    if (state.status !== 'in_progress') return err(invalidMove('Game is already over'));
    const playerIndex = state.playerStates.findIndex((player) => player.player === actor);
    if (playerIndex < 0) return err(invalidMove('Actor is not a participant'));
    if (!isMove(move)) return err(invalidMove('Unrecognized move'));

    if (move.type === 'play') {
      const player = state.playerStates[playerIndex]!;
      const cardIndex = player.hand.findIndex((card) => card.id === move.cardId);
      if (cardIndex < 0) return err(invalidMove('That card is not in your hand'));
      const card = player.hand[cardIndex]!;
      const target = state.centerPiles[move.pile];
      const top = target[target.length - 1];
      if (!top || !canPlaySpeedCard(card, top)) {
        return err(invalidMove('Play a card one rank higher or lower'));
      }

      const hand = player.hand.filter((_, index) => index !== cardIndex);
      const nextPlayer = replenish({ ...player, hand });
      const playerStates = [...state.playerStates] as [SpeedPlayerState, SpeedPlayerState];
      playerStates[playerIndex] = nextPlayer;
      const centerPiles = [...state.centerPiles] as [SpeedCard[], SpeedCard[]];
      centerPiles[move.pile] = [...target, card];
      const won = nextPlayer.hand.length === 0 && nextPlayer.stock.length === 0;
      return ok({
        ...state,
        playerStates,
        centerPiles,
        currentTurn: actor,
        status: won ? 'won' : 'in_progress',
        winner: won ? actor : null,
        readyToFlip: [],
      });
    }

    if (speedHasPlayableCard(state)) {
      return err(invalidMove('A card can still be played'));
    }

    const readyToFlip = [...new Set([...state.readyToFlip, actor])];
    if (readyToFlip.length < state.players.length) {
      return ok({ ...state, currentTurn: actor, readyToFlip });
    }

    let working: SpeedState = { ...state, readyToFlip: [] };
    if (working.reservePiles[0].length === 0 || working.reservePiles[1].length === 0) {
      working = recycleCenterPiles(working);
    }
    if (working.reservePiles[0].length === 0 || working.reservePiles[1].length === 0) {
      return ok({ ...working, status: 'draw', winner: null, currentTurn: actor });
    }

    const left = working.reservePiles[0][working.reservePiles[0].length - 1]!;
    const right = working.reservePiles[1][working.reservePiles[1].length - 1]!;
    return ok({
      ...working,
      currentTurn: actor,
      reservePiles: [working.reservePiles[0].slice(0, -1), working.reservePiles[1].slice(0, -1)],
      centerPiles: [
        [...working.centerPiles[0], left],
        [...working.centerPiles[1], right],
      ],
    });
  },

  isTerminal(state): boolean {
    return state.status !== 'in_progress';
  },

  outcome(state, recordedAt: Timestamp): GameOutcome | null {
    if (state.status === 'in_progress') return null;
    return { kind: 'completed', winner: state.winner, recordedAt };
  },
};

registerRuleset(speedRuleset);
