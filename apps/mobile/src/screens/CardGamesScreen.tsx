import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { isErr, sessionId, SPEED_GAME_ID, type Notification } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { sessionStateLabel, unfinishedGames } from '../games/game-list-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { SwipeableGameRow } from '../ui/SwipeableGameRow';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

const MAX_OPEN_SPEED_GAMES = 3;

function speedInvite(notification: Notification): { readonly sessionId: string } | null {
  if (notification.category !== 'game_invite') return null;
  if (notification.payload === null || typeof notification.payload !== 'object') return null;
  const payload = notification.payload as {
    readonly type?: unknown;
    readonly sessionId?: unknown;
    readonly gameId?: unknown;
  };
  if (
    payload.type !== 'rt_game_invite' ||
    payload.gameId !== SPEED_GAME_ID ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length === 0
  ) {
    return null;
  }
  return { sessionId: payload.sessionId };
}

export function CardGamesScreen() {
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
    runtime.rt.list().filter((session) => session.gameId === SPEED_GAME_ID),
  );
  const invites = self
    ? runtime.notifications
        .cached(self)
        .map((notification) => ({ notification, action: speedInvite(notification) }))
        .filter(
          (
            item,
          ): item is {
            readonly notification: Notification;
            readonly action: { readonly sessionId: string };
          } => item.action !== null,
        )
    : [];

  async function inviteSpeed() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.invite(SPEED_GAME_ID);
      if (isErr(result)) return setError(messageForError(result.error));
      navigation.navigate('Speed', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function joinSpeed(notification: Notification, rawId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.join(sessionId(rawId));
      if (isErr(result)) return setError(messageForError(result.error));
      await runtime.notifications.acknowledge(notification.id);
      navigation.navigate('Speed', { sessionId: result.value.id });
    } finally {
      setBusy(false);
    }
  }

  async function deleteSpeed(rawId: string) {
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
      'Delete Speed game?',
      'This permanently removes the game for both you and your partner.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete game',
          style: 'destructive',
          onPress: () => void deleteSpeed(rawId),
        },
      ],
    );
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.hero, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
          <View style={styles.miniDeck} accessible={false}>
            <View style={[styles.backCard, { backgroundColor: tokens.primaryStrong }]} />
            <View style={[styles.frontCard, { backgroundColor: tokens.surface }]}>
              <AppText kind="title" tokens={tokens} style={styles.heart}>
                ♥
              </AppText>
            </View>
          </View>
          <View style={styles.heroCopy}>
            <AppText kind="title" tokens={tokens}>
              Card games
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Live tables for two. Speed is here first, with more games to come.
            </AppText>
          </View>
        </View>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Choose a game
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Speed"
          accessibilityHint="Invites your partner to a live game of Speed"
          disabled={busy || sessions.length >= MAX_OPEN_SPEED_GAMES}
          onPress={() => void inviteSpeed()}
          style={({ pressed }) => [
            styles.game,
            pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
            { backgroundColor: tokens.surfaceMuted, opacity: busy ? 0.6 : 1 },
          ]}
        >
          <View style={styles.gameCopy}>
            <AppText kind="title" tokens={tokens} style={styles.gameTitle}>
              Speed
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              Race to clear your stock. Play one rank up or down—no turns.
            </AppText>
          </View>
          <View style={[styles.speedBadge, { backgroundColor: tokens.accent }]}>
            <AppText kind="label" tokens={tokens}>
              LIVE
            </AppText>
          </View>
        </Pressable>

        {invites.length ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Invites
            </AppText>
            {invites.map(({ notification, action }) => (
              <View
                key={notification.id}
                style={[styles.row, clayRaisedStyle(tokens), { backgroundColor: tokens.warning }]}
              >
                <View style={styles.rowCopy}>
                  <AppText kind="body" tokens={tokens}>
                    Ready for Speed?
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    Your partner is at the table.
                  </AppText>
                </View>
                <AppButton
                  label="Join"
                  variant="quiet"
                  tokens={tokens}
                  disabled={busy}
                  onPress={() => void joinSpeed(notification, action.sessionId)}
                />
              </View>
            ))}
          </>
        ) : null}

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Your card tables
        </AppText>
        {sessions.map((session) => (
          <SwipeableGameRow
            key={session.id}
            tokens={tokens}
            disabled={deletingId === session.id}
            accessibilityLabel={`Speed, ${sessionStateLabel(session.state)}`}
            onOpen={() => navigation.navigate('Speed', { sessionId: session.id })}
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
                  Speed
                </AppText>
                <AppText kind="muted" tokens={tokens}>
                  {sessionStateLabel(session.state)}
                </AppText>
              </View>
              <AppText kind="title" tokens={tokens} style={styles.chevron}>
                ›
              </AppText>
            </View>
          </SwipeableGameRow>
        ))}
        {sessions.length === 0 ? (
          <AppText kind="muted" tokens={tokens}>
            No open card tables yet.
          </AppText>
        ) : null}
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
  scroll: { paddingHorizontal: 24, paddingBottom: 40 },
  hero: { borderRadius: 28, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 18 },
  heroCopy: { flex: 1, gap: 5 },
  miniDeck: { width: 64, height: 76 },
  backCard: {
    position: 'absolute',
    width: 48,
    height: 66,
    borderRadius: 10,
    left: 0,
    top: 0,
    transform: [{ rotate: '-8deg' }],
  },
  frontCard: {
    position: 'absolute',
    width: 48,
    height: 66,
    borderRadius: 10,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '7deg' }],
  },
  heart: { fontSize: 28 },
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
  speedBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
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
