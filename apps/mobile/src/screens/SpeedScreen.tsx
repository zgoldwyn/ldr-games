import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isErr, sessionId, speedHasPlayableCard } from '@ldr/core';

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

export function SpeedScreen({ route }: Props) {
  const { runtime, identity, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => runtime.rt.subscribe(() => setTick((value) => value + 1)), [runtime.rt]);
  useEffect(() => {
    runtime.connection.joinGame(id);
    return () => runtime.connection.leaveGame();
  }, [id, runtime.connection]);

  const session = runtime.rt.cached(id);
  const state = asSpeedState(session?.gameState);
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

  async function play(cardId: string) {
    if (!active || !state || busy) return;
    const card = mine?.hand.find((candidate) => candidate.id === cardId);
    if (!card) return;
    const pile = legalPileForCard(state, card);
    if (pile === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.rt.move(id, { type: 'play', cardId, pile });
      if (isErr(result)) {
        await runtime.rt.refresh();
        setError(messageForError(result.error));
      }
    } finally {
      setBusy(false);
    }
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

            <View style={styles.table}>
              <View style={styles.pileWrap}>
                <AppText kind="muted" tokens={tokens}>
                  {state.reservePiles[0].length} to flip
                </AppText>
                <PlayingCard card={state.centerPiles[0].at(-1)!} tokens={tokens} compact />
              </View>
              <View style={styles.pileWrap}>
                <AppText kind="muted" tokens={tokens}>
                  {state.reservePiles[1].length} to flip
                </AppText>
                <PlayingCard card={state.centerPiles[1].at(-1)!} tokens={tokens} compact />
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
            <View style={styles.hand}>
              {mine?.hand.map((card) => {
                const playable = active && legalPileForCard(state, card) !== null;
                return (
                  <PlayingCard
                    key={card.id}
                    card={card}
                    tokens={tokens}
                    disabled={!playable || busy}
                    onPress={() => void play(card.id)}
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
        {error ? (
          <AppText kind="error" tokens={tokens} style={styles.error}>
            {error}
          </AppText>
        ) : null}
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
  hand: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 9,
    marginBottom: 24,
  },
  error: { marginTop: 16 },
});
