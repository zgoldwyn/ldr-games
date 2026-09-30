import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { BATTLESHIP_GAME_ID, isErr, type QuizDef, type QuizSession } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { SwipeableGameRow } from '../ui/SwipeableGameRow';
import { clayRaisedStyle } from '../ui/clay';
import { PartnerPresencePill } from '../ui/PartnerPresencePill';
import { MainPageMarker } from '../ui/MainPageMarker';

export function AsyncGamesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, tokens } = useApp();
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [quizzes, setQuizzes] = useState<readonly QuizDef[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const self = identity.session?.accountId;

  useEffect(
    () => runtime.asyncGames.subscribe(() => setTick((value) => value + 1)),
    [runtime.asyncGames],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void runtime.asyncGames.refresh();
      const refreshQuiz = () => {
        void Promise.all([runtime.quiz.activeSession(), runtime.quiz.listQuizzes()]).then(
          ([session, catalog]) => {
            if (!active) return;
            setActiveQuiz(session);
            setQuizzes(catalog);
          },
        );
      };
      refreshQuiz();
      const interval = setInterval(refreshQuiz, 5_000);
      return () => {
        active = false;
        clearInterval(interval);
      };
    }, [runtime.asyncGames, runtime.quiz]),
  );

  const sessions = runtime.asyncGames
    .list()
    .filter((item) => item.state === 'active' && item.pairingId === identity.pairing?.id);
  const gameNames = new Map(runtime.asyncGames.listGames().map((game) => [game.id, game.name]));

  async function deleteGame(rawId: string) {
    const session = sessions.find((item) => item.id === rawId);
    if (session === undefined) return;
    setDeleting(rawId);
    setError(null);
    try {
      const result = await runtime.asyncGames.deleteSession(session.id);
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setDeleting(null);
    }
  }

  function confirmDelete(rawId: string, name: string) {
    Alert.alert(
      `Delete ${name}?`,
      'This permanently removes the game and its data for both you and your partner.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete game', style: 'destructive', onPress: () => void deleteGame(rawId) },
      ],
    );
  }

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
        <MainPageMarker title="In progress" tokens={tokens} />

        {activeQuiz !== null ? (
          <View style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
            <AppText kind="label" tokens={tokens}>
              COUPLES QUIZ
            </AppText>
            <AppText kind="body" tokens={tokens} style={styles.name}>
              {quizzes.find((quiz) => quiz.id === activeQuiz.quizId)?.theme ?? 'Quiz in progress'}
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.detail}>
              {activeQuiz.phase === 'guessing' ? 'Guessing round' : 'Private answers'}
            </AppText>
            <AppButton
              label="Continue quiz"
              tokens={tokens}
              onPress={() => navigation.navigate('CouplesQuiz', { sessionId: activeQuiz.id })}
            />
          </View>
        ) : null}

        {sessions.map((item) => {
          const name = gameNames.get(item.gameId) ?? 'Game';
          const myTurn = self !== undefined && runtime.asyncGames.isMyTurn(item.id, self);
          return (
            <SwipeableGameRow
              key={item.id}
              tokens={tokens}
              disabled={deleting === item.id}
              accessibilityLabel={`${name}, ${myTurn ? 'your turn' : "partner's turn"}`}
              onOpen={() => {
                if (item.gameId === BATTLESHIP_GAME_ID) {
                  navigation.navigate('Battleship', { sessionId: item.id });
                }
              }}
              onDelete={() => confirmDelete(item.id, name)}
            >
              <View
                style={[
                  styles.card,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.surfaceMuted },
                ]}
              >
                <AppText kind="body" tokens={tokens} style={styles.name}>
                  {name}
                </AppText>
                <AppText kind="muted" tokens={tokens}>
                  {myTurn ? 'Your turn' : "Waiting for your partner's turn"}
                </AppText>
              </View>
            </SwipeableGameRow>
          );
        })}

        {activeQuiz === null && sessions.length === 0 ? (
          <View
            style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.surfaceMuted }]}
          >
            <AppText kind="body" tokens={tokens} style={styles.name}>
              No ongoing games
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Start one from Mini Games. It will appear here while it is active.
            </AppText>
          </View>
        ) : null}

        {error !== null ? (
          <AppText kind="error" tokens={tokens}>
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40, gap: 12 },
  card: { borderRadius: 24, padding: 18 },
  name: { fontWeight: '700', marginTop: 4 },
  detail: { marginTop: 4, marginBottom: 14 },
});
