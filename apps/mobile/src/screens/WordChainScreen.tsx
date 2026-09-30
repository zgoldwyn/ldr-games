import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ScrollView as ScrollViewType,
  type TextInput,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ERROR_CODES,
  isErr,
  requiredWordChainLengths,
  requiredWordChainLetter,
  sessionId,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { asWordChainState, wordChainRole, wordChainStatus } from '../games/word-chain-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { WordChainResultCard } from '../ui/WordChainResultCard';
import { clayRaisedStyle } from '../ui/clay';

type Props = NativeStackScreenProps<RootStackParamList, 'WordChain'>;

export function WordChainScreen({ route, navigation }: Props) {
  const { runtime, identity, accountDetails, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollViewType>(null);

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setRefreshing(true);
      void runtime.rt.refresh().finally(() => {
        if (active) setRefreshing(false);
      });
      return () => {
        active = false;
      };
    }, [runtime.rt]),
  );
  useEffect(() => {
    runtime.connection.joinGame(id);
    return () => runtime.connection.leaveGame();
  }, [id, runtime.connection]);

  const session = runtime.rt.cached(id);
  const state = asWordChainState(session?.gameState);
  const self = identity.session?.accountId;
  const myTurn =
    session?.state === 'active' &&
    state?.status === 'in_progress' &&
    self !== undefined &&
    state.currentTurn === self;
  const status = wordChainStatus({
    sessionState: session?.state,
    state,
    self,
    partnerName: accountDetails?.partnerProfile?.displayName,
  });
  const role = state === null ? null : wordChainRole(state, self);
  const requiredLetter = state === null ? null : requiredWordChainLetter(state);
  const requiredLengths = state === null ? null : requiredWordChainLengths(state);
  const partnerName = accountDetails?.partnerProfile?.displayName?.trim() || 'Partner';
  const sessionUnavailable = !refreshing && session === undefined;
  const stateUnavailable =
    !refreshing && session !== undefined && session.state !== 'pending' && state === null;

  useEffect(() => {
    if (state?.status === 'won') {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    } else if (state?.words.length) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [state?.status, state?.words.length]);

  async function submit() {
    if (!myTurn || busy || word.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.move(id, { type: 'submit_word', word });
      if (isErr(result)) {
        setError(
          result.error.code === ERROR_CODES.INVALID_MOVE
            ? result.error.message
            : messageForError(result.error),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setWord('');
      inputRef.current?.blur();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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

  async function giveUp() {
    if (!myTurn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.move(id, { type: 'give_up' });
      if (isErr(result)) {
        setError(messageForError(result.error));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      inputRef.current?.blur();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } finally {
      setBusy(false);
    }
  }

  function confirmGiveUp() {
    Alert.alert(
      'Give up this round?',
      `${partnerName} will win. Only give up when you cannot find a valid word.`,
      [
        { text: 'Keep thinking', style: 'cancel' },
        { text: 'Give up', style: 'destructive', onPress: () => void giveUp() },
      ],
    );
  }

  async function refreshSession() {
    setRefreshing(true);
    setError(null);
    try {
      await runtime.rt.refresh();
    } finally {
      setRefreshing(false);
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          ref={scrollRef}
        >
          <View
            accessible
            accessibilityRole="summary"
            accessibilityLiveRegion="polite"
            style={[
              styles.status,
              clayRaisedStyle(tokens),
              {
                backgroundColor:
                  state?.status === 'won'
                    ? tokens.success
                    : session?.state === 'paused'
                      ? tokens.warning
                      : myTurn
                        ? tokens.primary
                        : tokens.surfaceMuted,
              },
            ]}
          >
            <View style={styles.statusHeading}>
              <View style={styles.statusCopy}>
                <AppText kind="label" tokens={tokens} style={styles.eyebrow}>
                  {state?.status === 'won'
                    ? 'ROUND COMPLETE'
                    : session?.state === 'active'
                      ? 'LIVE WORD CHAIN'
                      : 'WORD CHAIN'}
                </AppText>
                <AppText kind="title" tokens={tokens}>
                  {status.title}
                </AppText>
              </View>
              {state !== null ? (
                <View style={[styles.countBadge, { backgroundColor: tokens.surface }]}>
                  <AppText kind="title" tokens={tokens} style={styles.countNumber}>
                    {state.words.length}
                  </AppText>
                  <AppText kind="label" tokens={tokens} style={styles.countTotal}>
                    WORDS
                  </AppText>
                </View>
              ) : null}
            </View>
            <AppText kind="muted" tokens={tokens} style={styles.statusDetail}>
              {status.detail}
            </AppText>
            {state !== null ? (
              <View style={styles.progressBlock}>
                <View style={styles.progressRow}>
                  <AppText kind="label" tokens={tokens}>
                    LONGEST · {state.words.at(-1)?.word.length ?? 0} LETTERS
                  </AppText>
                  {role !== null ? (
                    <AppText kind="label" tokens={tokens}>
                      {role.toUpperCase()} PLAYER
                    </AppText>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>

          {sessionUnavailable || stateUnavailable ? (
            <View
              accessibilityRole="alert"
              style={[
                styles.recovery,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.warning },
              ]}
            >
              <AppText kind="title" tokens={tokens}>
                {sessionUnavailable ? 'Game not found' : 'Chain needs a refresh'}
              </AppText>
              <AppText kind="muted" tokens={tokens} style={styles.recoveryCopy}>
                {sessionUnavailable
                  ? 'This invitation may have expired or the game may have been removed.'
                  : 'We received an incomplete game update. Try loading the latest version.'}
              </AppText>
              <AppButton
                label={refreshing ? 'Refreshing…' : 'Try again'}
                variant="quiet"
                tokens={tokens}
                disabled={refreshing}
                onPress={() => void refreshSession()}
              />
            </View>
          ) : null}

          {session?.state === 'pending' ? (
            <View
              style={[
                styles.pending,
                clayRaisedStyle(tokens, true),
                { backgroundColor: tokens.surface },
              ]}
            >
              <View style={[styles.waitingMark, { backgroundColor: tokens.surfaceMuted }]}>
                <AppText kind="title" tokens={tokens} style={styles.waitingGlyph}>
                  …
                </AppText>
              </View>
              <AppText kind="body" tokens={tokens} style={styles.pendingTitle}>
                Invitation sent
              </AppText>
              <AppText kind="muted" tokens={tokens} style={styles.pendingCopy} selectable>
                Keep this screen open while{' '}
                {partnerName.toLowerCase() === 'partner' ? 'your partner' : partnerName} joins.
              </AppText>
              <AppButton
                label="Cancel invitation"
                variant="quiet"
                tokens={tokens}
                disabled={busy}
                onPress={() => void cancelInvitation()}
              />
            </View>
          ) : null}

          {state?.status === 'won' ? (
            <WordChainResultCard
              won={state.winner === self}
              wordCount={state.words.length}
              longestWordLength={state.words.at(-1)?.word.length ?? 0}
              tokens={tokens}
            />
          ) : null}

          {state !== null ? (
            <View
              style={[
                styles.chainBoard,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surface },
              ]}
              accessibilityLabel="Word chain"
            >
              <View style={styles.boardHeading}>
                <View>
                  <AppText kind="label" tokens={tokens}>
                    THE CHAIN
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    Each last letter starts the next word.
                  </AppText>
                </View>
                <View style={[styles.scoreBadge, { backgroundColor: tokens.surfaceMuted }]}>
                  <AppText kind="label" tokens={tokens}>
                    {state.words.length} PLAYED
                  </AppText>
                </View>
              </View>
              {state.words.length === 0 ? (
                <View style={styles.emptyChain}>
                  <View style={styles.emptyTiles} accessible={false}>
                    {[0, 1, 2].map((index) => (
                      <View
                        key={index}
                        style={[
                          styles.emptyTile,
                          index === 1
                            ? styles.emptyTileMiddle
                            : index === 2
                              ? styles.emptyTileLast
                              : undefined,
                          {
                            backgroundColor: index === 0 ? tokens.primary : tokens.surfaceMuted,
                            borderColor: tokens.border,
                          },
                        ]}
                      >
                        <AppText kind="title" tokens={tokens} style={styles.emptyTileText}>
                          {index === 0 ? '?' : '·'}
                        </AppText>
                      </View>
                    ))}
                  </View>
                  <AppText kind="body" tokens={tokens} style={styles.emptyTitle}>
                    Open with a short word
                  </AppText>
                  <AppText kind="muted" tokens={tokens}>
                    Use 2–5 letters. Every word after it must chain and grow.
                  </AppText>
                </View>
              ) : (
                state.words.map((entry, index) => {
                  const mine = entry.player === self;
                  const nextLetter = entry.word.at(-1)?.toUpperCase();
                  return (
                    <View key={`${index}-${entry.word}`}>
                      <View style={[styles.wordLine, mine && styles.mineLine]}>
                        <View
                          style={[
                            styles.turnNumber,
                            { backgroundColor: mine ? tokens.primary : tokens.surfaceMuted },
                          ]}
                        >
                          <AppText kind="label" tokens={tokens}>
                            {index + 1}
                          </AppText>
                        </View>
                        <View
                          style={[
                            styles.wordTile,
                            clayRaisedStyle(tokens, true),
                            { backgroundColor: mine ? tokens.primary : tokens.surfaceMuted },
                          ]}
                        >
                          <View style={styles.wordCopy}>
                            <AppText kind="label" tokens={tokens} style={styles.wordOwner}>
                              {mine ? 'YOU' : partnerName.toUpperCase()}
                            </AppText>
                            <AppText kind="body" tokens={tokens} style={styles.wordText}>
                              {entry.word}
                            </AppText>
                          </View>
                          <View style={[styles.points, { backgroundColor: tokens.surface }]}>
                            <AppText kind="label" tokens={tokens}>
                              {entry.word.length}L
                            </AppText>
                          </View>
                        </View>
                      </View>
                      {index < state.words.length - 1 ? (
                        <View style={styles.connector} accessible={false}>
                          <View
                            style={[styles.connectorLine, { backgroundColor: tokens.border }]}
                          />
                          <View
                            style={[styles.connectorLetter, { backgroundColor: tokens.accent }]}
                          >
                            <AppText kind="label" tokens={tokens}>
                              {nextLetter}
                            </AppText>
                          </View>
                          <View
                            style={[styles.connectorLine, { backgroundColor: tokens.border }]}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
              {state.status === 'in_progress' && state.words.length > 0 ? (
                <View style={styles.nextSlot}>
                  <View style={[styles.nextSlotLine, { backgroundColor: tokens.border }]} />
                  <View
                    style={[
                      styles.nextSlotTile,
                      { backgroundColor: tokens.background, borderColor: tokens.border },
                    ]}
                  >
                    <AppText kind="label" tokens={tokens}>
                      NEXT · {requiredLetter?.toUpperCase()} · {requiredLengths?.[0]}–
                      {requiredLengths?.[1]}
                    </AppText>
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {myTurn && state !== null ? (
            <View
              style={[
                styles.composer,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surface },
              ]}
            >
              <View style={styles.composerHeading}>
                <View style={[styles.requiredTile, { backgroundColor: tokens.primary }]}>
                  <AppText kind="title" tokens={tokens} style={styles.requiredLetter}>
                    {requiredLetter?.toUpperCase() ?? 'Aa'}
                  </AppText>
                </View>
                <View style={styles.composerCopy}>
                  <AppText kind="label" tokens={tokens}>
                    {requiredLetter === null ? 'START THE CHAIN' : 'YOUR CHALLENGE'}
                  </AppText>
                  <AppText kind="body" tokens={tokens} style={styles.composerPrompt}>
                    {requiredLetter === null
                      ? 'Play a word with 2–5 letters'
                      : `${requiredLengths?.[0]} or ${requiredLengths?.[1]} letters, starting with ${requiredLetter.toUpperCase()}`}
                  </AppText>
                </View>
              </View>
              <AppField
                ref={inputRef}
                label="YOUR WORD"
                tokens={tokens}
                value={word}
                onChangeText={setWord}
                placeholder={
                  requiredLetter === null ? 'Type any word' : `${requiredLetter.toUpperCase()}…`
                }
                autoCapitalize="none"
                autoCorrect
                returnKeyType="send"
                maxLength={45}
                editable={!busy}
                onSubmitEditing={() => void submit()}
              />
              <AppText kind="muted" tokens={tokens} style={styles.ruleHint}>
                Valid dictionary words only. No repeats.
              </AppText>
              <AppButton
                label={busy ? 'Checking…' : 'Play word'}
                tokens={tokens}
                disabled={busy || word.trim().length === 0}
                onPress={() => void submit()}
              />
              <View style={styles.giveUpAction}>
                <AppButton
                  label="I can’t find one — give up"
                  variant="quiet"
                  tokens={tokens}
                  disabled={busy}
                  onPress={confirmGiveUp}
                />
              </View>
            </View>
          ) : null}

          {session?.state === 'paused' ? (
            <AppButton
              label="Rejoin"
              tokens={tokens}
              disabled={busy}
              onPress={() => void rejoin()}
            />
          ) : null}

          {error !== null ? (
            <AppText
              kind="error"
              tokens={tokens}
              style={styles.error}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
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
  scroll: { paddingHorizontal: 24, paddingBottom: 40 },
  status: { borderRadius: 28, padding: 20, marginBottom: 20 },
  statusHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  statusCopy: { flex: 1 },
  eyebrow: { marginBottom: 4 },
  statusDetail: { marginTop: 6, maxWidth: 300 },
  countBadge: {
    minWidth: 70,
    minHeight: 58,
    borderRadius: 19,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  countNumber: { fontSize: 28, lineHeight: 34 },
  countTotal: { marginLeft: 2 },
  progressBlock: { marginTop: 16, gap: 12 },
  progressRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  recovery: { borderRadius: 24, padding: 18, marginBottom: 18 },
  recoveryCopy: { marginTop: 5, marginBottom: 16 },
  pending: { borderRadius: 26, padding: 20, marginBottom: 20, alignItems: 'center' },
  waitingMark: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  waitingGlyph: { fontSize: 34, lineHeight: 38, marginTop: -10 },
  pendingTitle: { fontWeight: '700' },
  pendingCopy: { textAlign: 'center', marginTop: 3, marginBottom: 16 },
  chainBoard: { borderRadius: 28, padding: 18, marginBottom: 20 },
  boardHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 18,
  },
  scoreBadge: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  emptyChain: { minHeight: 176, alignItems: 'center', justifyContent: 'center' },
  emptyTiles: { height: 66, width: 164, marginBottom: 16 },
  emptyTile: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 58,
    height: 58,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-5deg' }],
  },
  emptyTileMiddle: { left: 53, top: 5, transform: [{ rotate: '3deg' }] },
  emptyTileLast: { left: 106, top: 0, transform: [{ rotate: '7deg' }] },
  emptyTileText: { fontSize: 26, lineHeight: 31 },
  emptyTitle: { fontWeight: '700', marginBottom: 3 },
  wordLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 22 },
  mineLine: { flexDirection: 'row-reverse', paddingRight: 0, paddingLeft: 22 },
  turnNumber: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordTile: {
    flex: 1,
    borderRadius: 21,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  wordText: { fontSize: 21, lineHeight: 27, fontWeight: '700' },
  wordCopy: { flex: 1, flexShrink: 1 },
  wordOwner: { marginBottom: 1 },
  points: {
    minWidth: 42,
    minHeight: 42,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connector: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  connectorLine: { width: 22, height: StyleSheet.hairlineWidth },
  connectorLetter: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
  },
  nextSlot: { alignItems: 'center' },
  nextSlotLine: { width: StyleSheet.hairlineWidth, height: 16 },
  nextSlotTile: {
    minWidth: 112,
    borderRadius: 15,
    borderWidth: 1,
    borderStyle: 'dashed',
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  composer: { borderRadius: 28, padding: 18, marginBottom: 8 },
  composerHeading: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  requiredTile: {
    minWidth: 58,
    height: 58,
    borderRadius: 19,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
  },
  requiredLetter: { fontSize: 26, lineHeight: 31 },
  composerCopy: { flex: 1 },
  composerPrompt: { fontWeight: '700', marginTop: 2 },
  ruleHint: { marginTop: -6, marginBottom: 16 },
  giveUpAction: { marginTop: 10 },
  error: { marginTop: 16 },
});
