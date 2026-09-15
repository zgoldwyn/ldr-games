import { describe, expect, it } from 'vitest';

import {
  createDraftShips,
  fleetFromDraft,
  placeDraftShipNearest,
  placedShipCount,
  rotateDraftShipNearest,
  shipForCell,
} from './battleship-placement';

describe('Battleship drag placement', () => {
  it('starts with a five-ship bank and accepts ships in any order', () => {
    const bank = createDraftShips();
    expect(bank.map((ship) => ship.length)).toEqual([5, 4, 3, 3, 2]);
    const placed = placeDraftShipNearest(bank, 'destroyer', 8, 8, 'horizontal');
    expect(placed.placement).toEqual([
      { row: 8, col: 8 },
      { row: 8, col: 9 },
    ]);
    expect(placedShipCount(placed.ships)).toBe(1);
  });

  it('snaps an off-grid drop to the closest legal anchor', () => {
    const result = placeDraftShipNearest(createDraftShips(), 'carrier', 9, 9, 'horizontal');
    expect(result.placement?.[0]).toEqual({ row: 9, col: 5 });
    expect(result.placement?.at(-1)).toEqual({ row: 9, col: 9 });
  });

  it('moves a colliding ship to the nearest available position', () => {
    const first = placeDraftShipNearest(createDraftShips(), 'carrier', 0, 0, 'horizontal');
    const second = placeDraftShipNearest(first.ships, 'battleship', 0, 0, 'horizontal');
    expect(second.placement?.[0]).toEqual({ row: 1, col: 0 });
    expect(
      new Set(
        fleetFromDraft(second.ships)
          .flat()
          .map((cell) => `${cell.row},${cell.col}`),
      ).size,
    ).toBe(9);
  });

  it('rotates in place when legal and finds the nearest legal spot when blocked', () => {
    const carrier = placeDraftShipNearest(createDraftShips(), 'carrier', 0, 0, 'horizontal');
    const battleship = placeDraftShipNearest(carrier.ships, 'battleship', 1, 0, 'horizontal');
    const rotated = rotateDraftShipNearest(battleship.ships, 'battleship');
    expect(rotated.ships.find((ship) => ship.id === 'battleship')?.orientation).toBe('vertical');
    expect(rotated.placement?.[0]).toEqual({ row: 1, col: 0 });
    expect(shipForCell(rotated.ships, 4, 0)?.id).toBe('battleship');
  });

  it('restores stable ship identities from a saved fleet', () => {
    const placed = placeDraftShipNearest(createDraftShips(), 'submarine', 5, 4, 'vertical');
    const restored = createDraftShips(fleetFromDraft(placed.ships));
    expect(restored.find((ship) => ship.id === 'cruiser')?.placement).not.toBeNull();
    expect(placedShipCount(restored)).toBe(1);
  });
});
