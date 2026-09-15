import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import * as Haptics from 'expo-haptics';
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
import { fleetCells, isCompleteFleet } from '../games/battleship-fleet';
import {
  battleshipGridRows,
  createDraftShips,
  fleetFromDraft,
  placeDraftShipNearest,
  placedShipCount,
  rotateDraftShipNearest,
  type DraftShipId,
} from '../games/battleship-placement';
import { battleshipStatus, battleshipTurnError } from '../games/battleship-view';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { AppButton } from '../ui/AppButton';
import { Screen } from '../ui/Screen';
import { DraggableShip } from '../ui/DraggableShip';
import { clayRaisedStyle } from '../ui/clay';

const MAX_BOARD_SIZE = 360;

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
  const [draggingShip, setDraggingShip] = useState(false);
  const [draftShips, setDraftShips] = useState(createDraftShips);
  const placementBoardRef = useRef<View>(null);
  const { width: viewportWidth } = useWindowDimensions();

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
  const boardSize = Math.min(MAX_BOARD_SIZE, viewportWidth - 48);
  const cellSize = boardSize / size;
  const placementRows = battleshipGridRows(size);
  const draftFleet = fleetFromDraft(draftShips);
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
      if (fleet !== undefined) setDraftShips(createDraftShips(fleet));
    });
  }, [id, runtime.asyncGames, self]);

  const rotateShip = useCallback(
    (shipId: DraftShipId) => {
      if (fleetSubmitted || busy) return;
      const result = rotateDraftShipNearest(draftShips, shipId, size);
      if (result.ships === draftShips) {
        setError('That ship cannot rotate on this board.');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setDraftShips(result.ships);
      setError(null);
      void Haptics.selectionAsync();
    },
    [busy, draftShips, fleetSubmitted, size],
  );

  const dropShip = useCallback(
    (shipId: DraftShipId, absoluteX: number, absoluteY: number, grabbedSegment: number) => {
      if (fleetSubmitted || busy) return;
      placementBoardRef.current?.measureInWindow((boardX, boardY, width, height) => {
        if (
          absoluteX < boardX ||
          absoluteX >= boardX + width ||
          absoluteY < boardY ||
          absoluteY >= boardY + height
        ) {
          setError('Drag the ship onto your ocean grid.');
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          return;
        }
        const ship = draftShips.find((item) => item.id === shipId);
        if (ship === undefined) return;
        const targetRow = Math.floor((absoluteY - boardY) / (height / size));
        const targetCol = Math.floor((absoluteX - boardX) / (width / size));
        const requestedRow =
          ship.orientation === 'vertical' ? targetRow - grabbedSegment : targetRow;
        const requestedCol =
          ship.orientation === 'horizontal' ? targetCol - grabbedSegment : targetCol;
        const result = placeDraftShipNearest(
          draftShips,
          shipId,
          requestedRow,
          requestedCol,
          ship.orientation,
          size,
        );
        if (result.placement === null) {
          setError('There is no open space for that ship. Move another ship and try again.');
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          return;
        }
        setDraftShips(result.ships);
        setError(null);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      });
    },
    [busy, draftShips, fleetSubmitted, size],
  );
  const beginShipDrag = useCallback(() => setDraggingShip(true), []);
  const endShipDrag = useCallback(() => setDraggingShip(false), []);

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
    privateFleet !== undefined || placedShipCount(draftShips) > 0
      ? fleetCells(privateFleet ?? draftFleet)
      : self === undefined
        ? []
        : (board?.ships[self] ?? []);
  const shotsFired = self !== undefined ? board?.shots[self] : undefined;
  const incoming = partner !== undefined ? board?.shots[partner] : undefined;

  return (
    <Screen tokens={tokens}>
      <ScrollView scrollEnabled={!draggingShip} contentContainerStyle={styles.scroll}>
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
        </View>

        {phase === 'placement' ? (
          <>
            <AppText kind="label" tokens={tokens} style={styles.section}>
              Place your fleet
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.instructions}>
              {fleetSubmitted
                ? 'Fleet locked in. Waiting for your partner to finish placing theirs.'
                : placedShipCount(draftShips) === draftShips.length
                  ? 'All five ships are placed. Tap one to rotate it, or drag it again to move it.'
                  : 'Drag each ship from the dock onto the grid. Tap a ship to rotate it.'}
            </AppText>
            {!fleetSubmitted ? (
              <>
                <View
                  style={[
                    styles.shipDock,
                    clayRaisedStyle(tokens),
                    { backgroundColor: tokens.surface, borderColor: tokens.primary },
                  ]}
                  accessibilityLabel="Your shipyard"
                >
                  <AppText kind="label" tokens={tokens} style={styles.shipDockTitle}>
                    Shipyard · tap a hull to rotate
                  </AppText>
                  <View style={styles.shipRack}>
                    {draftShips.map((ship) => (
                      <DraggableShip
                        key={ship.id}
                        ship={ship}
                        tokens={tokens}
                        disabled={busy}
                        cellSize={22}
                        dragScale={cellSize / 22}
                        showDetails
                        onDrop={dropShip}
                        onDragStart={beginShipDrag}
                        onDragEnd={endShipDrag}
                        onRotate={rotateShip}
                      />
                    ))}
                  </View>
                </View>
                <View style={styles.resetRow}>
                  <AppText kind="muted" tokens={tokens}>
                    {placedShipCount(draftShips)} of {draftShips.length} placed
                  </AppText>
                  <View style={styles.resetButton}>
                    <AppButton
                      variant="quiet"
                      label="Reset fleet"
                      tokens={tokens}
                      disabled={placedShipCount(draftShips) === 0}
                      onPress={() => {
                        setDraftShips(createDraftShips());
                        setError(null);
                      }}
                    />
                  </View>
                </View>
              </>
            ) : null}
            <View
              ref={placementBoardRef}
              collapsable={false}
              style={[
                styles.placementGrid,
                { width: boardSize, height: boardSize, backgroundColor: tokens.surface },
              ]}
            >
              {placementRows.map((rowCells, row) => (
                <View key={`row-${row}`} style={styles.placementRow}>
                  {rowCells.map(({ col }) => (
                    <View
                      key={`p-${row}-${col}`}
                      accessible
                      accessibilityLabel={`Your waters, row ${row + 1}, column ${col + 1}`}
                      style={[
                        styles.placementCell,
                        {
                          width: cellSize,
                          height: cellSize,
                          borderColor: tokens.border,
                        },
                      ]}
                    />
                  ))}
                </View>
              ))}
              {draftShips.map((ship) => {
                const anchor = ship.placement?.[0];
                if (anchor === undefined) return null;
                return (
                  <View
                    key={`placed-${ship.id}`}
                    style={[
                      styles.placedShip,
                      { left: anchor.col * cellSize, top: anchor.row * cellSize },
                    ]}
                  >
                    <DraggableShip
                      ship={ship}
                      tokens={tokens}
                      disabled={busy || fleetSubmitted}
                      cellSize={cellSize}
                      onDrop={dropShip}
                      onDragStart={beginShipDrag}
                      onDragEnd={endShipDrag}
                      onRotate={rotateShip}
                    />
                  </View>
                );
              })}
            </View>
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
              <View style={[styles.grid, { width: size * 44 }]}>
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
              <View style={[styles.grid, { width: size * 44 }]}>
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
  statusCard: { borderRadius: 28, padding: 20, marginBottom: 8 },
  statusTitle: { marginBottom: 4 },
  instructions: { marginBottom: 12 },
  shipDock: {
    overflow: 'visible',
    zIndex: 20,
    borderRadius: 28,
    padding: 12,
  },
  shipDockTitle: { marginBottom: 4 },
  shipRack: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'visible',
  },
  resetRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 8,
  },
  resetButton: { minWidth: 132 },
  submit: { marginTop: 16 },
  section: { marginTop: 20, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  placementGrid: { alignSelf: 'center', position: 'relative', overflow: 'visible', zIndex: 1 },
  placementRow: { flexDirection: 'row' },
  placementCell: { borderWidth: StyleSheet.hairlineWidth },
  placedShip: { position: 'absolute', zIndex: 5 },
  cell: {
    width: 44,
    height: 44,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marker: { fontWeight: '700' },
  banner: { marginTop: 16 },
});
