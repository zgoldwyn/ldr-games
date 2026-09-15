import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  isErr,
  sessionId,
  type AccountId,
  type BattleshipState,
  type Cell,
  type ShipPlacement,
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
  randomizeDraftFleet,
  rotateDraftShipNearest,
  type DraftShipId,
} from '../games/battleship-placement';
import { battleshipStatus, battleshipTurnError } from '../games/battleship-view';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { AppButton } from '../ui/AppButton';
import { Screen } from '../ui/Screen';
import { BattleshipResultCard } from '../ui/BattleshipResultCard';
import { BattleshipShipArt } from '../ui/BattleshipShipArt';
import { DraggableShip } from '../ui/DraggableShip';
import { clayRaisedStyle } from '../ui/clay';
import hitMarker from '../../assets/battleship-hit.png';

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

function placementLayout(placement: ShipPlacement): {
  readonly row: number;
  readonly col: number;
  readonly orientation: 'horizontal' | 'vertical';
} | null {
  const anchor = placement[0];
  if (anchor === undefined) return null;
  return {
    row: Math.min(...placement.map((cell) => cell.row)),
    col: Math.min(...placement.map((cell) => cell.col)),
    orientation:
      placement.length > 1 && placement.every((cell) => cell.col === anchor.col)
        ? 'vertical'
        : 'horizontal',
  };
}

