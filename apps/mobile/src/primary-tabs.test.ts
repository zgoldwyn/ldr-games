import { describe, expect, it } from 'vitest';

import { PRIMARY_TABS, primaryTab } from './primary-tabs';

describe('primary bottom navigation', () => {
  it('keeps each primary destination in one stable tab slot', () => {
    expect(PRIMARY_TABS.map((tab) => tab.route)).toEqual(['GameList', 'Leaderboard', 'Settings']);
    expect(new Set(PRIMARY_TABS.map((tab) => tab.route)).size).toBe(PRIMARY_TABS.length);
  });

  it('uses concise visible labels for every destination', () => {
    expect(primaryTab('GameList').label).toBe('Play');
    expect(PRIMARY_TABS.every((tab) => tab.label.length > 0 && tab.icon.length > 0)).toBe(true);
  });
});
