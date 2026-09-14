import type { AccountId, AsyncSession, RTSession } from '@ldr/core';

export interface GameStanding {
  readonly gameId: string;
  readonly memberAWins: number;
  readonly memberBWins: number;
  readonly draws: number;
}

export interface LeaderboardStanding {
  readonly accountId: AccountId;
  readonly wins: number;
  readonly rank: number;
}

export interface PairLeaderboard {
  readonly standings: readonly LeaderboardStanding[];
  readonly games: readonly GameStanding[];
  readonly draws: number;
  readonly completedGames: number;
}

export function buildPairLeaderboard(
  memberA: AccountId,
  memberB: AccountId,
  sessions: readonly (RTSession | AsyncSession)[],
): PairLeaderboard {
  const wins = new Map<AccountId, number>([
    [memberA, 0],
    [memberB, 0],
  ]);
  const games = new Map<string, Omit<GameStanding, 'gameId'>>();
  let draws = 0;
  let completedGames = 0;

  for (const session of sessions) {
    if (session.state !== 'terminal' || session.outcome?.kind !== 'completed') continue;
    completedGames += 1;
    const current = games.get(session.gameId) ?? { memberAWins: 0, memberBWins: 0, draws: 0 };
    if (session.outcome.winner === memberA) {
      wins.set(memberA, (wins.get(memberA) ?? 0) + 1);
      games.set(session.gameId, { ...current, memberAWins: current.memberAWins + 1 });
    } else if (session.outcome.winner === memberB) {
      wins.set(memberB, (wins.get(memberB) ?? 0) + 1);
      games.set(session.gameId, { ...current, memberBWins: current.memberBWins + 1 });
    } else {
      draws += 1;
      games.set(session.gameId, { ...current, draws: current.draws + 1 });
    }
  }

  const ordered = [memberA, memberB].sort((left, right) => {
    const delta = (wins.get(right) ?? 0) - (wins.get(left) ?? 0);
    return delta === 0 ? left.localeCompare(right) : delta;
  });
  const standings = ordered.map((accountId, index) => ({
    accountId,
    wins: wins.get(accountId) ?? 0,
    rank: index > 0 && wins.get(accountId) === wins.get(ordered[index - 1]!) ? index : index + 1,
  }));

  return {
    standings,
    games: [...games].map(([gameId, standing]) => ({ gameId, ...standing })),
    draws,
    completedGames,
  };
}
