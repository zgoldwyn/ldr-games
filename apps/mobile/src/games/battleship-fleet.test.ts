import { describe, expect, it } from 'vitest';

import {
  canAddShip,
  fleetCells,
  isCompleteFleet,
  nextShipLength,
  placementOverlaps,
  shipAt,
} from './battleship-fleet';

describe('battleship placement', () => {
  it('builds horizontal and vertical ships from a tapped bow cell', () => {
    expect(shipAt(2, 3, 3, 'horizontal')).toEqual([
      { row: 2, col: 3 },
      { row: 2, col: 4 },
      { row: 2, col: 5 },
    ]);
    expect(shipAt(2, 3, 2, 'vertical')).toEqual([
      { row: 2, col: 3 },
      { row: 3, col: 3 },
    ]);
  });

  it('refuses overlap and placements extending off the board', () => {
    const fleet = [shipAt(0, 0, 5, 'horizontal')];
    expect(placementOverlaps(fleet, shipAt(0, 3, 4, 'vertical'))).toBe(true);
    expect(canAddShip(fleet, shipAt(0, 3, 4, 'vertical'))).toBe(false);
    expect(canAddShip(fleet, shipAt(8, 0, 3, 'vertical'))).toBe(false);
    expect(canAddShip(fleet, shipAt(2, 0, 4, 'horizontal'))).toBe(true);
  });

  it('tracks the classic fleet order and recognizes completion', () => {
    const fleet = [
      shipAt(0, 0, 5, 'horizontal'),
      shipAt(2, 0, 4, 'horizontal'),
      shipAt(4, 0, 3, 'horizontal'),
      shipAt(6, 0, 3, 'horizontal'),
      shipAt(8, 0, 2, 'horizontal'),
    ];
    expect(nextShipLength([])).toBe(5);
    expect(nextShipLength(fleet)).toBeUndefined();
    expect(fleetCells(fleet)).toHaveLength(17);
    expect(isCompleteFleet(fleet)).toBe(true);
  });
});
