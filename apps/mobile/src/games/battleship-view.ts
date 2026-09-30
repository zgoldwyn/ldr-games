import type { AccountId } from '@ldr/core';

export function battleshipStatus(params: {
  readonly sessionState: 'active' | 'terminal' | undefined;
  readonly phase: 'placement' | 'playing';
  readonly fleetSubmitted: boolean;
  readonly myTurn: boolean;
  readonly winner: AccountId | null | undefined;
  readonly self: AccountId | undefined;
  readonly partnerName?: string;
}): { readonly title: string; readonly detail: string } {
  const { sessionState, phase, fleetSubmitted, myTurn, winner, self, partnerName } = params;
  const partner = partnerName?.trim() || 'your partner';
  const partnerTitle = partnerName?.trim() || 'Partner';
  const partnerWinner = partnerName?.trim() || 'Your partner';
  if (sessionState === undefined) {
    return { title: 'Loading game…', detail: 'Getting the latest waters.' };
  }
  if (sessionState === 'terminal') {
    return winner !== null && winner !== undefined && winner === self
      ? { title: 'You won!', detail: 'Their fleet is sunk.' }
      : { title: `${partnerWinner} won`, detail: 'Your fleet is sunk. Good game.' };
  }
  if (phase === 'placement') {
    return fleetSubmitted
      ? { title: 'Fleet ready', detail: `Waiting for ${partner} to place theirs.` }
      : { title: 'Place your fleet', detail: 'Position all five ships, then lock them in.' };
  }
  return myTurn
    ? { title: 'Your turn', detail: 'Choose a square in their waters.' }
    : { title: `${partnerTitle}’s turn`, detail: 'We’ll update the board after their shot.' };
}

export function battleshipTurnError(params: {
  readonly code: string;
  readonly phase: 'placement' | 'playing';
  readonly myTurn: boolean;
  readonly alreadyTargeted: boolean;
  readonly terminal: boolean;
  readonly partnerName?: string;
}): string | null {
  if (params.terminal) return 'This game is already finished.';
  if (params.phase !== 'playing') return 'Both fleets must be ready before the first shot.';
  if (!params.myTurn) {
    return params.partnerName?.trim()
      ? `${params.partnerName.trim()} is taking this turn.`
      : 'Your partner is taking this turn.';
  }
  if (params.alreadyTargeted) return 'You already targeted that square. Choose another one.';
  if (params.code === 'INVALID_TURN') {
    return 'That shot could not be placed. Choose another square.';
  }
  return null;
}
