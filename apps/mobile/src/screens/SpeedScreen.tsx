import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutRectangle } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  isErr,
  sessionId,
  speedHasPlayableCard,
  speedRuleset,
  type SpeedMove,
  type SpeedState,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { asSpeedState, legalPileForCard, speedPlayer, speedStatus } from '../games/speed-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { PlayingCard } from '../ui/PlayingCard';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';

type Props = NativeStackScreenProps<RootStackParamList, 'Speed'>;

const WRONG_CARD_COOLDOWN_MS = 1_000;
const FEEDBACK_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const CARD_FLIGHT_MS = 140;
const CARD_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

interface CardFlight {
  readonly id: string;
  readonly card: NonNullable<ReturnType<typeof speedPlayer>>['hand'][number];
  readonly start: LayoutRectangle;
  readonly target: LayoutRectangle;
}

function FlyingCard({
  flight,
  tokens,
  onDone,
}: {
  readonly flight: CardFlight;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly onDone: (id: string) => void;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(
      withTiming(
        1,
        {
          duration: CARD_FLIGHT_MS,
          easing: CARD_EASE_OUT,
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished) scheduleOnRN(onDone, flight.id);
        },
      ),
    );
  }, [flight.id, onDone, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const value = progress.get();
    const targetX = flight.target.x + (flight.target.width - flight.start.width) / 2;
    const targetY = flight.target.y + (flight.target.height - flight.start.height) / 2;
    const targetScale = flight.target.width / flight.start.width;
    return {
      transform: [
        { translateX: (targetX - flight.start.x) * value },
        { translateY: (targetY - flight.start.y) * value },
        { scale: 1 + (targetScale - 1) * value },
      ],
      opacity: 1 - value * 0.12,
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.flyingCard, { left: flight.start.x, top: flight.start.y }, animatedStyle]}
    >
      <PlayingCard card={flight.card} tokens={tokens} disabled />
    </Animated.View>
  );
}

