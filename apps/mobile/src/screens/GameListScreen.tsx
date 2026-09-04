import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import {
  BATTLESHIP_GAME_ID,
  TIC_TAC_TOE,
  isErr,
  isOk,
  sessionId,
  type AccountId,
  type Notification,
  type Pairing,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { classicFleet } from '../games/battleship-fleet';
import type { RootStackParamList } from '../navigation';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

const MAX_OPEN_SESSIONS_PER_GAME = 3;

function partnerId(pairing: Pairing, self: AccountId): AccountId {
  return pairing.memberA === self ? pairing.memberB : pairing.memberA;
}

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
  const tokens = themeTokens();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, reload } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    if (session !== null) void runtime.notifications.list(session.accountId);
    void runtime.asyncGames.refresh();
  }, [runtime, session]);

  if (pairing === null || session === null) return null;

  const self = session.accountId;
  const activePairing = pairing;
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
      (item): item is {
        readonly notification: Notification;
        readonly invite: IncomingInvite;
      } => item.invite !== null,
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
      const partner = partnerId(activePairing, self);
      const result = await runtime.asyncGames.start(BATTLESHIP_GAME_ID, {
        ships: { [self]: classicFleet(), [partner]: classicFleet() },
      });
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
        {runtime.rt.list().map((item) => (
          <Pressable
            key={item.id}
            onPress={() => navigation.navigate('TicTacToe', { sessionId: item.id })}
            style={[styles.row, { backgroundColor: tokens.surface, borderColor: tokens.border }]}
          >
            <AppText kind="body" tokens={tokens}>
              Tic-tac-toe · {item.state}
            </AppText>
            <AppText kind="muted" tokens={tokens} selectable>
              {item.id}
            </AppText>
          </Pressable>
        ))}
        {runtime.asyncGames.list().map((item) => (
          <Pressable
            key={item.id}
            onPress={() => navigation.navigate('Battleship', { sessionId: item.id })}
            style={[styles.row, { backgroundColor: tokens.surface, borderColor: tokens.border }]}
          >
            <AppText kind="body" tokens={tokens}>
              Battleship · {item.state}
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              {runtime.asyncGames.isMyTurn(item.id, self) ? 'Your turn' : "Partner's turn"}
            </AppText>
          </Pressable>
        ))}

        {error !== null ? (
          <AppText kind="error" tokens={tokens} style={styles.banner}>
            {error}
          </AppText>
        ) : null}

        <View style={styles.signOut}>
          <AppButton
            variant="quiet"
            label="Sign out"
            tokens={tokens}
            onPress={() => {
              void runtime.auth.signOut().then(() => reload());
            }}
          />
        </View>
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
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  rowTitle: { marginBottom: 12 },
  banner: { marginTop: 16 },
  signOut: { marginTop: 24 },
});
