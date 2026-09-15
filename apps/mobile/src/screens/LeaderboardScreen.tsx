import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useApp } from '../app-context';
import { buildPairLeaderboard } from '../games/leaderboard';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';

const gameName = (id: string) =>
  id === 'tic-tac-toe' ? 'Tic-tac-toe' : id === 'battleship' ? 'Battleship' : id;

export function LeaderboardScreen() {
  const { runtime, identity, tokens } = useApp();
  const [, setTick] = useState(0);

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(
    () => runtime.asyncGames.subscribe(() => setTick((value) => value + 1)),
    [runtime.asyncGames],
  );

  const pairing = identity.pairing;
  const self = identity.session?.accountId;
  if (pairing === null || self === undefined) return null;
  const leaderboard = buildPairLeaderboard(pairing.memberA, pairing.memberB, [
    ...runtime.rt.list(),
    ...runtime.asyncGames.list(),
  ]);

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          {leaderboard.completedGames} completed games · {leaderboard.draws} draws
        </AppText>
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
                {standing.accountId === self ? 'You' : 'Partner'}
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
        {leaderboard.games.length === 0 ? (
          <AppText kind="muted" tokens={tokens}>
            Finish a game to start the leaderboard.
          </AppText>
        ) : (
          leaderboard.games.map((game) => {
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
                  You {myWins} · Partner {partnerWins} · Draws {game.draws}
                </AppText>
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 32 },
  lead: { marginBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    padding: 20,
    marginBottom: 16,
  },
  name: { flex: 1, marginLeft: 16, flexDirection: 'row', justifyContent: 'space-between' },
  section: { marginTop: 24, marginBottom: 12 },
  game: { borderRadius: 20, padding: 16, gap: 4, marginBottom: 16 },
});
