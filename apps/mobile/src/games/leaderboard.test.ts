import { describe, expect, it } from 'vitest';
import {
  accountId,
  gameId,
  pairingId,
  sessionId,
  type AsyncSession,
  type RTSession,
} from '@ldr/core';

import { buildPairLeaderboard } from './leaderboard';

const a = accountId('a');
const b = accountId('b');
const base = {
  pairingId: pairingId('pair'),
  state: 'terminal' as const,
  gameState: {},
};

function rt(id: string, winner: typeof a | typeof b | null, kind = 'completed'): RTSession {
  return {
    ...base,
    id: sessionId(id),
    gameId: gameId('tic-tac-toe'),
    outcome: { kind: kind as 'completed', winner, recordedAt: 1 },
  };
}

function asyncGame(id: string, winner: typeof a | typeof b | null): AsyncSession {
  return {
    ...base,
    id: sessionId(id),
    gameId: gameId('battleship'),
    activeTurnHolder: a,
    turnPendingSince: 1,
    outcome: { kind: 'completed', winner, recordedAt: 1 },
  };
}

describe('pair leaderboard', () => {
  it('ranks both partners by completed-game wins and groups each game', () => {
    const result = buildPairLeaderboard(a, b, [
      rt('1', a),
      rt('2', null),
      asyncGame('3', b),
      rt('4', a),
    ]);
    expect(result.standings).toEqual([
      { accountId: a, wins: 2, rank: 1 },
      { accountId: b, wins: 1, rank: 2 },
    ]);
    expect(result.completedGames).toBe(4);
    expect(result.draws).toBe(1);
    expect(result.games).toEqual(
      expect.arrayContaining([
        { gameId: 'tic-tac-toe', memberAWins: 2, memberBWins: 0, draws: 1 },
        { gameId: 'battleship', memberAWins: 0, memberBWins: 1, draws: 0 },
      ]),
    );
  });

  it('ignores unfinished and ended-without-outcome sessions', () => {
    const pending = { ...rt('1', a), state: 'pending' as const };
    const ended = rt('2', a, 'ended_without_outcome');
    expect(buildPairLeaderboard(a, b, [pending, ended]).completedGames).toBe(0);
  });

  it('uses a shared first-place rank when wins are tied', () => {
    expect(buildPairLeaderboard(a, b, []).standings.map((row) => row.rank)).toEqual([1, 1]);
  });
});
