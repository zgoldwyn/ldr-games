import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import {
  BATTLESHIP_GAME_ID,
  DRAW_TOGETHER_GAME_ID,
  SPEED_GAME_ID,
  TIC_TAC_TOE,
  WORD_CHAIN_GAME_ID,
  isErr,
  isOk,
  sessionId,
  type Notification,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { gameArtForTheme } from '../games/game-art';
import {
  gameListNotificationAction,
  isCurrentQuizUpdate,
  sessionStateLabel,
  unfinishedGames,
  withoutIncomingInvites,
  type GameListNotificationAction,
} from '../games/game-list-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { SwipeableGameRow } from '../ui/SwipeableGameRow';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

const MAX_OPEN_SESSIONS_PER_GAME = 3;

function GameChoice({
  art,
  label,
  hint,
  disabled,
  onPress,
  tokens,
}: {
  readonly art: number;
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.gameChoice,
        pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
        {
          backgroundColor: tokens.surfaceMuted,
          opacity: disabled ? 0.5 : pressed ? 0.82 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Image source={art} resizeMode="contain" accessible={false} style={styles.gameArt} />
      <AppText kind="label" tokens={tokens} numberOfLines={1} style={styles.gameChoiceTitle}>
        {label}
      </AppText>
    </Pressable>
  );
}

function WideGameChoice({
  icon,
  label,
  description,
  badge,
  disabled = false,
  onPress,
  tokens,
}: {
  readonly icon: string;
  readonly label: string;
  readonly description: string;
  readonly badge?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.wideChoice,
        pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
        {
          backgroundColor: tokens.primary,
          opacity: disabled ? 0.62 : pressed ? 0.84 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}
    >
      <View style={[styles.categoryIcon, { backgroundColor: tokens.surface }]}>
        <AppText kind="title" tokens={tokens} style={styles.categoryIconText}>
          {icon}
        </AppText>
      </View>
      <View style={styles.categoryCopy}>
        <View style={styles.categoryTitleRow}>
          <AppText kind="title" tokens={tokens} style={styles.categoryTitle}>
            {label}
          </AppText>
          {badge ? (
            <View style={[styles.badge, { backgroundColor: tokens.surface }]}>
              <AppText kind="label" tokens={tokens}>
                {badge}
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText kind="muted" tokens={tokens}>
          {description}
        </AppText>
      </View>
      {disabled ? null : (
        <AppText kind="title" tokens={tokens} style={styles.categoryChevron}>
          ›
        </AppText>
      )}
    </Pressable>
  );
}

export function GameListScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, tokens, colorOption } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rtNames, setRtNames] = useState<string>('Tic-Tac-Toe');
  const [quizPhases, setQuizPhases] = useState<
    Record<string, 'self_answer' | 'guessing' | 'complete' | null>
  >({});
  const [, setTick] = useState(0);
  const pairing = identity.pairing;
  const session = identity.session;

  useEffect(() => {
    return runtime.rt.subscribe(() => setTick((n) => n + 1));
  }, [runtime.rt]);

  useEffect(() => {
    return runtime.asyncGames.subscribe(() => setTick((n) => n + 1));
  }, [runtime.asyncGames]);

  useEffect(() => {
    return runtime.notifications.subscribeCache(() => setTick((n) => n + 1));
  }, [runtime.notifications]);

  const refreshQuizUpdates = useCallback(async () => {
    if (session === null) return;
    const updates = runtime.notifications
      .cached(session.accountId)
      .map((notification) => ({ notification, action: gameListNotificationAction(notification) }))
      .filter((entry) => entry.action?.kind === 'quiz');
    const ids = [...new Set(updates.map((entry) => entry.action!.sessionId))];
    const phases = await Promise.all(
      ids.map(async (id) => ({
        id,
        phase: (await runtime.quiz.refreshSession(sessionId(id)))?.session.phase ?? null,
      })),
    );
    const nextPhases = Object.fromEntries(phases.map(({ id, phase }) => [id, phase]));
    setQuizPhases(nextPhases);
    await Promise.all(
      updates.map(async ({ notification, action }) => {
        if (action === null || action.kind !== 'quiz') return;
        const phase = nextPhases[action.sessionId];
        if (phase !== null && phase !== undefined && !isCurrentQuizUpdate(action, phase)) {
          await runtime.notifications.acknowledge(notification.id);
        }
      }),
    );
  }, [runtime.notifications, runtime.quiz, session]);

  const quizNoticeKey =
    session === null
      ? ''
      : runtime.notifications
          .cached(session.accountId)
          .filter((notification) => notification.category === 'quiz')
          .map((notification) => notification.id)
          .join(',');

  useEffect(() => {
    void refreshQuizUpdates();
  }, [quizNoticeKey, refreshQuizUpdates]);

  useFocusEffect(
    useCallback(() => {
      void runtime.rt.refresh();
      if (session !== null) {
        void runtime.notifications.list(session.accountId).then(() => refreshQuizUpdates());
      }
      void runtime.asyncGames.refresh();
    }, [runtime, session, refreshQuizUpdates]),
  );

  useEffect(() => {
    void runtime.rt.listGames().then((result) => {
      if (isOk(result)) {
        setRtNames(result.value.map((game) => game.name).join(', '));
      }
    });
  }, [runtime.rt]);

  if (pairing === null || session === null) return null;

  const self = session.accountId;
  const asyncCatalog = runtime.asyncGames
    .listGames()
    .filter((game) => game.id === BATTLESHIP_GAME_ID);
  const openTicTacToeCount = runtime.rt
    .list()
    .filter((item) => item.gameId === TIC_TAC_TOE && item.state !== 'terminal').length;
  const openDrawTogetherCount = runtime.rt
    .list()
    .filter((item) => item.gameId === DRAW_TOGETHER_GAME_ID && item.state !== 'terminal').length;
  const openBattleshipCount = runtime.asyncGames
    .list()
    .filter((item) => item.gameId === BATTLESHIP_GAME_ID && item.state === 'active').length;
  const incomingInvites = runtime.notifications
    .cached(self)
    .map((notification) => ({
      notification,
      invite: gameListNotificationAction(notification),
    }))
    .filter(
      (
        item,
      ): item is {
        readonly notification: Notification;
        readonly invite: GameListNotificationAction;
      } => {
        if (item.invite === null) return false;
        if (item.invite.kind === 'rt') {
          const invitedSession = runtime.rt.cached(sessionId(item.invite.sessionId));
          return invitedSession !== undefined && invitedSession.state !== 'terminal';
        }
        if (item.invite.kind === 'async') {
          const invitedSession = runtime.asyncGames.cached(sessionId(item.invite.sessionId));
          return invitedSession !== undefined && invitedSession.state === 'active';
        }
        return (
          item.invite.kind !== 'quiz' ||
          isCurrentQuizUpdate(item.invite, quizPhases[item.invite.sessionId])
        );
      },
    );
  const incomingGameSessionIds = new Set(
    incomingInvites
      .filter(({ invite }) => invite.kind === 'rt' || invite.kind === 'async')
      .map(({ invite }) => invite.sessionId),
  );
  const ticTacToeSessions = withoutIncomingInvites(
    unfinishedGames(runtime.rt.list().filter((item) => item.gameId === TIC_TAC_TOE)),
    incomingGameSessionIds,
  );
  const battleshipSessions = withoutIncomingInvites(
    unfinishedGames(runtime.asyncGames.list().filter((item) => item.gameId === BATTLESHIP_GAME_ID)),
    incomingGameSessionIds,
  );
  const drawTogetherSessions = withoutIncomingInvites(
    unfinishedGames(runtime.rt.list().filter((item) => item.gameId === DRAW_TOGETHER_GAME_ID)),
    incomingGameSessionIds,
  );
  const gameArt = gameArtForTheme(colorOption);

  async function inviteTicTacToe() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.invite(TIC_TAC_TOE);
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      navigation.navigate('TicTacToe', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function startBattleship() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.asyncGames.start(BATTLESHIP_GAME_ID, {});
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      navigation.navigate('Battleship', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function inviteDrawTogether() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.invite(DRAW_TOGETHER_GAME_ID);
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      navigation.navigate('DrawTogether', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function openInvite(notification: Notification, invite: GameListNotificationAction) {
    setBusy(true);
    setError(null);
    try {
      const id = sessionId(invite.sessionId);
      if (invite.kind === 'quiz') {
        await runtime.notifications.acknowledge(notification.id);
        navigation.navigate('CouplesQuiz', { sessionId: id });
      } else if (invite.kind === 'rt') {
        await runtime.rt.refresh();
        let opened = runtime.rt.cached(id);
        if (opened === undefined || opened.state === 'pending') {
          const result = await runtime.rt.join(id);
          if (isErr(result)) {
            setError(messageForError(result.error));
            return;
          }
          opened = result.value;
        }
        await runtime.notifications.acknowledge(notification.id);
        if (invite.gameId === DRAW_TOGETHER_GAME_ID) {
          navigation.navigate('DrawTogether', { sessionId: opened.id });
        } else if (invite.gameId === SPEED_GAME_ID) {
          navigation.navigate('Speed', { sessionId: opened.id });
        } else if (invite.gameId === WORD_CHAIN_GAME_ID) {
          navigation.navigate('WordChain', { sessionId: opened.id });
        } else {
          navigation.navigate('TicTacToe', { sessionId: opened.id });
        }
      } else {
        await runtime.asyncGames.refresh();
        if (runtime.asyncGames.cached(id) === undefined) {
          setError('That game could not be found.');
          return;
        }
        await runtime.notifications.acknowledge(notification.id);
        navigation.navigate('Battleship', { sessionId: id });
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteGame(kind: 'rt' | 'async', rawId: string) {
    setDeletingId(rawId);
    setError(null);
    try {
      const id = sessionId(rawId);
      if (kind === 'rt') {
        const result = await runtime.rt.deleteSession(id);
        if (isErr(result)) setError(messageForError(result.error));
      } else {
        const result = await runtime.asyncGames.deleteSession(id);
        if (isErr(result)) setError(messageForError(result.error));
      }
    } finally {
      setDeletingId(null);
    }
  }

  function confirmDelete(kind: 'rt' | 'async', rawId: string, name: string) {
    Alert.alert(
      `Delete ${name}?`,
      'This permanently removes the game and its data for both you and your partner. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete game',
          style: 'destructive',
          onPress: () => void deleteGame(kind, rawId),
        },
      ],
    );
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.categories}>
          <WideGameChoice
            icon="♥"
            label="Card games"
            description="Open a live table for Speed, with more card games on the way."
            tokens={tokens}
            onPress={() => navigation.navigate('CardGames')}
          />

          <WideGameChoice
            icon="Aa"
            label="Word games"
            description="Live word games for two, starting with Word Chain."
            tokens={tokens}
            onPress={() => navigation.navigate('WordGames')}
          />

          <View
            style={[
              styles.otherGames,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <View style={styles.otherGamesHeader}>
              <AppText kind="title" tokens={tokens} style={styles.categoryTitle}>
                Other minigames
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {rtNames}. {asyncCatalog.map((game) => game.name).join(', ')}.
              </AppText>
            </View>
            <View style={styles.gameChoices}>
              <GameChoice
                art={gameArt.ticTacToe}
                label="Tic-tac-toe"
                hint="Invites your partner to a new game"
                tokens={tokens}
                disabled={busy || openTicTacToeCount >= MAX_OPEN_SESSIONS_PER_GAME}
                onPress={() => void inviteTicTacToe()}
              />
              <GameChoice
                art={gameArt.drawTogether}
                label="Draw Together"
                hint="Invites your partner to a cooperative drawing game"
                tokens={tokens}
                disabled={busy || openDrawTogetherCount >= MAX_OPEN_SESSIONS_PER_GAME}
                onPress={() => void inviteDrawTogether()}
              />
              <GameChoice
                art={gameArt.battleship}
                label="Battleship"
                hint="Starts a new game with your partner"
                tokens={tokens}
                disabled={busy || openBattleshipCount >= MAX_OPEN_SESSIONS_PER_GAME}
                onPress={() => void startBattleship()}
              />
              <GameChoice
                art={gameArt.couplesQuiz}
                label="Couples Quiz"
                hint="Choose a quiz and predict your partner’s answers"
                tokens={tokens}
                disabled={busy}
                onPress={() => navigation.navigate('QuizLibrary')}
              />
            </View>
          </View>

          <WideGameChoice
            icon="≈"
            label="Ember & Tide"
            description="Cross an enchanted grove together as two spirits with complementary powers."
            badge="CO-OP ADVENTURE"
            tokens={tokens}
            onPress={() => navigation.navigate('ElementalDuetSetup')}
          />
        </View>

        {incomingInvites.length > 0 ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Updates & invites
            </AppText>
            {incomingInvites.map(({ notification, invite }) => (
              <View
                key={notification.id}
                style={[
                  styles.row,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.surfaceMuted },
                ]}
              >
                <AppText kind="body" tokens={tokens} style={styles.rowTitle}>
                  {invite.kind === 'quiz'
                    ? invite.phase === 'self_answer'
                      ? 'Your partner started a Couples Quiz'
                      : invite.phase === 'guessing'
                        ? 'Couples Quiz: ready to guess'
                        : 'Couples Quiz: results ready'
                    : invite.kind === 'rt'
                      ? invite.gameId === DRAW_TOGETHER_GAME_ID
                        ? 'Draw Together invite'
                        : invite.gameId === SPEED_GAME_ID
                          ? 'Speed invite'
                          : invite.gameId === WORD_CHAIN_GAME_ID
                            ? 'Word Chain invite'
                            : 'Tic-tac-toe invite'
                      : 'Battleship invite'}
                </AppText>
                <AppButton
                  variant="quiet"
                  label={invite.kind === 'rt' ? 'Join game' : 'Open'}
                  tokens={tokens}
                  disabled={busy}
                  onPress={() => {
                    void openInvite(notification, invite);
                  }}
                />
              </View>
            ))}
          </>
        ) : null}

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Your games
        </AppText>
        {ticTacToeSessions.map((item) => (
          <SwipeableGameRow
            key={item.id}
            tokens={tokens}
            disabled={deletingId === item.id}
            accessibilityLabel={`Tic-tac-toe, ${sessionStateLabel(item.state)}`}
            onOpen={() => navigation.navigate('TicTacToe', { sessionId: item.id })}
            onDelete={() => confirmDelete('rt', item.id, 'tic-tac-toe')}
          >
            <View
              style={[
                styles.row,
                styles.swipeRow,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <AppText kind="body" tokens={tokens}>
                Tic-tac-toe
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {sessionStateLabel(item.state)}
              </AppText>
            </View>
          </SwipeableGameRow>
        ))}
        {drawTogetherSessions.map((item) => (
          <SwipeableGameRow
            key={item.id}
            tokens={tokens}
            disabled={deletingId === item.id}
            accessibilityLabel={`Draw Together, ${sessionStateLabel(item.state)}`}
            onOpen={() => navigation.navigate('DrawTogether', { sessionId: item.id })}
            onDelete={() => confirmDelete('rt', item.id, 'Draw Together')}
          >
            <View
              style={[
                styles.row,
                styles.swipeRow,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <AppText kind="body" tokens={tokens}>
                Draw Together
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {sessionStateLabel(item.state)}
              </AppText>
            </View>
          </SwipeableGameRow>
        ))}
        {battleshipSessions.map((item) => (
          <SwipeableGameRow
            key={item.id}
            tokens={tokens}
            disabled={deletingId === item.id}
            accessibilityLabel={`Battleship, ${runtime.asyncGames.isMyTurn(item.id, self) ? 'your turn' : "partner's turn"}`}
            onOpen={() => navigation.navigate('Battleship', { sessionId: item.id })}
            onDelete={() => confirmDelete('async', item.id, 'Battleship')}
          >
            <View
              style={[
                styles.row,
                styles.swipeRow,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <AppText kind="body" tokens={tokens}>
                Battleship
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {runtime.asyncGames.isMyTurn(item.id, self) ? 'Your turn' : "Partner's turn"}
              </AppText>
            </View>
          </SwipeableGameRow>
        ))}
        {ticTacToeSessions.length === 0 &&
        drawTogetherSessions.length === 0 &&
        battleshipSessions.length === 0 ? (
          <View
            style={[styles.empty, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}
          >
            <AppText kind="body" tokens={tokens} style={styles.emptyTitle}>
              No games in progress
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Start one above when you’re ready to play together.
            </AppText>
          </View>
        ) : null}

        {error !== null ? (
          <AppText kind="error" tokens={tokens} style={styles.banner}>
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 32 },
  categories: { gap: 20 },
  wideChoice: {
    width: '100%',
    minHeight: 132,
    borderRadius: 28,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  categoryIcon: {
    width: 64,
    height: 76,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
  },
  categoryIconText: { fontSize: 34 },
  categoryCopy: { flex: 1, gap: 5 },
  categoryTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  categoryTitle: { fontSize: 23, lineHeight: 28 },
  categoryChevron: { fontSize: 34, lineHeight: 38 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  otherGames: { width: '100%', borderRadius: 28, padding: 16 },
  otherGamesHeader: { paddingHorizontal: 4, paddingTop: 2, paddingBottom: 16, gap: 4 },
  gameChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  gameChoice: {
    flexBasis: '45%',
    flexGrow: 1,
    maxWidth: '48%',
    aspectRatio: 1,
    borderRadius: 28,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gameArt: { width: '100%', flex: 1 },
  gameChoiceTitle: { minHeight: 22, textAlign: 'center', paddingHorizontal: 4 },
  section: { marginTop: 32, marginBottom: 12 },
  row: {
    borderRadius: 24,
    padding: 16,
    marginBottom: 12,
  },
  rowTitle: { marginBottom: 12 },
  swipeRow: { marginBottom: 0 },
  empty: { borderRadius: 24, padding: 18 },
  emptyTitle: { fontWeight: '600', marginBottom: 4 },
  banner: { marginTop: 16 },
});
