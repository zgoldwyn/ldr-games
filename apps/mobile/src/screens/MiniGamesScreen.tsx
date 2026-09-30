import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  BATTLESHIP_GAME_ID,
  DRAW_TOGETHER_GAME_ID,
  TIC_TAC_TOE,
  isErr,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { gameArtForTheme } from '../games/game-art';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

const MAX_OPEN_SESSIONS_PER_GAME = 3;

function GameChoice({
  art,
  label,
  hint,
  disabled,
  onPress,
}: {
  readonly art: number;
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { tokens } = useApp();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.game,
        pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
        {
          backgroundColor: tokens.surfaceMuted,
          opacity: disabled ? 0.5 : pressed ? 0.84 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Image source={art} resizeMode="contain" accessible={false} style={styles.art} />
      <AppText kind="label" tokens={tokens} numberOfLines={1} style={styles.gameTitle}>
        {label}
      </AppText>
    </Pressable>
  );
}

export function MiniGamesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, tokens, colorOption } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const art = gameArtForTheme(colorOption);

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(
    () => runtime.asyncGames.subscribe(() => setTick((value) => value + 1)),
    [runtime.asyncGames],
  );

  const openTicTacToe = runtime.rt
    .list()
    .filter((session) => session.gameId === TIC_TAC_TOE && session.state !== 'terminal').length;
  const openDrawTogether = runtime.rt
    .list()
    .filter((session) => session.gameId === DRAW_TOGETHER_GAME_ID && session.state !== 'terminal')
    .length;
  const openBattleship = runtime.asyncGames
    .list()
    .filter((session) => session.gameId === BATTLESHIP_GAME_ID && session.state === 'active').length;

  async function inviteRealtime(gameId: typeof TIC_TAC_TOE | typeof DRAW_TOGETHER_GAME_ID) {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.invite(gameId);
      if (isErr(result)) return setError(messageForError(result.error));
      navigation.navigate(gameId === DRAW_TOGETHER_GAME_ID ? 'DrawTogether' : 'TicTacToe', {
        sessionId: result.value.id,
      });
    } finally {
      setBusy(false);
    }
  }

  async function startBattleship() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.asyncGames.start(BATTLESHIP_GAME_ID, {});
      if (isErr(result)) return setError(messageForError(result.error));
      navigation.navigate('Battleship', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.catalog, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}>
          <View style={styles.header}>
            <AppText kind="title" tokens={tokens} style={styles.heading}>
              Other minigames
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Pick something quick to play together.
            </AppText>
          </View>
          <View style={styles.grid}>
            <GameChoice
              art={art.ticTacToe}
              label="Tic-tac-toe"
              hint="Invites your partner to tic-tac-toe"
              disabled={busy || openTicTacToe >= MAX_OPEN_SESSIONS_PER_GAME}
              onPress={() => void inviteRealtime(TIC_TAC_TOE)}
            />
            <GameChoice
              art={art.drawTogether}
              label="Draw Together"
              hint="Invites your partner to Draw Together"
              disabled={busy || openDrawTogether >= MAX_OPEN_SESSIONS_PER_GAME}
              onPress={() => void inviteRealtime(DRAW_TOGETHER_GAME_ID)}
            />
            <GameChoice
              art={art.battleship}
              label="Battleship"
              hint="Starts a game of Battleship"
              disabled={busy || openBattleship >= MAX_OPEN_SESSIONS_PER_GAME}
              onPress={() => void startBattleship()}
            />
            <GameChoice
              art={art.couplesQuiz}
              label="Couples Quiz"
              hint="Opens the quiz library"
              disabled={busy}
              onPress={() => navigation.navigate('QuizLibrary')}
            />
          </View>
        </View>
        {error ? (
          <AppText kind="error" tokens={tokens} style={styles.error}>
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 40 },
  catalog: { width: '100%', borderRadius: 28, padding: 16 },
  header: { paddingHorizontal: 4, paddingTop: 2, paddingBottom: 16, gap: 4 },
  heading: { fontSize: 23, lineHeight: 28 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  game: {
    flexBasis: '45%',
    flexGrow: 1,
    maxWidth: '48%',
    aspectRatio: 1,
    borderRadius: 28,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  art: { width: '100%', flex: 1 },
  gameTitle: { minHeight: 22, textAlign: 'center', paddingHorizontal: 4 },
  error: { marginTop: 16 },
});
