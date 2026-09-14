import type { AccountId } from '@ldr/core';

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export function ticTacToeBoardLayout(viewportWidth: number): {
  readonly boardSize: number;
  readonly cellSize: number;
} {
  const horizontalScreenPadding = 64;
  const availableWidth = Math.max(0, viewportWidth - horizontalScreenPadding);
  const boardSize = Math.min(288, availableWidth);
  return {
    boardSize,
    cellSize: boardSize / 3,
  };
}

/** Marks for the two roster slots. Empty cells render as a blank. */
export function markForCell(
  occupant: AccountId | null,
  players: readonly [AccountId, AccountId],
): 'X' | 'O' | '' {
  if (occupant === null) return '';
  if (occupant === players[0]) return 'X';
  if (occupant === players[1]) return 'O';
  return '';
}

export function markForPlayer(
  player: AccountId | undefined,
  players: readonly [AccountId, AccountId] | undefined,
): 'X' | 'O' | '' {
  if (player === undefined || players === undefined) return '';
  return markForCell(player, players);
}

export function winningCells(board: readonly (AccountId | null)[]): readonly number[] {
  const line = WINNING_LINES.find(([a, b, c]) => {
    const mark = board[a];
    return mark !== null && mark !== undefined && mark === board[b] && mark === board[c];
  });
  return line ?? [];
}

export function ticTacToeStatus(params: {
  readonly sessionState: 'pending' | 'active' | 'paused' | 'terminal' | undefined;
  readonly boardStatus: 'in_progress' | 'won' | 'draw' | undefined;
  readonly currentTurn: AccountId | undefined;
  readonly winner: AccountId | null | undefined;
  readonly self: AccountId | undefined;
}): { readonly title: string; readonly detail: string } {
  const { sessionState, boardStatus, currentTurn, winner, self } = params;
  if (sessionState === undefined) {
    return { title: 'Loading game…', detail: 'Getting the latest board.' };
  }
  if (sessionState === 'pending') {
    return { title: 'Waiting for your partner', detail: 'The game begins when they join.' };
  }
  if (sessionState === 'paused') {
    return { title: 'Game paused', detail: 'Rejoin when you are both ready.' };
  }
  if (sessionState === 'terminal' || boardStatus === 'won' || boardStatus === 'draw') {
    if (boardStatus === 'draw') {
      return { title: 'It’s a draw', detail: 'Good game — neither side took the board.' };
    }
    if (winner !== null && winner !== undefined && self !== undefined) {
      return winner === self
        ? { title: 'You won!', detail: 'Three in a row. Nicely played.' }
        : { title: 'Your partner won', detail: 'Good game — time for a rematch.' };
    }
    return { title: 'Game finished', detail: 'This match is complete.' };
  }
  if (self !== undefined && currentTurn === self) {
    return { title: 'Your turn', detail: 'Choose any open square.' };
  }
  return { title: 'Partner’s turn', detail: 'Their move is up next.' };
}