function ShotMarker({ shot, cellSize }: { readonly shot: Shot; readonly cellSize: number }) {
  return shot.hit ? (
    <Image
      accessible={false}
      resizeMode="contain"
      source={hitMarker}
      style={{ width: cellSize * 0.82, height: cellSize * 0.82 }}
    />
  ) : (
    <View
      accessible={false}
      style={[
        styles.missDot,
        {
          width: Math.max(5, cellSize * 0.18),
          height: Math.max(5, cellSize * 0.18),
          borderRadius: cellSize,
        },
      ]}
    />
  );
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
  const ownDisplayShips = privateFleet === undefined ? draftShips : createDraftShips(privateFleet);
  const sunkOpponentShips =
    self === undefined
      ? []
      : (board?.sunkShips?.[self] ??
        (shotsFired ?? []).flatMap((shot) => (shot.sunkShip === undefined ? [] : [shot.sunkShip])));
  const terminal = cached?.state === 'terminal';
  const won = terminal && cached?.outcome?.winner === self;

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

        {terminal ? <BattleshipResultCard won={won} tokens={tokens} /> : null}

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
                        disabled={busy || ship.placement !== null}
                        cellSize={18}
                        dragScale={cellSize / 18}
                        dimmed={ship.placement !== null}
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
                  <View style={styles.fleetActions}>
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
                    <View style={styles.resetButton}>
                      <AppButton
                        variant="quiet"
                        label="Random fleet"
                        tokens={tokens}
                        disabled={busy}
                        onPress={() => {
                          setDraftShips(randomizeDraftFleet());
                          setError(null);
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        }}
                      />
                    </View>
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
            <AppText
              kind="label"
              tokens={tokens}
              style={[styles.section, terminal && styles.finishedGame]}
            >
              Their waters
            </AppText>
            <View
              style={[
                styles.gameplayFrame,
                terminal && styles.finishedGame,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <View
                style={[
                  styles.gameplayGrid,
                  { width: boardSize, height: boardSize, backgroundColor: tokens.surface },
                ]}
              >
                {placementRows.map((rowCells, row) => (
                  <View key={`their-row-${row}`} style={styles.placementRow}>
                    {rowCells.map(({ col }) => {
                      const shot = shotAt(shotsFired, row, col);
                      const partOfSunkShip = sunkOpponentShips.some((ship) =>
                        hasShip(ship, row, col),
                      );
                      return (
                        <Pressable
                          key={`their-${row}-${col}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Their waters, row ${row + 1}, column ${col + 1}, ${shot === undefined ? 'not targeted' : shot.hit ? (partOfSunkShip ? 'hit, ship sunk' : 'hit') : 'miss'}`}
                          accessibilityHint={
                            myTurn && shot === undefined ? 'Fires at this square' : undefined
                          }
                          accessibilityState={{ disabled: !myTurn || shot !== undefined }}
                          disabled={!myTurn || shot !== undefined}
                          onPress={() => void fire(row, col)}
                          style={[
                            styles.gameplayCell,
                            {
                              width: cellSize,
                              height: cellSize,
                              borderColor: tokens.border,
                            },
                          ]}
                        />
                      );
                    })}
                  </View>
                ))}
                {sunkOpponentShips.map((ship, index) => {
                  const layout = placementLayout(ship);
                  if (layout === null) return null;
                  return (
                    <View
                      key={`sunk-${index}-${layout.row}-${layout.col}`}
                      pointerEvents="none"
                      style={[
                        styles.gameplayShip,
                        { left: layout.col * cellSize, top: layout.row * cellSize },
                      ]}
                    >
                      <BattleshipShipArt
                        length={ship.length}
                        orientation={layout.orientation}
                        tokens={tokens}
                        cellSize={cellSize}
                      />
                    </View>
                  );
                })}
                {(shotsFired ?? []).map((shot) => (
                  <View
                    key={`their-shot-${shot.row}-${shot.col}`}
                    pointerEvents="none"
                    style={[
                      styles.shotMarker,
                      {
                        left: shot.col * cellSize,
                        top: shot.row * cellSize,
                        width: cellSize,
                        height: cellSize,
                      },
                    ]}
                  >
                    <ShotMarker shot={shot} cellSize={cellSize} />
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {phase === 'playing' ? (
          <>
            <AppText
              kind="label"
              tokens={tokens}
              style={[styles.section, terminal && styles.finishedGame]}
            >
              Your waters
            </AppText>
            <View
              style={[
                styles.gameplayFrame,
                terminal && styles.finishedGame,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <View
                style={[
                  styles.gameplayGrid,
                  { width: boardSize, height: boardSize, backgroundColor: tokens.surface },
                ]}
              >
                {placementRows.map((rowCells, row) => (
                  <View key={`own-row-${row}`} style={styles.placementRow}>
                    {rowCells.map(({ col }) => {
                      const ship = hasShip(ownShips, row, col);
                      const shot = shotAt(incoming, row, col);
                      return (
                        <View
                          key={`own-${row}-${col}`}
                          accessible
                          accessibilityLabel={`Your waters, row ${row + 1}, column ${col + 1}, ${shot?.hit ? 'ship hit' : shot !== undefined ? 'miss' : ship ? 'ship' : 'empty'}`}
                          style={[
                            styles.gameplayCell,
                            {
                              width: cellSize,
                              height: cellSize,
                              borderColor: tokens.border,
                            },
                          ]}
                        />
                      );
                    })}
                  </View>
                ))}
                {ownDisplayShips.map((ship) => {
                  const anchor = ship.placement?.[0];
                  if (anchor === undefined) return null;
                  return (
                    <View
                      key={`own-ship-${ship.id}`}
                      pointerEvents="none"
                      style={[
                        styles.gameplayShip,
                        { left: anchor.col * cellSize, top: anchor.row * cellSize },
                      ]}
                    >
                      <BattleshipShipArt
                        length={ship.length}
                        orientation={ship.orientation}
                        tokens={tokens}
                        cellSize={cellSize}
                      />
                    </View>
                  );
                })}
                {(incoming ?? []).map((shot) => (
                  <View
                    key={`incoming-${shot.row}-${shot.col}`}
                    pointerEvents="none"
                    style={[
                      styles.shotMarker,
                      {
                        left: shot.col * cellSize,
                        top: shot.row * cellSize,
                        width: cellSize,
                        height: cellSize,
                      },
                    ]}
                  >
                    <ShotMarker shot={shot} cellSize={cellSize} />
                  </View>
                ))}
              </View>
            </View>
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
  fleetActions: { flexDirection: 'row', gap: 6 },
  resetButton: { minWidth: 112 },
  submit: { marginTop: 16 },
  section: { marginTop: 20, marginBottom: 8 },
  placementGrid: { alignSelf: 'center', position: 'relative', overflow: 'visible', zIndex: 1 },
  placementRow: { flexDirection: 'row' },
  placementCell: { borderWidth: StyleSheet.hairlineWidth },
  placedShip: { position: 'absolute', zIndex: 5 },
  gameplayFrame: {
    alignSelf: 'center',
    borderRadius: 24,
    padding: 6,
  },
  gameplayGrid: {
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  gameplayCell: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  gameplayShip: { position: 'absolute', zIndex: 2 },
  shotMarker: {
    position: 'absolute',
    zIndex: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  missDot: { backgroundColor: '#111111' },
  finishedGame: { opacity: 0.32 },
  banner: { marginTop: 16 },
});