export function SpeedScreen({ route, navigation }: Props) {
  const { runtime, identity, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [optimisticState, setOptimisticState] = useState<SpeedState | null>(null);
  const [cooldownWarning, setCooldownWarning] = useState(false);
  const optimisticRef = useRef<SpeedState | null>(null);
  const moveQueue = useRef<SpeedMove[]>([]);
  const wrongCardCooldownUntil = useRef(0);
  const cooldownWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainingMoves = useRef(false);
  const [flights, setFlights] = useState<readonly CardFlight[]>([]);
  const tableFrame = useRef<LayoutRectangle | null>(null);
  const pileFrames = useRef<[LayoutRectangle | null, LayoutRectangle | null]>([null, null]);
  const pileCardFrames = useRef<[LayoutRectangle | null, LayoutRectangle | null]>([null, null]);
  const handFrame = useRef<LayoutRectangle | null>(null);
  const handCardFrames = useRef(new Map<string, LayoutRectangle>());

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(() => {
    runtime.connection.joinGame(id);
    return () => runtime.connection.leaveGame();
  }, [id, runtime.connection]);
  useEffect(
    () => () => {
      if (cooldownWarningTimer.current !== null) clearTimeout(cooldownWarningTimer.current);
    },
    [],
  );

  const session = runtime.rt.cached(id);
  const authoritativeState = asSpeedState(session?.gameState);
  const state = optimisticState ?? authoritativeState;
  const self = identity.session?.accountId;
  const mine = state === null ? undefined : speedPlayer(state, self);
  const theirs = state?.playerStates.find((player) => player.player !== self);
  const active = session?.state === 'active' && state?.status === 'in_progress';
  const blocked = active && state !== null && !speedHasPlayableCard(state);
  const ready = self !== undefined && state?.readyToFlip.includes(self);
  const partnerReady = state?.readyToFlip.some((player) => player !== self) ?? false;
  const status = speedStatus({
    sessionState: session?.state,
    state,
    self,
  });

  const removeFlight = useCallback((flightId: string) => {
    setFlights((current) => current.filter((item) => item.id !== flightId));
  }, []);

  function projectPending(base: SpeedState | null): SpeedState | null {
    if (base === null || self === undefined) return base;
    let projected = base;
    for (const move of moveQueue.current) {
      const result = speedRuleset.applyMove(projected, self, move);
      if (!isErr(result)) projected = result.value;
    }
    return projected;
  }

  function showOptimistic(next: SpeedState | null) {
    optimisticRef.current = next;
    setOptimisticState(next);
  }

  useEffect(() => {
    if (moveQueue.current.length === 0) {
      showOptimistic(null);
      return;
    }
    showOptimistic(projectPending(authoritativeState));
  }, [session?.gameState]);

  async function drainMoveQueue() {
    if (drainingMoves.current) return;
    drainingMoves.current = true;
    try {
      while (moveQueue.current.length > 0) {
        const move = moveQueue.current[0]!;
        const result = await runtime.rt.move(id, move);
        moveQueue.current.shift();
        if (isErr(result)) {
          await runtime.rt.refresh();
          setError(messageForError(result.error));
        }
        showOptimistic(projectPending(asSpeedState(runtime.rt.cached(id)?.gameState)));
      }
    } finally {
      drainingMoves.current = false;
      showOptimistic(null);
    }
  }

  function startWrongCardCooldown() {
    wrongCardCooldownUntil.current = Date.now() + WRONG_CARD_COOLDOWN_MS;
    setCooldownWarning(true);
    if (cooldownWarningTimer.current !== null) clearTimeout(cooldownWarningTimer.current);
    cooldownWarningTimer.current = setTimeout(() => {
      cooldownWarningTimer.current = null;
      setCooldownWarning(false);
    }, WRONG_CARD_COOLDOWN_MS);
  }

  function play(cardId: string): boolean | 'cooldown' {
    if (!active || self === undefined) return false;
    if (Date.now() < wrongCardCooldownUntil.current) return 'cooldown';
    const projected = optimisticRef.current ?? authoritativeState;
    if (projected === null) return false;
    const player = speedPlayer(projected, self);
    const card = player?.hand.find((candidate) => candidate.id === cardId);
    if (!card) return false;
    const pileIndex = legalPileForCard(projected, card);
    if (pileIndex === null) {
      startWrongCardCooldown();
      return false;
    }
    setError(null);
    const move: SpeedMove = { type: 'play', cardId, pile: pileIndex };
    const next = speedRuleset.applyMove(projected, self, move);
    if (isErr(next)) return false;
    const hand = handFrame.current;
    const cardFrame = handCardFrames.current.get(cardId);
    const table = tableFrame.current;
    const pileFrame = pileFrames.current[pileIndex];
    const pileCard = pileCardFrames.current[pileIndex];
    if (hand && cardFrame && table && pileFrame && pileCard) {
      setFlights((current) => [
        ...current,
        {
          id: `${cardId}-${Date.now()}`,
          card,
          start: { ...cardFrame, x: hand.x + cardFrame.x, y: hand.y + cardFrame.y },
          target: {
            ...pileCard,
            x: table.x + pileFrame.x + pileCard.x,
            y: table.y + pileFrame.y + pileCard.y,
          },
        },
      ]);
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    moveQueue.current.push(move);
    showOptimistic(next.value);
    void drainMoveQueue();
    return true;
  }

  async function readyToFlip() {
    if (!blocked || ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      let result = await runtime.rt.move(id, { type: 'ready_to_flip' });
      if (isErr(result)) {
        await runtime.rt.refresh();
        const refreshed = runtime.rt.cached(id);
        const refreshedState = asSpeedState(refreshed?.gameState);
        const shouldRetry =
          refreshed?.state === 'active' &&
          refreshedState !== null &&
          self !== undefined &&
          !refreshedState.readyToFlip.includes(self) &&
          !speedHasPlayableCard(refreshedState);
        if (shouldRetry) result = await runtime.rt.move(id, { type: 'ready_to_flip' });
        if (isErr(result)) setError(messageForError(result.error));
      }
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
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.status, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
          <AppText kind="title" tokens={tokens}>
            {status.title}
          </AppText>
          <AppText kind="muted" tokens={tokens} style={styles.statusDetail}>
            {status.detail}
          </AppText>
        </View>

        {state ? (
          <>
            <View style={styles.opponentRow}>
              <AppText kind="label" tokens={tokens}>
                Partner
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {theirs?.hand.length ?? 0} in hand · {theirs?.stock.length ?? 0} in stock
              </AppText>
            </View>

            <View
              style={styles.table}
              onLayout={(event) => {
                tableFrame.current = event.nativeEvent.layout;
              }}
            >
              <View
                style={styles.pileWrap}
                onLayout={(event) => {
                  pileFrames.current[0] = event.nativeEvent.layout;
                }}
              >
                <AppText kind="muted" tokens={tokens}>
                  {state.reservePiles[0].length} to flip
                </AppText>
                <PlayingCard
                  card={state.centerPiles[0].at(-1)!}
                  tokens={tokens}
                  compact
                  onLayout={(event) => {
                    pileCardFrames.current[0] = event.nativeEvent.layout;
                  }}
                />
              </View>
              <View
                style={styles.pileWrap}
                onLayout={(event) => {
                  pileFrames.current[1] = event.nativeEvent.layout;
                }}
              >
                <AppText kind="muted" tokens={tokens}>
                  {state.reservePiles[1].length} to flip
                </AppText>
                <PlayingCard
                  card={state.centerPiles[1].at(-1)!}
                  tokens={tokens}
                  compact
                  onLayout={(event) => {
                    pileCardFrames.current[1] = event.nativeEvent.layout;
                  }}
                />
              </View>
            </View>

            {blocked ? (
              <View
                style={[
                  styles.flipPrompt,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.warning },
                ]}
              >
                <AppText kind="body" tokens={tokens} style={styles.flipTitle}>
                  No moves. Ready to flip?
                </AppText>
                <AppText kind="muted" tokens={tokens} style={styles.flipDetail}>
                  {ready
                    ? 'You’re ready · waiting for your partner'
                    : partnerReady
                      ? 'Your partner is ready'
                      : 'Both players must be ready before the cards flip.'}
                </AppText>
                <AppButton
                  label={ready ? 'Waiting for partner…' : 'I’m ready'}
                  tokens={tokens}
                  disabled={busy || ready}
                  onPress={() => void readyToFlip()}
                />
              </View>
            ) : null}

            <View style={styles.handHeader}>
              <AppText kind="label" tokens={tokens}>
                Your hand
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {mine?.stock.length ?? 0} left in stock
              </AppText>
            </View>
            <View style={styles.cooldownSlot}>
              {cooldownWarning ? (
                <Animated.View
                  entering={FadeIn.duration(120)
                    .easing(FEEDBACK_EASE_OUT)
                    .reduceMotion(ReduceMotion.System)}
                  exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
                >
                  <AppText
                    accessibilityLiveRegion="polite"
                    kind="error"
                    tokens={tokens}
                    style={styles.cooldownWarning}
                  >
                    You’re on cooldown for trying to place the wrong card.
                  </AppText>
                </Animated.View>
              ) : null}
            </View>
            <View
              style={styles.hand}
              onLayout={(event) => {
                handFrame.current = event.nativeEvent.layout;
              }}
            >
              {mine?.hand.map((card) => {
                return (
                  <PlayingCard
                    key={card.id}
                    card={card}
                    tokens={tokens}
                    disabled={!active || busy}
                    onPress={() => play(card.id)}
                    onLayout={(event) => {
                      handCardFrames.current.set(card.id, event.nativeEvent.layout);
                    }}
                  />
                );
              })}
            </View>
          </>
        ) : (
          <AppText kind="muted" tokens={tokens} selectable>
            Invite sent · Session {id}
          </AppText>
        )}

        {session?.state === 'paused' ? (
          <AppButton label="Rejoin" tokens={tokens} disabled={busy} onPress={() => void rejoin()} />
        ) : null}
        {session?.state === 'pending' ? (
          <AppButton
            label="Cancel invitation"
            variant="quiet"
            tokens={tokens}
            disabled={busy}
            onPress={() => void cancelInvitation()}
          />
        ) : null}
        {error ? (
          <AppText kind="error" tokens={tokens} style={styles.error}>
            {error}
          </AppText>
        ) : null}
        {flights.map((flight) => (
          <FlyingCard key={flight.id} flight={flight} tokens={tokens} onDone={removeFlight} />
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  status: { borderRadius: 28, padding: 20, marginBottom: 20 },
  statusDetail: { marginTop: 4 },
  opponentRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  table: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginBottom: 22 },
  pileWrap: { alignItems: 'center', gap: 8 },
  flipPrompt: { borderRadius: 24, padding: 16, marginBottom: 22 },
  flipTitle: { fontWeight: '800' },
  flipDetail: { marginTop: 4, marginBottom: 14 },
  handHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  cooldownSlot: { minHeight: 22, justifyContent: 'center', marginBottom: 5 },
  cooldownWarning: { textAlign: 'center', fontSize: 12, lineHeight: 17 },
  hand: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 9,
    marginBottom: 24,
  },
  error: { marginTop: 16 },
  flyingCard: { position: 'absolute', zIndex: 20 },
});
