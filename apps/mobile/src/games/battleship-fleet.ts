import type { Cell } from '@ldr/core';

/**
 * Classic Battleship fleet on a 10×10 grid: 5, 4, 3, 3, 2.
 *
 * `async-start` requires a non-empty fleet for BOTH partners in one request —
 * there is no placement endpoint — so the shell auto-places this layout for
 * each player rather than inventing a placement UI in this task.
 */
export function classicFleet(): readonly Cell[] {
  const ship = (row: number, col: number, length: number): Cell[] =>
    Array.from({ length }, (_, i) => ({ row, col: col + i }));

  return [...ship(0, 0, 5), ...ship(2, 0, 4), ...ship(4, 0, 3), ...ship(6, 0, 3), ...ship(8, 0, 2)];
}
