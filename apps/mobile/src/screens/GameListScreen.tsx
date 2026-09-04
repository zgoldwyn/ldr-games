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
  type Pairing,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { classicFleet } from '../games/battleship-fleet';
import type { RootStackParamList } from '../navigation';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

function partnerId(pairing: Pairing, self: AccountId): AccountId {
  return pairing.memberA === self ? pairing.memberB : pairing.memberA;
}

export function GameListScreen() {
  const tokens = themeTokens();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, reload } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinId, setJoinId] = useState('');
  const [rtNames, setRtNames] = useState<string>('Tic-Tac-Toe');
  const [, setTick] = useState(0);

  useEffect(() => {
    return runtime.rt.subscribe(() => setTick((n) => n + 1));
  }, [runtime.rt]);

  useEffect(() => {
    return runtime.asyncGames.subscribe(() => setTick((n) => n + 1));
  }, [runtime.asyncGames]);

  useEffect(() => {
    void runtime.rt.listGames().then((result) => {
      if (isOk(result)) {
        setRtNames(result.value.map((game) => game.name).join(', '));
      }
    });
    void runtime.asyncGames.refresh();
  }, [runtime]);

  const pairing = identity.pairing;
  const session = identity.session;
  if (pairing === null || session === null) return null;

  const self = session.accountId;
  const activePairing = pairing;
  const asyncCatalog = runtime.asyncGames
    .listGames()
    .filter((game) => game.id === BATTLESHIP_GAME_ID);

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

  async function joinPending() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.join(sessionId(joinId.trim()));
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      navigation.navigate('TicTacToe', { sessionId: result.value.id });
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
          disabled={busy}
          onPress={() => {
            void inviteTicTacToe();
          }}
        />
        <View style={styles.spacer} />
        <AppButton
          label="Start battleship"
          tokens={tokens}
          disabled={busy}
          onPress={() => {
            void startBattleship();
          }}
        />

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Join a tic-tac-toe invite
        </AppText>
        <AppField
          label="Session id"
          tokens={tokens}
          autoCapitalize="none"
          autoCorrect={false}
          value={joinId}
          onChangeText={setJoinId}
        />
        <AppButton
          variant="quiet"
          label="Join"
          tokens={tokens}
          disabled={busy || joinId.trim().length === 0}
          onPress={() => {
            void joinPending();
          }}
        />

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
  banner: { marginTop: 16 },
  signOut: { marginTop: 24 },
});
