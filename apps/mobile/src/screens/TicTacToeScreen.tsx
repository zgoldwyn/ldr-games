import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isErr, sessionId, type AccountId, type TicTacToeState } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import {
  TIC_TAC_TOE_BOARD_PADDING,
  TIC_TAC_TOE_CELL_GAP,
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
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

function asBoard(state: unknown): TicTacToeState | null {
  if (state === null || typeof state !== 'object') return null;
  const value = state as Partial<TicTacToeState>;
  if (value.game !== 'tic-tac-toe') return null;
  if (!Array.isArray(value.board) || value.board.length !== 9) return null;
  if (!Array.isArray(value.players) || value.players.length !== 2) return null;
  return value as TicTacToeState;
}

type Props = NativeStackScreenProps<RootStackParamList, 'TicTacToe'>;

export function TicTacToeScreen({ route, navigation }: Props) {
  const { runtime, identity, accountDetails, tokens } = useApp();
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
    partnerName: accountDetails?.partnerProfile?.displayName,
  });
  const ownMark = markForPlayer(self, board?.players);
  const winning = new Set(board === null ? [] : winningCells(board.board));
  const { boardSize, cellSize } = ticTacToeBoardLayout(viewportWidth);
  const cells = board?.board ?? Array<AccountId | null>(9).fill(null);

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

  async function cancelInvitation() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.deleteSession(id);
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      navigation.goBack();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens} topInset={false}>
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLiveRegion="polite"
        style={[styles.statusCard, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}
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

      <View
        style={[
          styles.grid,
          clayRaisedStyle(tokens),
          { width: boardSize, height: boardSize, backgroundColor: tokens.primary },
        ]}
      >
        {[0, 1, 2].map((row) => (
          <View key={`row-${row}`} style={styles.gridRow}>
            {cells.slice(row * 3, row * 3 + 3).map((cell, column) => {
              const index = row * 3 + column;
              const cellBackground = winning.has(index) ? tokens.accent : tokens.surfaceMuted;
              const mark = board === null ? '' : markForCell(cell, board.players);
              return (
                <Pressable
                  key={index}
                  accessibilityRole="button"
                  accessibilityLabel={`Row ${row + 1}, column ${column + 1}, ${mark === '' ? 'empty' : mark}`}
                  accessibilityHint={myTurn && cell === null ? 'Places your mark' : undefined}
                  accessibilityState={{ disabled: !myTurn || cell !== null }}
                  disabled={!myTurn || cell !== null}
                  onPress={() => {
                    void place(index);
                  }}
                  style={({ pressed }) => [
                    styles.cell,
                    pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                    {
                      backgroundColor: cellBackground,
                      opacity: pressed ? 0.82 : 1,
                      width: cellSize,
                      height: cellSize,
                    },
                  ]}
                >
                  {mark !== '' ? (
                    <TicTacToeMark
                      mark={mark as 'X' | 'O'}
                      tokens={tokens}
                      backgroundColor={cellBackground}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
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

      {cached?.state === 'pending' ? (
        <AppButton
          label="Cancel invitation"
          variant="quiet"
          tokens={tokens}
          disabled={busy}
          onPress={() => void cancelInvitation()}
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
    marginTop: 16,
    alignSelf: 'center',
    borderRadius: 32,
    padding: TIC_TAC_TOE_BOARD_PADDING,
    gap: TIC_TAC_TOE_CELL_GAP,
  },
  gridRow: { flexDirection: 'row', gap: TIC_TAC_TOE_CELL_GAP },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  banner: { marginTop: 16 },
});
