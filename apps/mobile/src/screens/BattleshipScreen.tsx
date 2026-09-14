import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  isErr,
  sessionId,
  type AccountId,
  type BattleshipFleet,
  type BattleshipState,
  type Cell,
  type Shot,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import {
  canAddShip,
  fleetCells,
  isCompleteFleet,
  nextShipLength,
  shipAt,
  type ShipOrientation,
} from '../games/battleship-fleet';
import { battleshipStatus, battleshipTurnError } from '../games/battleship-view';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { AppButton } from '../ui/AppButton';
import { Screen } from '../ui/Screen';

const CELL_SIZE = 44;

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
  const { runtime, identity, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftFleet, setDraftFleet] = useState<BattleshipFleet>([]);
  const [orientation, setOrientation] = useState<ShipOrientation>('horizontal');

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
  const phase =
    board?.phase ??
    (board !== null && Object.keys(board.ships ?? {}).length > 0 ? 'playing' : 'placement');
  const fleetSubmitted = self !== undefined && board?.readyPlayers?.includes(self) === true;
  const status = battleshipStatus({
    sessionState: cached?.state,
    phase,
    fleetSubmitted,
    myTurn,
    winner: cached?.outcome?.winner,
    self,
  });

  useEffect(() => {
    if (self === undefined) return;
    void runtime.asyncGames.loadOwnBattleshipFleet(id).then((fleet) => {
      if (fleet !== undefined) setDraftFleet(fleet);
    });
  }, [id, runtime.asyncGames, self]);

  function placeNextShip(row: number, col: number) {
    if (fleetSubmitted || busy) return;
    const length = nextShipLength(draftFleet);
    if (length === undefined) return;
    const ship = shipAt(row, col, length, orientation);
    if (!canAddShip(draftFleet, ship, size)) {
      setError('That ship would overlap another ship or extend beyond the board.');
      return;
    }
    setError(null);
    setDraftFleet([...draftFleet, ship]);
  }

  async function submitFleet() {
    if (!isCompleteFleet(draftFleet)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.asyncGames.placeBattleshipFleet(id, draftFleet);
      if (isErr(result)) setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

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
      if (isErr(result)) {
        await runtime.asyncGames.refresh();
        const fresh = runtime.asyncGames.cached(id);
        const freshBoard = asBattleship(fresh?.gameState);
        const freshPhase = freshBoard?.phase ?? phase;
        const freshShots = self === undefined ? undefined : freshBoard?.shots[self];
        const specific = battleshipTurnError({
          code: result.error.code,
          phase: freshPhase,
          myTurn:
            self !== undefined && fresh?.state === 'active' && fresh.activeTurnHolder === self,
          alreadyTargeted: shotAt(freshShots, row, col) !== undefined,
          terminal: fresh?.state === 'terminal',
        });
        setError(specific ?? messageForError(result.error));
      }
    } finally {
      setBusy(false);
    }
  }

  const privateFleet = runtime.asyncGames.ownBattleshipFleet(id);
  const ownShips =
    privateFleet !== undefined || draftFleet.length > 0
      ? fleetCells(privateFleet ?? draftFleet)
      : self === undefined
        ? []
        : (board?.ships[self] ?? []);
  const shotsFired = self !== undefined ? board?.shots[self] : undefined;
  const incoming = partner !== undefined ? board?.shots[partner] : undefined;

  return (
    <Screen tokens={tokens}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          style={[styles.statusCard, { backgroundColor: tokens.surfaceMuted }]}
        >
          <AppText kind="title" tokens={tokens} style={styles.statusTitle}>
            {status.title}
          </AppText>
          <AppText kind="muted" tokens={tokens}>
            {status.detail}
          </AppText>
        </View>

        {phase === 'placement' ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Place your fleet
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.instructions}>
              {fleetSubmitted
                ? 'Fleet locked in. Waiting for your partner to finish placing theirs.'
                : nextShipLength(draftFleet) === undefined
                  ? 'All five ships are placed. Lock in your fleet when ready.'
                  : `Tap the starting square for your ${nextShipLength(draftFleet)}-cell ship. Ships cannot overlap.`}
            </AppText>
            {!fleetSubmitted ? (
              <View style={styles.controls}>
                <AppButton
                  variant="quiet"
                  label={orientation === 'horizontal' ? 'Horizontal ↔' : 'Vertical ↕'}
                  tokens={tokens}
                  onPress={() =>
                    setOrientation((current) =>
                      current === 'horizontal' ? 'vertical' : 'horizontal',
                    )
                  }
                />
                <View style={styles.spacer} />
                <AppButton
                  variant="quiet"
                  label="Undo last"
                  tokens={tokens}
                  disabled={draftFleet.length === 0}
                  onPress={() => setDraftFleet(draftFleet.slice(0, -1))}
                />
              </View>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={[styles.grid, { width: size * CELL_SIZE }]}>
                {Array.from({ length: size * size }, (_, index) => {
                  const row = Math.floor(index / size);
                  const col = index % size;
                  const occupied = hasShip(ownShips, row, col);
                  return (
                    <Pressable
                      key={`p-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Your waters, row ${row + 1}, column ${col + 1}, ${occupied ? 'ship' : 'empty'}`}
                      accessibilityHint={
                        fleetSubmitted ? undefined : `Places the next ${orientation} ship here`
                      }
                      accessibilityState={{ disabled: fleetSubmitted }}
                      disabled={fleetSubmitted}
                      onPress={() => placeNextShip(row, col)}
                      style={[
                        styles.cell,
                        {
                          backgroundColor: occupied ? tokens.primary : tokens.surface,
                          borderColor: tokens.border,
                        },
                      ]}
                    >
                      <AppText kind="label" tokens={tokens} style={styles.marker}>
                        {occupied ? 'S' : ''}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            {!fleetSubmitted && isCompleteFleet(draftFleet) ? (
              <View style={styles.submit}>
                <AppButton
                  label={busy ? 'Locking in…' : 'Lock in fleet'}
                  tokens={tokens}
                  disabled={busy}
                  onPress={() => void submitFleet()}
                />
              </View>
            ) : null}
          </>
        ) : (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Their waters
            </AppText>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={[styles.grid, { width: size * CELL_SIZE }]}>
                {Array.from({ length: size * size }, (_, index) => {
                  const row = Math.floor(index / size);
                  const col = index % size;
                  const shot = shotAt(shotsFired, row, col);
                  return (
                    <Pressable
                      key={`r-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Their waters, row ${row + 1}, column ${col + 1}, ${shot === undefined ? 'not targeted' : shot.hit ? 'hit' : 'miss'}`}
                      accessibilityHint={
                        myTurn && shot === undefined ? 'Fires at this square' : undefined
                      }
                      accessibilityState={{ disabled: !myTurn || shot !== undefined }}
                      disabled={!myTurn || shot !== undefined}
                      onPress={() => {
                        void fire(row, col);
                      }}
                      style={[
                        styles.cell,
                        {
                          backgroundColor:
                            shot === undefined
                              ? tokens.surface
                              : shot.hit
                                ? tokens.error
                                : tokens.surfaceMuted,
                          borderColor: tokens.border,
                        },
                      ]}
                    >
                      <AppText
                        kind="label"
                        tokens={tokens}
                        style={[styles.marker, shot?.hit ? { color: tokens.surface } : undefined]}
                      >
                        {shot === undefined ? '' : shot.hit ? 'H' : 'M'}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </>
        )}

        {phase === 'playing' ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Your waters
            </AppText>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={[styles.grid, { width: size * CELL_SIZE }]}>
                {Array.from({ length: size * size }, (_, index) => {
                  const row = Math.floor(index / size);
                  const col = index % size;
                  const ship = hasShip(ownShips, row, col);
                  const hit = shotAt(incoming, row, col);
                  return (
                    <View
                      key={`h-${index}`}
                      accessible
                      accessibilityLabel={`Your waters, row ${row + 1}, column ${col + 1}, ${hit?.hit ? 'ship hit' : hit !== undefined ? 'miss' : ship ? 'ship' : 'empty'}`}
                      style={[
                        styles.cell,
                        {
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
                    >
                      <AppText
                        kind="label"
                        tokens={tokens}
                        style={[styles.marker, hit?.hit ? { color: tokens.surface } : undefined]}
                      >
                        {hit?.hit ? 'H' : hit !== undefined ? 'M' : ship ? 'S' : ''}
                      </AppText>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </>
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32 },
  statusCard: { borderRadius: 20, padding: 18, marginBottom: 8 },
  statusTitle: { marginBottom: 4 },
  instructions: { marginBottom: 12 },
  controls: { marginBottom: 12 },
  spacer: { height: 8 },
  submit: { marginTop: 16 },
  section: { marginTop: 20, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marker: { fontWeight: '700' },
  banner: { marginTop: 16 },
});
