import {
  BATTLESHIP_FLEET_LENGTHS,
  validateBattleshipFleet,
  type BattleshipFleet,
  type Cell,
  type ShipPlacement,
} from '@ldr/core';

export type ShipOrientation = 'horizontal' | 'vertical';

export function shipAt(
  row: number,
  col: number,
  length: number,
  orientation: ShipOrientation,
): ShipPlacement {
  return Array.from({ length }, (_, offset) => ({
    row: row + (orientation === 'vertical' ? offset : 0),
    col: col + (orientation === 'horizontal' ? offset : 0),
  }));
}

export function placementOverlaps(fleet: BattleshipFleet, ship: ShipPlacement): boolean {
  const occupied = new Set(fleet.flat().map((cell) => `${cell.row},${cell.col}`));
  return ship.some((cell) => occupied.has(`${cell.row},${cell.col}`));
}

export function canAddShip(fleet: BattleshipFleet, ship: ShipPlacement, size = 10): boolean {
  return (
    ship.every((cell) => cell.row >= 0 && cell.row < size && cell.col >= 0 && cell.col < size) &&
    !placementOverlaps(fleet, ship)
  );
}

export function nextShipLength(fleet: BattleshipFleet): number | undefined {
  return BATTLESHIP_FLEET_LENGTHS[fleet.length];
}

export function fleetCells(fleet: BattleshipFleet | undefined): readonly Cell[] {
  return fleet?.flat() ?? [];
}

export function isCompleteFleet(fleet: BattleshipFleet): boolean {
  return validateBattleshipFleet(fleet).ok;
}
