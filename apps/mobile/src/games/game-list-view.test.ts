import { describe, expect, it } from 'vitest';

import { sessionStateLabel, unfinishedGames } from './game-list-view';

describe('game list presentation', () => {
  it('keeps playable sessions and removes completed ones from Play', () => {
    const sessions = [
      { id: 'waiting', state: 'pending' },
      { id: 'playing', state: 'active' },
      { id: 'paused', state: 'paused' },
      { id: 'done', state: 'terminal' },
    ];
    expect(unfinishedGames(sessions).map((session) => session.id)).toEqual([
      'waiting',
      'playing',
      'paused',
    ]);
  });

  it('turns machine states into user-facing labels', () => {
    expect(sessionStateLabel('pending')).toBe('Waiting for partner');
    expect(sessionStateLabel('active')).toBe('In progress');
    expect(sessionStateLabel('paused')).toBe('Paused');
    expect(sessionStateLabel('terminal')).not.toBe('terminal');
  });
});
