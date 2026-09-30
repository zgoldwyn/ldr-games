import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  DRAW_TOGETHER_MATCH_SECONDS,
  drawTogetherMatchRemainingMs,
  drawTogetherRemainingMs,
  sessionId,
  type DrawTogetherWordChoice,
} from '@ldr/core';

import { useApp } from '../app-context';
import {
  applyDrawStrokeBatch,
  type DrawStroke,
  type RemoteStrokeBuffer,
} from '../games/draw-together-canvas';
import {
  createDrawTogetherClient,
  drawTogetherState,
  type DrawTogetherResult,
  type DrawTogetherLiveChannel,
} from '../games/draw-together-client';
import {
  drawTogetherClockLabel,
  drawTogetherMissedAttempts,
  drawTogetherPhaseCopy,
  drawTogetherResultTitle,
} from '../games/draw-together-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { DrawTogetherCanvas } from '../ui/DrawTogetherCanvas';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

const DEFAULT_COLOR = '#312E3F';
const COLORS = [DEFAULT_COLOR, '#E04F67', '#EA8C3D', '#E1B52B', '#4B9B68', '#4385C1'];
const WIDTHS = [4, 8, 14] as const;

type Props = NativeStackScreenProps<RootStackParamList, 'DrawTogether'>;

export function DrawTogetherScreen({ route }: Props) {
  const { runtime, identity, accountDetails, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const self = identity.session?.accountId;
  const client = useMemo(() => createDrawTogetherClient(runtime.client), [runtime.client]);
  const liveRef = useRef<DrawTogetherLiveChannel | null>(null);
  const remoteBuffers = useRef(new Map<string, RemoteStrokeBuffer>());
  const timedOutTurn = useRef<number | null>(null);
  const advancedChoiceTurn = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const [clockNow, setClockNow] = useState(Date.now());
  const [choices, setChoices] = useState<readonly DrawTogetherWordChoice[]>([]);
  const [privateWord, setPrivateWord] = useState<string | null>(null);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [strokes, setStrokes] = useState<readonly DrawStroke[]>([]);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [strokeWidth, setStrokeWidth] = useState<(typeof WIDTHS)[number]>(8);
  const [guess, setGuess] = useState('');
  const [guessFeedback, setGuessFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { width: viewportWidth } = useWindowDimensions();
  const canvasSize = Math.min(400, Math.max(260, viewportWidth - 32));

  const cached = runtime.rt.cached(id);
  const state = drawTogetherState(cached);

  const consume = useCallback(
    (result: DrawTogetherResult): boolean => {
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      runtime.rt.applyRemoteState(result.value.session);
      setChoices(result.value.choices);
      setPrivateWord(result.value.word);
      if (result.value.bestScore !== null) setBestScore(result.value.bestScore);
      setError(null);
      return true;
    },
    [runtime.rt],
  );

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);

  useEffect(() => {
    runtime.connection.joinGame(id);
    liveRef.current = client.subscribeLive(id, {
      onStroke: (batch) => {
        const current = remoteBuffers.current.get(batch.strokeId);
        const result = applyDrawStrokeBatch(current, batch);
        if (result.kind !== 'applied') return;
        remoteBuffers.current.set(batch.strokeId, result.buffer);
        const next: DrawStroke = {
          id: batch.strokeId,
          color: result.buffer.color,
          width: result.buffer.width,
          points: result.buffer.points,
        };
        setStrokes((existing) => [
          ...existing.filter((stroke) => stroke.id !== batch.strokeId),
          next,
        ]);
      },
      onUndo: (strokeId) => {
        remoteBuffers.current.delete(strokeId);
        setStrokes((existing) => existing.filter((stroke) => stroke.id !== strokeId));
      },
      onClear: () => {
        remoteBuffers.current.clear();
        setStrokes([]);
      },
    });
    void runtime.rt.refresh();
    return () => {
      liveRef.current?.unsubscribe();
      liveRef.current = null;
      runtime.connection.leaveGame();
    };
  }, [client, id, runtime.connection, runtime.rt]);

  useEffect(() => {
    if (cached?.state !== 'active' || state === null) return;
    void client.state(id).then(consume);
  }, [cached?.state, client, consume, id, state?.drawer, state?.phase, state?.turn]);

  useEffect(() => {
    const handle = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(handle);
  }, []);

  useEffect(() => {
    setStrokes([]);
    remoteBuffers.current.clear();
    setGuess('');
    setGuessFeedback(null);
    timedOutTurn.current = null;
    advancedChoiceTurn.current = null;
  }, [state?.turn]);

  useEffect(() => {
    if (
      state?.phase !== 'choosing' ||
      state.choiceEndsAt === null ||
      clockNow < state.choiceEndsAt ||
      advancedChoiceTurn.current === state.turn
    ) {
      return;
    }
    advancedChoiceTurn.current = state.turn;
    void client.state(id).then(consume);
  }, [client, clockNow, consume, id, state]);

  useEffect(() => {
    if (
      state?.phase !== 'drawing' ||
      state.turnEndsAt === null ||
      self !== state.drawer ||
      clockNow < state.turnEndsAt ||
      timedOutTurn.current === state.turn
    ) {
      return;
    }
    timedOutTurn.current = state.turn;
    void client.timeout(id).then((result) => {
      consume(result);
      if (result.ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    });
  }, [client, clockNow, consume, id, self, state]);

  async function run(action: () => Promise<DrawTogetherResult>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      return consume(await action());
    } finally {
      setBusy(false);
    }
  }

  async function submitGuess() {
    const submitted = guess.trim();
    if (submitted.length === 0) return;
    setGuess('');
    const result = await client.guess(id, submitted);
    if (!result.ok) {
      consume(result);
      return;
    }
    consume(result);
    if (result.value.correct) {
      setGuessFeedback('Correct!');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setGuessFeedback(`“${submitted}” isn’t it—keep going.`);
    }
  }

  function undoStroke() {
    const latest = strokes.at(-1);
    if (latest === undefined) return;
    setStrokes((existing) => existing.slice(0, -1));
    void liveRef.current?.sendUndo(latest.id);
  }

  function clearCanvas() {
    setStrokes([]);
    remoteBuffers.current.clear();
    void liveRef.current?.sendClear();
  }

  const matchRemaining = drawTogetherMatchRemainingMs(state, clockNow);
  const turnRemaining = drawTogetherRemainingMs(state?.turnEndsAt ?? null, clockNow);
  const isDrawer = state?.drawer === self;
  const partnerName = accountDetails?.partnerProfile?.displayName;

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View
            accessible
            accessibilityRole="summary"
            accessibilityLiveRegion="polite"
            style={[styles.status, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}
          >
            <View style={styles.statusRow}>
              <View>
                <AppText kind="label" tokens={tokens}>
                  TEAM SCORE
                </AppText>
                <AppText kind="title" tokens={tokens}>
                  {state?.score ?? 0}
                </AppText>
              </View>
              <View style={styles.clockBlock}>
                <AppText kind="label" tokens={tokens}>
                  MATCH
                </AppText>
                <AppText kind="title" tokens={tokens}>
                  {drawTogetherClockLabel(matchRemaining)}
                </AppText>
              </View>
            </View>
            <AppText kind="muted" tokens={tokens} style={styles.phaseCopy}>
              {cached?.state === 'pending'
                ? `Invite sent. Waiting for ${partnerName ?? 'your partner'} to join.`
                : state === null
                  ? 'Loading the game…'
                  : drawTogetherPhaseCopy(state, self, partnerName)}
            </AppText>
          </View>

          {state?.phase === 'waiting' && self === state.drawer ? (
            <View style={styles.section}>
              <AppText kind="body" tokens={tokens} style={[styles.sectionTitle, styles.heading]}>
                How long should we play?
              </AppText>
              <View style={styles.durationRow}>
                {DRAW_TOGETHER_MATCH_SECONDS.map((duration) => (
                  <View key={duration} style={styles.durationButton}>
                    <AppButton
                      label={`${duration / 60} min`}
                      variant={duration === 300 ? 'primary' : 'quiet'}
                      tokens={tokens}
                      disabled={busy}
                      onPress={() => void run(() => client.start(id, duration))}
                    />
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {state?.phase === 'choosing' && isDrawer ? (
            <View style={styles.section}>
              <AppText kind="body" tokens={tokens} style={[styles.sectionTitle, styles.heading]}>
                Choose your word
              </AppText>
              {choices.map((choice) => (
                <Pressable
                  key={choice.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${choice.word}, ${choice.difficulty}`}
                  disabled={busy}
                  onPress={() => void run(() => client.choose(id, choice.id))}
                  style={({ pressed }) => [
                    styles.choice,
                    pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                    { backgroundColor: tokens.surfaceMuted },
                  ]}
                >
                  <AppText kind="body" tokens={tokens} style={styles.choiceWord}>
                    {choice.word}
                  </AppText>
                  <AppText kind="label" tokens={tokens}>
                    {choice.difficulty}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}

          {state?.phase === 'drawing' ? (
            <View style={styles.section}>
              <View style={styles.turnHeader}>
                <AppText kind="body" tokens={tokens} style={styles.heading}>
                  {isDrawer
                    ? (privateWord ?? 'Your word')
                    : (state.maskedWordPattern ?? `${state.maskedWordLength ?? 0} letters`)}
                </AppText>
                <AppText kind="title" tokens={tokens} style={{ color: tokens.error }}>
                  {drawTogetherClockLabel(turnRemaining)}
                </AppText>
              </View>
              <DrawTogetherCanvas
                width={canvasSize}
                height={canvasSize}
                strokes={strokes}
                color={color}
                strokeWidth={strokeWidth}
                backgroundColor={tokens.surface}
                disabled={!isDrawer}
                onStroke={(stroke) => setStrokes((existing) => [...existing, stroke])}
                onStrokeBatch={(batch) => {
                  void liveRef.current?.sendStroke(batch);
                }}
              />

              {isDrawer ? (
                <>
                  <View style={styles.tools}>
                    {COLORS.map((option) => (
                      <Pressable
                        key={option}
                        accessibilityRole="button"
                        accessibilityLabel={`Use ${option} ink`}
                        accessibilityState={{ selected: color === option }}
                        onPress={() => {
                          setColor(option);
                          void Haptics.selectionAsync();
                        }}
                        style={[
                          styles.swatch,
                          { backgroundColor: option },
                          color === option && {
                            borderColor: tokens.textPrimary,
                            borderWidth: 3,
                          },
                        ]}
                      />
                    ))}
                  </View>
                  <View style={styles.tools}>
                    {WIDTHS.map((option) => (
                      <Pressable
                        key={option}
                        accessibilityRole="button"
                        accessibilityLabel={`${option} point brush`}
                        accessibilityState={{ selected: strokeWidth === option }}
                        onPress={() => setStrokeWidth(option)}
                        style={[
                          styles.widthControl,
                          { backgroundColor: tokens.surfaceMuted },
                          strokeWidth === option && { borderColor: tokens.primaryStrong },
                        ]}
                      >
                        <View
                          style={{
                            width: option,
                            height: option,
                            borderRadius: option / 2,
                            backgroundColor: tokens.textPrimary,
                          }}
                        />
                      </Pressable>
                    ))}
                    <AppButton
                      label="Undo"
                      variant="quiet"
                      tokens={tokens}
                      disabled={strokes.length === 0}
                      onPress={undoStroke}
                      style={styles.toolButton}
                    />
                    <AppButton
                      label="Clear"
                      variant="quiet"
                      tokens={tokens}
                      disabled={strokes.length === 0}
                      onPress={clearCanvas}
                      style={styles.toolButton}
                    />
                  </View>
                </>
              ) : (
                <View style={styles.guessArea}>
                  <AppField
                    label="Your guess"
                    tokens={tokens}
                    value={guess}
                    onChangeText={setGuess}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="send"
                    onSubmitEditing={() => void submitGuess()}
                  />
                  <AppButton
                    label="Guess"
                    tokens={tokens}
                    disabled={guess.trim().length === 0 || busy}
                    onPress={() => void submitGuess()}
                  />
                  {guessFeedback !== null ? (
                    <AppText
                      kind="muted"
                      tokens={tokens}
                      accessibilityLiveRegion="polite"
                      style={styles.feedback}
                    >
                      {guessFeedback}
                    </AppText>
                  ) : null}
                </View>
              )}
            </View>
          ) : null}

          {state?.phase === 'finished' ? (
            <View style={styles.section}>
              <AppText kind="title" tokens={tokens} style={styles.sectionTitle}>
                {drawTogetherResultTitle(state, bestScore)}
              </AppText>
              <AppText kind="body" tokens={tokens} style={styles.heading}>
                {state.score} points · {state.solvedCount} solved
              </AppText>
              {bestScore !== null ? (
                <AppText kind="muted" tokens={tokens} style={styles.feedback}>
                  Best for {state.matchDurationSeconds / 60} minutes: {bestScore}
                </AppText>
              ) : null}
              <AppText kind="body" tokens={tokens} style={[styles.missedTitle, styles.heading]}>
                Words We Missed
              </AppText>
              {drawTogetherMissedAttempts(state).length === 0 ? (
                <AppText kind="muted" tokens={tokens}>
                  None—you got every selected word.
                </AppText>
              ) : (
                drawTogetherMissedAttempts(state).map((attempt) => (
                  <View
                    key={`${attempt.turn}-${attempt.word}`}
                    style={[
                      styles.missedWord,
                      clayRaisedStyle(tokens, true),
                      { backgroundColor: tokens.surfaceMuted },
                    ]}
                  >
                    <AppText kind="body" tokens={tokens} style={styles.choiceWord}>
                      {attempt.word}
                    </AppText>
                    <AppText kind="label" tokens={tokens}>
                      {attempt.difficulty} · {Math.ceil(attempt.elapsedMs / 1_000)}s
                    </AppText>
                  </View>
                ))
              )}
            </View>
          ) : null}

          {error !== null ? (
            <AppText kind="error" tokens={tokens} accessibilityLiveRegion="assertive">
              {error}
            </AppText>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },
  status: { borderRadius: 26, padding: 18 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between' },
  clockBlock: { alignItems: 'flex-end' },
  phaseCopy: { marginTop: 10 },
  section: { marginTop: 20 },
  sectionTitle: { marginBottom: 14 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  durationRow: { flexDirection: 'row', gap: 10 },
  durationButton: { flex: 1 },
  choice: {
    minHeight: 64,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  choiceWord: { fontWeight: '700' },
  turnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  swatch: { width: 44, height: 44, borderRadius: 22 },
  widthControl: {
    width: 48,
    height: 48,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolButton: { minWidth: 92 },
  guessArea: { marginTop: 18 },
  feedback: { marginTop: 12 },
  missedTitle: { marginTop: 28, marginBottom: 12 },
  missedWord: {
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
