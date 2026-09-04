import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isErr, sessionId, type AccountId, type TicTacToeState } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { markForCell } from '../games/tic-tac-toe-view';
import type { RootStackParamList } from '../navigation';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

function asBoard(state: unknown): TicTacToeState | null {
  if (state === null || typeof state !== 'object') return null;
  const value = state as Partial<TicTacToeState>;
  if (value.game !== 'tic-tac-toe') return null;
  if (!Array.isArray(value.board) || value.board.length !== 9) return null;
  if (!Array.isArray(value.players) || value.players.length !== 2) return null;
  return value as TicTacToeState;
}

type Props = NativeStackScreenProps<RootStackParamList, 'TicTacToe'>;

export function TicTacToeScreen({ route }: Props) {
  const tokens = themeTokens();
  const { runtime, identity } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => runtime.rt.subscribe(() => setTick((n) => n + 1)), [runtime.rt]);

  const cached = runtime.rt.cached(id);
  const board = asBoard(cached?.gameState);
  const self = identity.session?.accountId;
  const myTurn =
    board !== null &&
    self !== undefined &&
    board.currentTurn === self &&
    cached?.state === 'active';

  async function place(cell: number) {
    if (!myTurn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.move(id, { type: 'place', cell });
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

  async function rejoin() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.rejoin(id);
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens}>
      <AppText kind="muted" tokens={tokens} style={styles.status}>
        {cached?.state ?? 'unknown'}
        {board?.status === 'won' && board.winner !== null
          ? ` · ${board.winner === self ? 'You won' : 'Partner won'}`
          : ''}
        {board?.status === 'draw' ? ' · Draw' : ''}
      </AppText>
      {cached?.state === 'pending' ? (
        <AppText kind="muted" tokens={tokens} selectable>
          Waiting for your partner. Session {id}
        </AppText>
      ) : null}

      <View style={styles.grid}>
        {(board?.board ?? Array<AccountId | null>(9).fill(null)).map((cell, index) => (
          <Pressable
            key={index}
            disabled={!myTurn}
            onPress={() => {
              void place(index);
            }}
            style={[
              styles.cell,
              {
                backgroundColor: tokens.surface,
                borderColor: tokens.border,
              },
            ]}
          >
            <AppText kind="title" tokens={tokens} style={styles.mark}>
              {board ? markForCell(cell, board.players) : ''}
            </AppText>
          </Pressable>
        ))}
      </View>

      {cached?.state === 'paused' ? (
        <AppButton
          label="Rejoin"
          tokens={tokens}
          disabled={busy}
          onPress={() => {
            void rejoin();
          }}
        />
      ) : null}

      {error !== null ? (
        <AppText kind="error" tokens={tokens} style={styles.banner}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: { marginBottom: 16 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  cell: {
    width: '33.333%',
    aspectRatio: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  mark: { fontSize: 32 },
  banner: { marginTop: 16 },
});
