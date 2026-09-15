import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import {
  BATTLESHIP_GAME_ID,
  TIC_TAC_TOE,
  isErr,
  isOk,
  sessionId,
  type Notification,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { sessionStateLabel, unfinishedGames } from '../games/game-list-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { SwipeableGameRow } from '../ui/SwipeableGameRow';
import { clayRaisedStyle } from '../ui/clay';

const MAX_OPEN_SESSIONS_PER_GAME = 3;

type IncomingInvite =
  | { readonly kind: 'rt'; readonly sessionId: string }
  | { readonly kind: 'async'; readonly sessionId: string };

function incomingInvite(notification: Notification): IncomingInvite | null {
  if (notification.category !== 'game_invite') return null;
  if (notification.payload === null || typeof notification.payload !== 'object') return null;
  const payload = notification.payload as {
    readonly type?: unknown;
    readonly kind?: unknown;
    readonly sessionId?: unknown;
  };
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
    return null;
  }
  if (payload.type === 'rt_game_invite') {
    return { kind: 'rt', sessionId: payload.sessionId };
  }
  if (payload.kind === 'async_game_invite') {
    return { kind: 'async', sessionId: payload.sessionId };
  }
  return null;
}

export function GameListScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, tokens } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rtNames, setRtNames] = useState<string>('Tic-Tac-Toe');
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

  useEffect(() => {
    void runtime.rt.listGames().then((result) => {
      if (isOk(result)) {
        setRtNames(result.value.map((game) => game.name).join(', '));
      }
    });
    void runtime.rt.refresh();
    if (session !== null) void runtime.notifications.list(session.accountId);
    void runtime.asyncGames.refresh();
  }, [runtime, session]);

  if (pairing === null || session === null) return null;

  const self = session.accountId;
  const asyncCatalog = runtime.asyncGames
    .listGames()
    .filter((game) => game.id === BATTLESHIP_GAME_ID);
  const openTicTacToeCount = runtime.rt
    .list()
    .filter((item) => item.gameId === TIC_TAC_TOE && item.state !== 'terminal').length;
  const openBattleshipCount = runtime.asyncGames
    .list()
    .filter((item) => item.gameId === BATTLESHIP_GAME_ID && item.state === 'active').length;
  const incomingInvites = runtime.notifications
    .cached(self)
    .map((notification) => ({ notification, invite: incomingInvite(notification) }))
    .filter(
      (
        item,
      ): item is {
        readonly notification: Notification;
        readonly invite: IncomingInvite;
      } => item.invite !== null,
    );
  const ticTacToeSessions = unfinishedGames(
    runtime.rt.list().filter((item) => item.gameId === TIC_TAC_TOE),
  );
  const battleshipSessions = unfinishedGames(
    runtime.asyncGames.list().filter((item) => item.gameId === BATTLESHIP_GAME_ID),
  );

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

  async function openInvite(notification: Notification, invite: IncomingInvite) {
    setBusy(true);
    setError(null);
    try {
      const id = sessionId(invite.sessionId);
      if (invite.kind === 'rt') {
        const result = await runtime.rt.join(id);
        if (isErr(result)) {
          setError(messageForError(result.error));
          return;
        }
        await runtime.notifications.acknowledge(notification.id);
        navigation.navigate('TicTacToe', { sessionId: result.value.id });
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
    <Screen tokens={tokens}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="title" tokens={tokens}>
          Play
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          Real-time: {rtNames}. Async: {asyncCatalog.map((g) => g.name).join(', ')}.
        </AppText>

        <AppButton
          label="Invite to tic-tac-toe"
          tokens={tokens}
          disabled={busy || openTicTacToeCount >= MAX_OPEN_SESSIONS_PER_GAME}
          onPress={() => {
            void inviteTicTacToe();
          }}
        />
        <View style={styles.spacer} />
        <AppButton
          label="Start battleship"
          tokens={tokens}
          disabled={busy || openBattleshipCount >= MAX_OPEN_SESSIONS_PER_GAME}
          onPress={() => {
            void startBattleship();
          }}
        />

        {incomingInvites.length > 0 ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Incoming invites
            </AppText>
            {incomingInvites.map(({ notification, invite }) => (
              <View
                key={notification.id}
                style={[
                  styles.row,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.surface, borderColor: tokens.border },
                ]}
              >
                <AppText kind="body" tokens={tokens} style={styles.rowTitle}>
                  {invite.kind === 'rt' ? 'Tic-tac-toe invite' : 'Battleship invite'}
                </AppText>
                <AppButton
                  variant="quiet"
                  label={invite.kind === 'rt' ? 'Join game' : 'Open game'}
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
                { backgroundColor: tokens.surface, borderColor: tokens.primary },
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
                { backgroundColor: tokens.surface, borderColor: tokens.primary },
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
        {ticTacToeSessions.length === 0 && battleshipSessions.length === 0 ? (
          <View
            style={[
              styles.empty,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surfaceMuted },
            ]}
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
  scroll: { paddingBottom: 32 },
  lead: { marginTop: 8, marginBottom: 24 },
  spacer: { height: 12 },
  section: { marginTop: 32, marginBottom: 12 },
  row: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  rowTitle: { marginBottom: 12 },
  swipeRow: { marginBottom: 0 },
  empty: { borderRadius: 24, padding: 18 },
  emptyTitle: { fontWeight: '600', marginBottom: 4 },
  banner: { marginTop: 16 },
});
