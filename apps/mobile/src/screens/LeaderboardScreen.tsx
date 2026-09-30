import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useApp } from '../app-context';
import { buildPairLeaderboard } from '../games/leaderboard';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';
import { PartnerPresencePill } from '../ui/PartnerPresencePill';
import { MainPageMarker } from '../ui/MainPageMarker';

const gameName = (id: string) =>
  id === 'tic-tac-toe'
    ? 'Tic-tac-toe'
    : id === 'battleship'
      ? 'Battleship'
      : id === 'draw-together'
        ? 'Draw Together'
        : id === 'speed'
          ? 'Speed'
          : id;

function scoreDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function LeaderboardScreen() {
  const { runtime, identity, accountDetails, tokens } = useApp();
  const [, setTick] = useState(0);
  const [drawTogetherScores, setDrawTogetherScores] = useState<
    readonly { duration: number; score: number; achievedAt: number }[]
  >([]);

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(
    () => runtime.asyncGames.subscribe(() => setTick((value) => value + 1)),
    [runtime.asyncGames],
  );

  const pairing = identity.pairing;
  const self = identity.session?.accountId;

  useEffect(() => {
    if (pairing === null) {
      setDrawTogetherScores([]);
      return;
    }
    let active = true;
    void runtime.client
      .from('draw_together_best_scores')
      .select('duration_seconds, score, achieved_at')
      .eq('pairing_id', pairing.id)
      .order('duration_seconds')
      .then(({ data }) => {
        if (!active) return;
        setDrawTogetherScores(
          (data ?? []).map((row) => ({
            duration: Number(row.duration_seconds),
            score: Number(row.score),
            achievedAt: new Date(String(row.achieved_at)).getTime(),
          })),
        );
      });
    return () => {
      active = false;
    };
  }, [pairing, runtime.client]);

  if (pairing === null || self === undefined) return null;
  const leaderboard = buildPairLeaderboard(pairing.memberA, pairing.memberB, [
    ...runtime.rt.list(),
    ...runtime.asyncGames.list(),
  ]);

  return (
    <Screen
      tokens={tokens}
      topInset
      bottomInset={false}
      bottomPadding={false}
      horizontalPadding={false}
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <PartnerPresencePill />
        <MainPageMarker
          title="Pair scoreboard"
          detail={`${leaderboard.completedGames} finished · ${leaderboard.draws} draws`}
          tokens={tokens}
        />
        {leaderboard.standings.map((standing) => (
          <View
            key={standing.accountId}
            style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}
          >
            <AppText kind="title" tokens={tokens}>
              #{standing.rank}
            </AppText>
            <View style={styles.name}>
              <AppText kind="body" tokens={tokens}>
                {standing.accountId === self
                  ? (accountDetails?.selfProfile?.displayName ?? 'You')
                  : (accountDetails?.partnerProfile?.displayName ?? 'Partner')}
              </AppText>
              <AppText kind="label" tokens={tokens}>
                {standing.wins} wins
              </AppText>
            </View>
          </View>
        ))}

        <AppText kind="label" tokens={tokens} style={styles.section}>
          By game
        </AppText>
        {leaderboard.games.length === 0 && drawTogetherScores.length === 0 ? (
          <AppText kind="muted" tokens={tokens}>
            Finish a game to start the leaderboard.
          </AppText>
        ) : (
          leaderboard.games
            .filter((game) => game.gameId !== 'draw-together')
            .map((game) => {
              const myWins = self === pairing.memberA ? game.memberAWins : game.memberBWins;
              const partnerWins = self === pairing.memberA ? game.memberBWins : game.memberAWins;
              return (
                <View
                  key={game.gameId}
                  style={[
                    styles.game,
                    clayRaisedStyle(tokens, true),
                    { backgroundColor: tokens.surfaceMuted },
                  ]}
                >
                  <AppText kind="body" tokens={tokens}>
                    {gameName(game.gameId)}
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    You {myWins} · {accountDetails?.partnerProfile?.displayName ?? 'Partner'}{' '}
                    {partnerWins} · Draws {game.draws}
                  </AppText>
                </View>
              );
            })
        )}
        {drawTogetherScores.length > 0 ? (
          <View
            style={[
              styles.game,
              clayRaisedStyle(tokens, true),
              { backgroundColor: tokens.surfaceMuted },
            ]}
          >
            <AppText kind="body" tokens={tokens}>
              Draw Together
            </AppText>
            {drawTogetherScores.map((score) => (
              <AppText key={score.duration} kind="muted" tokens={tokens}>
                {score.duration / 60} min · High score: {score.score} on{' '}
                {scoreDate(score.achievedAt)}
              </AppText>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 32, gap: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    padding: 20,
  },
  name: { flex: 1, marginLeft: 16, flexDirection: 'row', justifyContent: 'space-between' },
  section: { marginTop: 8, marginBottom: -4 },
  game: { borderRadius: 20, padding: 16, gap: 4 },
});
