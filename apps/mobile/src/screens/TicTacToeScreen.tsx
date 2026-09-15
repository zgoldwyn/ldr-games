import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isErr, sessionId, type AccountId, type TicTacToeState } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import {
  markForCell,
  markForPlayer,
  ticTacToeBoardLayout,
  ticTacToeStatus,
  winningCells,
} from '../games/tic-tac-toe-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { TicTacToeMark } from '../ui/TicTacToeMark';
import { clayRaisedStyle } from '../ui/clay';

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
  const { runtime, identity, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { width: viewportWidth } = useWindowDimensions();

  useEffect(() => runtime.rt.subscribe(() => setTick((n) => n + 1)), [runtime.rt]);
  useEffect(() => {
    runtime.connection.joinGame(id);
    return () => runtime.connection.leaveGame();
  }, [id, runtime.connection]);

  const cached = runtime.rt.cached(id);
  const board = asBoard(cached?.gameState);
  const self = identity.session?.accountId;
  const myTurn =
    board !== null &&
    self !== undefined &&
    board.currentTurn === self &&
    cached?.state === 'active';
  const status = ticTacToeStatus({
    sessionState: cached?.state,
    boardStatus: board?.status,
    currentTurn: board?.currentTurn,
    winner: board?.winner,
    self,
  });
  const ownMark = markForPlayer(self, board?.players);
  const winning = new Set(board === null ? [] : winningCells(board.board));
  const { boardSize, cellSize } = ticTacToeBoardLayout(viewportWidth);

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
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLiveRegion="polite"
        style={[
          styles.statusCard,
          clayRaisedStyle(tokens),
          { backgroundColor: tokens.surfaceMuted },
        ]}
      >
        <AppText kind="title" tokens={tokens} style={styles.statusTitle}>
          {status.title}
        </AppText>
        <AppText kind="muted" tokens={tokens}>
          {status.detail}
        </AppText>
        {ownMark !== '' ? (
          <AppText kind="label" tokens={tokens} style={styles.identity}>
            You are {ownMark}
          </AppText>
        ) : null}
      </View>
      {cached?.state === 'pending' ? (
        <AppText kind="muted" tokens={tokens} selectable>
          Invite sent · Session {id}
        </AppText>
      ) : null}

      <View style={[styles.grid, { width: boardSize, height: boardSize }]}>
        {(board?.board ?? Array<AccountId | null>(9).fill(null)).map((cell, index) => (
          <Pressable
            key={index}
            accessibilityRole="button"
            accessibilityLabel={`Row ${Math.floor(index / 3) + 1}, column ${(index % 3) + 1}, ${board === null || cell === null ? 'empty' : markForCell(cell, board.players)}`}
            accessibilityHint={myTurn && cell === null ? 'Places your mark' : undefined}
            accessibilityState={{ disabled: !myTurn || cell !== null }}
            disabled={!myTurn || cell !== null}
            onPress={() => {
              void place(index);
            }}
            style={({ pressed }) => [
              styles.cell,
              {
                backgroundColor: winning.has(index) ? tokens.accent : tokens.surface,
                borderColor: tokens.border,
                borderRightWidth: index % 3 < 2 ? 2 : 0,
                borderBottomWidth: Math.floor(index / 3) < 2 ? 2 : 0,
                opacity: pressed ? 0.78 : 1,
                width: cellSize,
                height: cellSize,
              },
            ]}
          >
            {board && markForCell(cell, board.players) !== '' ? (
              <TicTacToeMark mark={markForCell(cell, board.players) as 'X' | 'O'} tokens={tokens} />
            ) : null}
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
        <AppText
          kind="error"
          tokens={tokens}
          style={styles.banner}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusCard: { borderRadius: 28, padding: 20, marginBottom: 20 },
  statusTitle: { marginBottom: 4 },
  identity: { marginTop: 12 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 16,
    alignSelf: 'center',
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: { marginTop: 16 },
});
