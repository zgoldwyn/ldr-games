import type { AccountId } from '@ldr/core';

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
