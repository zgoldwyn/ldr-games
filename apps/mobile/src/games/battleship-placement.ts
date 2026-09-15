import type { BattleshipFleet, Cell, ShipPlacement } from '@ldr/core';

import { canAddShip, shipAt, type ShipOrientation } from './battleship-fleet';

export type DraftShipId = 'carrier' | 'battleship' | 'cruiser' | 'submarine' | 'destroyer';

export interface DraftShip {
  readonly id: DraftShipId;
  readonly name: string;
  readonly length: number;
  readonly orientation: ShipOrientation;
  readonly placement: ShipPlacement | null;
}

const SHIP_DEFINITIONS: readonly Omit<DraftShip, 'orientation' | 'placement'>[] = [
  { id: 'carrier', name: 'Carrier', length: 5 },
  { id: 'battleship', name: 'Battleship', length: 4 },
  { id: 'cruiser', name: 'Cruiser', length: 3 },
  { id: 'submarine', name: 'Submarine', length: 3 },
  { id: 'destroyer', name: 'Destroyer', length: 2 },
];

function orientationFor(placement: ShipPlacement): ShipOrientation {
  return placement.length > 1 && placement[0]?.col === placement[1]?.col
    ? 'vertical'
    : 'horizontal';
}

export function createDraftShips(fleet?: BattleshipFleet): readonly DraftShip[] {
  const unmatched = [...(fleet ?? [])];
  return SHIP_DEFINITIONS.map((definition) => {
    const index = unmatched.findIndex((placement) => placement.length === definition.length);
    const placement = index < 0 ? null : unmatched.splice(index, 1)[0]!;
    return {
      ...definition,
      orientation: placement === null ? 'horizontal' : orientationFor(placement),
      placement,
    };
  });
}

export function fleetFromDraft(ships: readonly DraftShip[]): BattleshipFleet {
  return ships.flatMap((ship) => (ship.placement === null ? [] : [ship.placement]));
}

export function placedShipCount(ships: readonly DraftShip[]): number {
  return ships.filter((ship) => ship.placement !== null).length;
}

/** Explicit rows prevent flex-wrap rounding from turning a 10×10 board into 9 columns. */
export function battleshipGridRows(size = 10): readonly (readonly Cell[])[] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({ row, col })),
  );
}

function candidateAnchors(
  row: number,
  col: number,
  size: number,
  orientation: ShipOrientation,
): readonly (readonly [number, number])[] {
  return Array.from({ length: size * size }, (_, index) => {
    const candidateRow = Math.floor(index / size);
    const candidateCol = index % size;
    return [candidateRow, candidateCol] as const;
  }).sort(([rowA, colA], [rowB, colB]) => {
    const distanceA = Math.abs(rowA - row) + Math.abs(colA - col);
    const distanceB = Math.abs(rowB - row) + Math.abs(colB - col);
    const crossAxisA = orientation === 'horizontal' ? Math.abs(rowA - row) : Math.abs(colA - col);
    const crossAxisB = orientation === 'horizontal' ? Math.abs(rowB - row) : Math.abs(colB - col);
    return distanceA - distanceB || crossAxisA - crossAxisB || rowA - rowB || colA - colB;
  });
}

export function placeDraftShipNearest(
  ships: readonly DraftShip[],
  id: DraftShipId,
  requestedRow: number,
  requestedCol: number,
  orientation: ShipOrientation,
  size = 10,
): { readonly ships: readonly DraftShip[]; readonly placement: ShipPlacement | null } {
  const moving = ships.find((ship) => ship.id === id);
  if (moving === undefined) return { ships, placement: null };

  const otherFleet = fleetFromDraft(ships.filter((ship) => ship.id !== id));
  for (const [row, col] of candidateAnchors(requestedRow, requestedCol, size, orientation)) {
    const placement = shipAt(row, col, moving.length, orientation);
    if (!canAddShip(otherFleet, placement, size)) continue;
    return {
      placement,
      ships: ships.map((ship) => (ship.id === id ? { ...ship, orientation, placement } : ship)),
    };
  }
  return { ships, placement: null };
}

export function rotateDraftShipNearest(
  ships: readonly DraftShip[],
  id: DraftShipId,
  size = 10,
): { readonly ships: readonly DraftShip[]; readonly placement: ShipPlacement | null } {
  const moving = ships.find((ship) => ship.id === id);
  if (moving === undefined) return { ships, placement: null };
  const orientation: ShipOrientation =
    moving.orientation === 'horizontal' ? 'vertical' : 'horizontal';
  if (moving.placement === null) {
    return {
      placement: null,
      ships: ships.map((ship) => (ship.id === id ? { ...ship, orientation } : ship)),
    };
  }
  const anchor = moving.placement[0]!;
  return placeDraftShipNearest(ships, id, anchor.row, anchor.col, orientation, size);
}

export function shipForCell(
  ships: readonly DraftShip[],
  row: number,
  col: number,
): DraftShip | undefined {
  return ships.find((ship) => ship.placement?.some((cell) => cell.row === row && cell.col === col));
}
