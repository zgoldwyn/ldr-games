import { describe, expect, it } from 'vitest';

// The Level Forge server uses a dependency-free JavaScript module.
// @ts-expect-error Server JavaScript module has no generated declaration.
import { planWorkspaceCatalogPublication } from '../catalog-update.mjs';

const live = [
  { id: 'first', number: 1, chapter: 'Level 1', name: 'First' },
  { id: 'second', number: 2, chapter: 'Level 2', name: 'Second' },
  { id: 'third', number: 3, chapter: 'Level 3', name: 'Third' },
];

function nextId() {
  let value = 0;
  return () => String(++value);
}

describe('whole-tree level publishing', () => {
  it('publishes all workspace edits in number order with new IDs', () => {
    const workspace = [
      { ...live[0], name: 'Edited First' },
      { ...live[1], name: 'Edited Second' },
      { ...live[2], name: 'Edited Third' },
    ];
    const plan = planWorkspaceCatalogPublication(live, workspace, 1, nextId());
    expect(plan.levels.map((item: { name: string }) => item.name)).toEqual([
      'Edited First',
      'Edited Second',
      'Edited Third',
    ]);
    expect(plan.levels.map((item: { id: string }) => item.id)).toEqual([
      'level-1-1',
      'level-2-2',
      'level-3-3',
    ]);
    expect(plan.activeNumber).toBe(2);
  });

  it('inserts a new workspace level and shifts existing live levels', () => {
    const workspace = [live[0], { id: 'new', number: 2, name: 'New' }, live[1], live[2]].map(
      (item, index) => ({ ...item, number: index + 1 }),
    );
    const plan = planWorkspaceCatalogPublication(live, workspace, 1, nextId());
    expect(plan.levels.map((item: { name: string }) => item.name)).toEqual([
      'First',
      'New',
      'Second',
      'Third',
    ]);
    expect(plan.activeNumber).toBe(2);
    expect(plan.preservedLiveCount).toBe(0);
  });

  it('keeps the original when a copied live level is positioned beyond the live tree', () => {
    const workspace = [live[0], live[1], { ...live[2], number: 4, name: 'New Keep' }];
    const plan = planWorkspaceCatalogPublication(live, workspace, 2, nextId());
    expect(plan.levels.map((item: { name: string }) => item.name)).toEqual([
      'First',
      'Second',
      'Third',
      'New Keep',
    ]);
    expect(plan.activeNumber).toBe(4);
    expect(plan.preservedLiveCount).toBe(1);
  });

  it('preserves live levels absent from the workspace', () => {
    const plan = planWorkspaceCatalogPublication(
      live,
      [{ ...live[1], name: 'Edited Second' }],
      0,
      nextId(),
    );
    expect(plan.levels.map((item: { name: string }) => item.name)).toEqual([
      'First',
      'Edited Second',
      'Third',
    ]);
    expect(plan.preservedLiveCount).toBe(2);
  });

  it('issues different IDs on each publish', () => {
    const first = planWorkspaceCatalogPublication(live, live, 0, nextId());
    const second = planWorkspaceCatalogPublication(
      first.levels,
      first.levels,
      0,
      () => 'different',
    );
    expect(second.levels.map((item: { id: string }) => item.id)).not.toEqual(
      first.levels.map((item: { id: string }) => item.id),
    );
  });

  it('rejects ambiguous numbering instead of silently dropping a level', () => {
    expect(() => planWorkspaceCatalogPublication(live, [live[0], live[0]], 0)).toThrow(/unique/);
    expect(() => planWorkspaceCatalogPublication(live, [{ ...live[0], number: 99 }], 0)).toThrow(
      /gap/,
    );
    expect(() => planWorkspaceCatalogPublication(live, live, 99)).toThrow(/active/);
  });
});
