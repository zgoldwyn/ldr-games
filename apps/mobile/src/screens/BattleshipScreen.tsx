import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  isErr,
  sessionId,
  type AccountId,
  type BattleshipState,
  type Cell,
  type Shot,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import type { RootStackParamList } from '../navigation';
import { themeTokens } from '../theme';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

function asBattleship(state: unknown): BattleshipState | null {
  if (state === null || typeof state !== 'object') return null;
  const value = state as { kind?: string; ruleset?: unknown };
  const ruleset = value.kind === 'battleship' ? value : value.ruleset;
  if (ruleset === null || typeof ruleset !== 'object') return null;
  const board = ruleset as Partial<BattleshipState>;
  if (board.kind !== 'battleship' || typeof board.size !== 'number') return null;
  return board as BattleshipState;
}

function shotAt(shots: readonly Shot[] | undefined, row: number, col: number): Shot | undefined {
  return shots?.find((s) => s.row === row && s.col === col);
}

function hasShip(ships: readonly Cell[] | undefined, row: number, col: number): boolean {
  return ships?.some((c) => c.row === row && c.col === col) ?? false;
}

type Props = NativeStackScreenProps<RootStackParamList, 'Battleship'>;

export function BattleshipScreen({ route }: Props) {
  const tokens = themeTokens();
  const { runtime, identity } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => runtime.asyncGames.subscribe(() => setTick((n) => n + 1)), [runtime.asyncGames]);

  const cached = runtime.asyncGames.cached(id);
  const board = asBattleship(cached?.gameState);
  const self = identity.session?.accountId;
  const pairing = identity.pairing;
  const partner: AccountId | undefined =
    pairing === undefined || pairing === null || self === undefined
      ? undefined
      : pairing.memberA === self
        ? pairing.memberB
        : pairing.memberA;
  const myTurn =
    self !== undefined && cached !== undefined && runtime.asyncGames.isMyTurn(id, self);
  const size = board?.size ?? 10;

  async function fire(row: number, col: number) {
    if (!myTurn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.asyncGames.takeTurn(id, {
        kind: 'battleship.fire',
        row,
        col,
      });
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

  const ownShips = self !== undefined ? board?.ships[self] : undefined;
  const shotsFired = self !== undefined ? board?.shots[self] : undefined;
  const incoming = partner !== undefined ? board?.shots[partner] : undefined;

  return (
    <Screen tokens={tokens}>
      <ScrollView>
        <AppText kind="muted" tokens={tokens} style={styles.status}>
          {cached?.state ?? 'unknown'}
          {myTurn ? ' · Your shot' : " · Partner's shot"}
          {cached?.outcome !== undefined
            ? cached.outcome.winner === self
              ? ' · You won'
              : ' · Partner won'
            : ''}
        </AppText>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Their waters
        </AppText>
        <View style={styles.grid}>
          {Array.from({ length: size * size }, (_, index) => {
            const row = Math.floor(index / size);
            const col = index % size;
            const shot = shotAt(shotsFired, row, col);
            return (
              <Pressable
                key={`r-${index}`}
                disabled={!myTurn || shot !== undefined}
                onPress={() => {
                  void fire(row, col);
                }}
                style={[
                  styles.cell,
                  {
                    width: `${100 / size}%`,
                    backgroundColor:
                      shot === undefined
                        ? tokens.surface
                        : shot.hit
                          ? tokens.error
                          : tokens.surfaceMuted,
                    borderColor: tokens.border,
                  },
                ]}
              />
            );
          })}
        </View>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Your waters
        </AppText>
        <View style={styles.grid}>
          {Array.from({ length: size * size }, (_, index) => {
            const row = Math.floor(index / size);
            const col = index % size;
            const ship = hasShip(ownShips, row, col);
            const hit = shotAt(incoming, row, col);
            return (
              <View
                key={`h-${index}`}
                style={[
                  styles.cell,
                  {
                    width: `${100 / size}%`,
                    backgroundColor: hit?.hit
                      ? tokens.error
                      : ship
                        ? tokens.primary
                        : hit !== undefined
                          ? tokens.surfaceMuted
                          : tokens.surface,
                    borderColor: tokens.border,
                  },
                ]}
              />
            );
          })}
        </View>

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
  status: { marginBottom: 8 },
  section: { marginTop: 20, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    aspectRatio: 1,
    borderWidth: StyleSheet.hairlineWidth,
  },
  banner: { marginTop: 16 },
});
