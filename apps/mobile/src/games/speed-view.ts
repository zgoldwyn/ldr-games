import {
  canPlaySpeedCard,
  SPEED_GAME_ID,
  type AccountId,
  type SpeedCard,
  type SpeedState,
} from '@ldr/core';

export function asSpeedState(value: unknown): SpeedState | null {
  if (value === null || typeof value !== 'object') return null;
  const state = value as Partial<SpeedState>;
  if (state.game !== SPEED_GAME_ID) return null;
  if (!Array.isArray(state.players) || state.players.length !== 2) return null;
  if (!Array.isArray(state.playerStates) || state.playerStates.length !== 2) return null;
  if (!Array.isArray(state.centerPiles) || state.centerPiles.length !== 2) return null;
  if (!Array.isArray(state.readyToFlip)) return null;
  return state as SpeedState;
}

export function speedPlayer(state: SpeedState, account: AccountId | undefined) {
  return state.playerStates.find((player) => player.player === account);
}

export function legalPileForCard(state: SpeedState, card: SpeedCard): 0 | 1 | null {
  const left = state.centerPiles[0].at(-1);
  const right = state.centerPiles[1].at(-1);
  if (left && canPlaySpeedCard(card, left)) return 0;
  if (right && canPlaySpeedCard(card, right)) return 1;
  return null;
}

export function rankLabel(rank: number): string {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

export function suitSymbol(suit: SpeedCard['suit']): string {
  if (suit === 'clubs') return '♣';
  if (suit === 'diamonds') return '♦';
  if (suit === 'hearts') return '♥';
  return '♠';
}

export function speedStatus(params: {
  readonly sessionState: 'pending' | 'active' | 'paused' | 'terminal' | undefined;
  readonly state: SpeedState | null;
  readonly self: AccountId | undefined;
  readonly partnerName?: string;
}): { readonly title: string; readonly detail: string } {
  const { sessionState, state, self, partnerName } = params;
  const partner = partnerName?.trim() || 'your partner';
  if (!sessionState) return { title: 'Loading table…', detail: 'Getting the latest cards.' };
  if (sessionState === 'pending') {
    return { title: `Waiting for ${partner}`, detail: 'Speed starts when they join.' };
  }
  if (sessionState === 'paused') {
    return { title: 'Game paused', detail: 'Rejoin when you are both ready.' };
  }
  if (sessionState === 'terminal' || state?.status === 'won' || state?.status === 'draw') {
    if (state?.status === 'draw') return { title: 'Dead heat', detail: 'No cards remain to flip.' };
    return state?.winner === self
      ? { title: 'You won!', detail: 'Your hand is empty. Lightning fast.' }
      : { title: `${partnerName?.trim() || 'Your partner'} won`, detail: 'Ready for a rematch?' };
  }
  return { title: 'Go!', detail: 'Tap a card one rank above or below either center card.' };
}
