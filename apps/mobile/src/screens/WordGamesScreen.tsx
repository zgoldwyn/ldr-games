import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { isErr, sessionId, WORD_CHAIN_GAME_ID, type Notification } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { unfinishedGames } from '../games/game-list-view';
import { asWordChainState, wordChainSessionSummary } from '../games/word-chain-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { SwipeableGameRow } from '../ui/SwipeableGameRow';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

const MAX_OPEN_WORD_CHAIN_GAMES = 3;

export function wordChainInvite(notification: Notification): { readonly sessionId: string } | null {
  if (notification.category !== 'game_invite') return null;
  if (notification.payload === null || typeof notification.payload !== 'object') return null;
  const payload = notification.payload as {
    readonly type?: unknown;
    readonly sessionId?: unknown;
    readonly gameId?: unknown;
  };
  if (
    payload.type !== 'rt_game_invite' ||
    payload.gameId !== WORD_CHAIN_GAME_ID ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length === 0
  ) {
    return null;
  }
  return { sessionId: payload.sessionId };
}

export function WordGamesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, tokens } = useApp();
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const self = identity.session?.accountId;

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(
    () => runtime.notifications.subscribeCache(() => setTick((value) => value + 1)),
    [runtime.notifications],
  );
  useFocusEffect(
    useCallback(() => {
      void runtime.rt.refresh();
      if (self) void runtime.notifications.list(self);
    }, [runtime, self]),
  );

  const sessions = unfinishedGames(
    runtime.rt.list().filter((session) => session.gameId === WORD_CHAIN_GAME_ID),
  );
  const atOpenGameLimit = sessions.length >= MAX_OPEN_WORD_CHAIN_GAMES;
  const invites = self
    ? runtime.notifications
        .cached(self)
        .map((notification) => ({ notification, action: wordChainInvite(notification) }))
        .filter(
          (
            item,
          ): item is {
            readonly notification: Notification;
            readonly action: { readonly sessionId: string };
          } => {
            if (item.action === null) return false;
            const invitedSession = runtime.rt.cached(sessionId(item.action.sessionId));
            return invitedSession !== undefined && invitedSession.state !== 'terminal';
          },
        )
    : [];

  async function inviteWordChain() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.invite(WORD_CHAIN_GAME_ID);
      if (isErr(result)) return setError(messageForError(result.error));
      navigation.navigate('WordChain', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function joinWordChain(notification: Notification, rawId: string) {
    setBusy(true);
    setError(null);
    try {
      const id = sessionId(rawId);
      await runtime.rt.refresh();
      let opened = runtime.rt.cached(id);
      if (opened === undefined || opened.state === 'pending') {
        const result = await runtime.rt.join(id);
        if (isErr(result)) return setError(messageForError(result.error));
        opened = result.value;
      }
      await runtime.notifications.acknowledge(notification.id);
      navigation.navigate('WordChain', { sessionId: opened.id });
    } finally {
      setBusy(false);
    }
  }

  async function deleteWordChain(rawId: string) {
    setDeletingId(rawId);
    setError(null);
    try {
      const result = await runtime.rt.deleteSession(sessionId(rawId));
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setDeletingId(null);
    }
  }

  function confirmDelete(rawId: string) {
    Alert.alert(
      'Delete Word Chain?',
      'This permanently removes the game for both you and your partner.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete game',
          style: 'destructive',
          onPress: () => void deleteWordChain(rawId),
        },
      ],
    );
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.hero, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
          <View style={[styles.letterTile, { backgroundColor: tokens.surface }]} accessible={false}>
            <AppText kind="title" tokens={tokens} style={styles.letterTileText}>
              Aa
            </AppText>
          </View>
          <View style={styles.heroCopy}>
            <AppText kind="title" tokens={tokens}>
              Word games
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Outsmart each other, one growing word at a time.
            </AppText>
          </View>
        </View>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          CHOOSE A GAME
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Word Chain"
          accessibilityHint="Invites your partner to a live game of Word Chain"
          disabled={busy || atOpenGameLimit}
          onPress={() => void inviteWordChain()}
          style={({ pressed }) => [
            styles.game,
            pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
            { backgroundColor: tokens.surfaceMuted, opacity: busy || atOpenGameLimit ? 0.58 : 1 },
          ]}
        >
          <View style={styles.gameCopy}>
            <AppText kind="title" tokens={tokens} style={styles.gameTitle}>
              Word Chain
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Chain valid words that grow by one or two letters. If you cannot answer, you give up
              the round.
            </AppText>
            <View style={styles.gameMeta}>
              <AppText kind="label" tokens={tokens}>
                2 PLAYERS
              </AppText>
              <AppText kind="label" tokens={tokens}>
                GROWING WORDS
              </AppText>
              <AppText kind="label" tokens={tokens}>
                COMPETITIVE
              </AppText>
            </View>
          </View>
          <View style={styles.gameArt} accessible={false}>
            <View style={[styles.letterBubble, { backgroundColor: tokens.primary }]}>
              <AppText kind="title" tokens={tokens} style={styles.letterBubbleText}>
                E
              </AppText>
            </View>
            <View
              style={[styles.letterBubble, styles.secondBubble, { backgroundColor: tokens.accent }]}
            >
              <AppText kind="title" tokens={tokens} style={styles.letterBubbleText}>
                R
              </AppText>
            </View>
            <View style={[styles.liveBadge, { backgroundColor: tokens.success }]}>
              <AppText kind="label" tokens={tokens}>
                LIVE
              </AppText>
            </View>
          </View>
        </Pressable>
        {atOpenGameLimit ? (
          <AppText kind="muted" tokens={tokens} style={styles.limitCopy}>
            Finish or remove an open chain before starting another.
          </AppText>
        ) : null}

        {invites.length > 0 ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              INVITES
            </AppText>
            {invites.map(({ notification, action }) => (
              <View
                key={notification.id}
                style={[styles.row, clayRaisedStyle(tokens), { backgroundColor: tokens.warning }]}
              >
                <View style={styles.rowCopy}>
                  <AppText kind="body" tokens={tokens}>
                    Continue the chain?
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    Your partner is ready with the first word.
                  </AppText>
                </View>
                <AppButton
                  label="Join"
                  variant="quiet"
                  tokens={tokens}
                  disabled={busy}
                  onPress={() => void joinWordChain(notification, action.sessionId)}
                />
              </View>
            ))}
          </>
        ) : null}

        <AppText kind="label" tokens={tokens} style={styles.section}>
          YOUR WORD GAMES
        </AppText>
        {sessions.map((session) => {
          const summary = wordChainSessionSummary(
            session.state,
            asWordChainState(session.gameState),
            self,
          );
          return (
            <SwipeableGameRow
              key={session.id}
              tokens={tokens}
              disabled={deletingId === session.id}
              accessibilityLabel={`Word Chain, ${summary}`}
              onOpen={() => navigation.navigate('WordChain', { sessionId: session.id })}
              onDelete={() => confirmDelete(session.id)}
            >
              <View
                style={[
                  styles.row,
                  styles.swipeRow,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.surfaceMuted },
                ]}
              >
                <View style={styles.rowCopy}>
                  <AppText kind="body" tokens={tokens}>
                    Word Chain
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    {summary}
                  </AppText>
                </View>
                <AppText kind="title" tokens={tokens} style={styles.chevron}>
                  ›
                </AppText>
              </View>
            </SwipeableGameRow>
          );
        })}
        {sessions.length === 0 ? (
          <AppText kind="muted" tokens={tokens}>
            No open word games yet.
          </AppText>
        ) : null}
        {error ? (
          <AppText kind="error" tokens={tokens} style={styles.error} accessibilityRole="alert">
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40 },
  hero: { borderRadius: 28, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 18 },
  heroCopy: { flex: 1, gap: 5 },
  letterTile: {
    width: 64,
    height: 76,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
  },
  letterTileText: { fontSize: 30 },
  section: { marginTop: 28, marginBottom: 12 },
  game: {
    borderRadius: 26,
    minHeight: 144,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gameCopy: { flex: 1, paddingRight: 12 },
  gameTitle: { marginBottom: 8 },
  gameMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  gameArt: { width: 72, alignItems: 'center', paddingTop: 2 },
  letterBubble: {
    width: 50,
    height: 50,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-7deg' }],
  },
  secondBubble: { marginTop: -12, marginLeft: 20, transform: [{ rotate: '8deg' }] },
  letterBubbleText: { fontSize: 23 },
  liveBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginTop: -2 },
  limitCopy: { marginTop: 10, paddingHorizontal: 4 },
  row: {
    borderRadius: 22,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  swipeRow: { marginBottom: 0 },
  rowCopy: { flex: 1 },
  chevron: { fontSize: 30 },
  error: { marginTop: 16 },
});
