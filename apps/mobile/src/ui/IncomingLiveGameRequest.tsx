import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, StyleSheet, View } from 'react-native';
import { isErr, sessionId, type ElementalRole } from '@ldr/core';

import { useApp } from '../app-context';
import { readGameServerDevConfig } from '../config';
import { messageForError } from '../copy/error-copy';
import {
  claimDevPlatformerSeat,
  getDevPlatformerSessionStatus,
  type PlatformerSessionAccess,
  type PlatformerSessionStatus,
} from '../games/elemental-online';
import { pendingLiveRequest, type LiveGameRoute } from '../games/live-game-request';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

interface Props {
  readonly onOpenGame: (route: LiveGameRoute, id: string) => void;
  readonly onOpenPlatformer: (role: ElementalRole, access: PlatformerSessionAccess) => void;
  readonly isPlatformerOpen: () => boolean;
}

/** Presents incoming live sessions above every tab and game screen. */
export function IncomingLiveGameRequest({ onOpenGame, onOpenPlatformer, isPlatformerOpen }: Props) {
  const { runtime, identity, tokens } = useApp();
  const [, setTick] = useState(0);
  const [platformer, setPlatformer] = useState<PlatformerSessionStatus | null>(null);
  const [dismissedPlatformer, setDismissedPlatformer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingPlatformer = useRef(false);
  const config = useMemo(() => readGameServerDevConfig(), []);
  const self = identity.session?.accountId;
  const pairing = identity.pairing?.id;

  const refresh = useCallback(() => {
    void runtime.rt.refresh();
    if (self !== undefined) void runtime.notifications.list(self);
  }, [runtime.rt, runtime.notifications, self]);

  const refreshPlatformer = useCallback(async () => {
    if (config === null || self === undefined || pairing === undefined || pollingPlatformer.current)
      return;
    pollingPlatformer.current = true;
    try {
      const next = await getDevPlatformerSessionStatus(config, pairing, self);
      setPlatformer(next);
      if (!next.active) setDismissedPlatformer(false);
    } catch {
      setPlatformer(null);
    } finally {
      pollingPlatformer.current = false;
    }
  }, [config, pairing, self]);

  useEffect(() => {
    refresh();
    void refreshPlatformer();
    const unsubscribeRt = runtime.rt.subscribe(() => setTick((value) => value + 1));
    const unsubscribeNotices = runtime.notifications.subscribeCache(() => {
      setTick((value) => value + 1);
      void runtime.rt.refresh();
    });
    const interval = setInterval(() => {
      refresh();
      void refreshPlatformer();
    }, 5_000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh();
        void refreshPlatformer();
      }
    });
    return () => {
      unsubscribeRt();
      unsubscribeNotices();
      clearInterval(interval);
      appState.remove();
    };
  }, [refresh, refreshPlatformer, runtime.notifications, runtime.rt]);

  const live =
    self === undefined
      ? null
      : pendingLiveRequest(runtime.notifications.cached(self), runtime.rt.list());
  const emberInvite =
    live === null &&
    platformer?.active === true &&
    platformer.createdByYou !== true &&
    !dismissedPlatformer &&
    !isPlatformerOpen();
  const visible = live !== null || emberInvite;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      if (live !== null) {
        const id = sessionId(live.session.id);
        const result = await runtime.rt.join(id);
        if (isErr(result)) {
          setError(messageForError(result.error));
          return;
        }
        await runtime.notifications.acknowledge(live.notification.id);
        onOpenGame(live.route, id);
      } else if (emberInvite && config !== null && self !== undefined && pairing !== undefined) {
        const access = await claimDevPlatformerSeat(config, pairing, self);
        setDismissedPlatformer(true);
        onOpenPlatformer(access.role, access);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join the game.');
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      if (live !== null) {
        const result = await runtime.rt.deleteSession(live.session.id);
        if (isErr(result)) {
          setError(messageForError(result.error));
          return;
        }
        await runtime.notifications.acknowledge(live.notification.id);
      } else {
        // The local platformer status service has no decline endpoint. Hide this
        // invitation until the waiting room closes; never claim a seat for it.
        setDismissedPlatformer(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={() => undefined}
    >
      <View style={[styles.screen, { backgroundColor: tokens.background }]}>
        <View style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
          <AppText kind="label" tokens={tokens}>
            LIVE GAME REQUEST
          </AppText>
          <AppText kind="title" tokens={tokens} style={styles.title}>
            {live !== null ? `Play ${live.name} together?` : 'Join Ember & Tide?'}
          </AppText>
          <AppText kind="body" tokens={tokens} style={styles.body}>
            Your partner is waiting for you. Choose whether to join now.
          </AppText>
          <View style={styles.actions}>
            <AppButton
              label="Accept and join"
              tokens={tokens}
              disabled={busy}
              onPress={() => void accept()}
            />
            <AppButton
              label="Decline"
              variant="quiet"
              tokens={tokens}
              disabled={busy}
              onPress={() => void decline()}
            />
          </View>
          {error !== null ? (
            <AppText kind="error" tokens={tokens} style={styles.error}>
              {error}
            </AppText>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  card: { borderRadius: 28, padding: 24 },
  title: { marginTop: 12 },
  body: { marginTop: 10, marginBottom: 24 },
  actions: { gap: 12 },
  error: { marginTop: 16 },
});
