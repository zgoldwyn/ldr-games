import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ElementalRole } from '@ldr/core';

import { useApp } from '../app-context';
import { readGameServerDevConfig } from '../config';
import {
  claimDevPlatformerSeat,
  createDevPlatformerSession,
  getDevPlatformerSessionStatus,
  isWaitingForPlatformerSessionError,
  type PlatformerSessionStatus,
} from '../games/elemental-online';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayInsetStyle, clayPressedStyle, clayRaisedStyle } from '../ui/clay';
import { ClayElementalSpritePreview } from '../ui/ClayElementalSprite';

export function ElementalDuetSetupScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tokens, identity } = useApp();
  const [role, setRole] = useState<ElementalRole>('ember');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'waiting' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeSession, setActiveSession] = useState<PlatformerSessionStatus | null>(null);
  const [savedLevel, setSavedLevel] = useState(1);
  const lastAction = useRef<'create' | 'join'>('create');
  const joinAttempt = useRef(0);

  const self = identity.session?.accountId;
  const pairing = identity.pairing;
  const partner =
    self && pairing ? (pairing.memberA === self ? pairing.memberB : pairing.memberA) : undefined;
  const devConfig = readGameServerDevConfig();

  useEffect(() => {
    if (!devConfig || !self || !pairing) return;
    let active = true;
    const refresh = () => {
      void getDevPlatformerSessionStatus(devConfig, pairing.id, self)
        .then((session) => {
          if (active) {
            setSavedLevel(session.savedLevel);
            setActiveSession(session.active ? session : null);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, 2_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [devConfig?.admissionKey, devConfig?.url, pairing?.id, self]);

  const createOnlineGame = async () => {
    lastAction.current = 'create';
    if (!devConfig || !self || !partner || !pairing) {
      setErrorMessage('Local game-server configuration or pairing is unavailable.');
      setStatus('error');
      return;
    }
    setStatus('connecting');
    try {
      const access = await createDevPlatformerSession(devConfig, {
        gameSessionId: `${pairing.id}-${Date.now()}`,
        pairingId: pairing.id,
        creatorAccountId: self,
        linkedAccountId: partner,
        creatorRole: role,
      });
      navigation.replace('ElementalDuet', { role: access.role, access });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the game.');
      setStatus('error');
    }
  };

  const joinOnlineGame = async () => {
    lastAction.current = 'join';
    if (!devConfig || !self || !pairing) {
      setErrorMessage('Local game-server configuration or pairing is unavailable.');
      setStatus('error');
      return;
    }
    const attempt = ++joinAttempt.current;
    setStatus('waiting');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && attempt === joinAttempt.current) {
      try {
        const access = await claimDevPlatformerSeat(devConfig, pairing.id, self);
        if (attempt !== joinAttempt.current) return;
        navigation.replace('ElementalDuet', { role: access.role, access });
        return;
      } catch (error) {
        if (!isWaitingForPlatformerSessionError(error)) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Unable to reach the game server.',
          );
          setStatus('error');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    if (attempt !== joinAttempt.current) return;
    setErrorMessage('No game from your linked partner appeared within 12 seconds.');
    setStatus('error');
  };

  const cancelJoin = () => {
    joinAttempt.current += 1;
    setStatus('idle');
  };

  const retry = () => {
    void (lastAction.current === 'create' ? createOnlineGame() : joinOnlineGame());
  };

  if (activeSession) {
    const createdByYou = activeSession.createdByYou === true;
    return (
      <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
        <ScrollView contentContainerStyle={styles.activeGameScroll}>
          <View
            style={[
              styles.activeGameCard,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surfaceMuted },
            ]}
          >
            <View style={styles.waitingCharacters} accessibilityElementsHidden>
              <ClayElementalSpritePreview role="ember" tokens={tokens} size={82} />
              <ClayElementalSpritePreview role="tide" tokens={tokens} size={82} />
            </View>
            <AppText kind="label" tokens={tokens}>
              {createdByYou ? 'RESUME YOUR GAME' : 'YOUR PARTNER IS WAITING'}
            </AppText>
            <AppText kind="title" tokens={tokens} style={styles.activeGameTitle}>
              {createdByYou ? 'Your grove is still open' : 'Join the game they started'}
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              {createdByYou
                ? 'Return to your room and continue as your saved spirit.'
                : 'Take the remaining spirit and meet your partner in the grove.'}
            </AppText>
          </View>

          {status === 'waiting' ? (
            <StatusCard label="Joining your partner…" tokens={tokens} onCancel={cancelJoin} />
          ) : status === 'connecting' ? (
            <StatusCard label="Connecting to game…" tokens={tokens} />
          ) : status === 'error' ? (
            <View style={[styles.note, { backgroundColor: tokens.warning }]}>
              <AppText kind="label" tokens={tokens}>
                CONNECTION FAILED
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                {errorMessage}
              </AppText>
              <AppButton label="Try joining again" tokens={tokens} onPress={retry} />
            </View>
          ) : (
            <AppButton
              label={createdByYou ? 'Resume your game' : 'Join your partner'}
              tokens={tokens}
              onPress={() => void joinOnlineGame()}
            />
          )}
          <AppButton
            label="Play the tutorial instead"
            variant="quiet"
            tokens={tokens}
            onPress={() =>
              navigation.replace('ElementalDuet', { role: activeSession.role ?? role })
            }
          />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View
          style={[styles.hero, clayRaisedStyle(tokens), { backgroundColor: tokens.surfaceMuted }]}
        >
          <View style={styles.heroMarks} accessibilityElementsHidden>
            <ClayElementalSpritePreview role="ember" tokens={tokens} size={64} />
            <ClayElementalSpritePreview role="tide" tokens={tokens} size={64} />
          </View>
          <AppText kind="label" tokens={tokens}>
            TWO SPIRITS · ONE PATH
          </AppText>
          <AppText kind="title" tokens={tokens} style={styles.heroTitle}>
            Choose your element
          </AppText>
          <AppText kind="muted" tokens={tokens}>
            Claim one spirit and your partner becomes the other. You will need both gifts to reach
            the grove gates together.
          </AppText>
        </View>

        <View style={styles.roles}>
          <RoleChoice
            role="ember"
            description="Walk through flame and wake ancient ember mechanisms."
            selected={role === 'ember'}
            tokens={tokens}
            onPress={() => setRole('ember')}
          />
          <RoleChoice
            role="tide"
            description="Move through water and turn the grove's tide mechanisms."
            selected={role === 'tide'}
            tokens={tokens}
            onPress={() => setRole('tide')}
          />
        </View>

        <View
          style={[styles.note, clayInsetStyle(tokens), { backgroundColor: tokens.surfaceMuted }]}
        >
          <AppText kind="label" tokens={tokens}>
            HOW CO-OP WORKS
          </AppText>
          <AppText kind="muted" tokens={tokens}>
            The creator chooses a spirit. Their partner taps Join and receives the other. Roles stay
            paired for the whole adventure.
          </AppText>
        </View>

        {status === 'connecting' ? (
          <StatusCard label="Connecting to game…" tokens={tokens} />
        ) : status === 'waiting' ? (
          <StatusCard
            label="Waiting for your partner's game…"
            tokens={tokens}
            onCancel={cancelJoin}
          />
        ) : status === 'error' ? (
          <View style={[styles.note, { backgroundColor: tokens.warning }]}>
            <AppText kind="label" tokens={tokens}>
              CONNECTION FAILED
            </AppText>
            <AppText kind="muted" tokens={tokens}>
              {errorMessage}
            </AppText>
            <View style={styles.errorActions}>
              <AppButton label="Retry" tokens={tokens} onPress={retry} />
              <AppButton
                label="Back"
                variant="quiet"
                tokens={tokens}
                onPress={() => navigation.goBack()}
              />
            </View>
          </View>
        ) : (
          <>
            <AppButton
              label="Start the playable tutorial"
              tokens={tokens}
              onPress={() => navigation.replace('ElementalDuet', { role })}
            />
            <View style={styles.onlineDivider}>
              <View style={[styles.dividerLine, { backgroundColor: tokens.border }]} />
              <AppText kind="label" tokens={tokens}>
                THEN PLAY TOGETHER
              </AppText>
              <View style={[styles.dividerLine, { backgroundColor: tokens.border }]} />
            </View>
            <AppButton
              label={`${savedLevel > 1 ? `Continue from Level ${savedLevel}` : 'Create game'} as ${
                role === 'ember' ? 'Ember' : 'Tide'
              }`}
              variant="quiet"
              tokens={tokens}
              onPress={() => void createOnlineGame()}
            />
            <AppButton
              label="Join partner's game"
              variant="quiet"
              tokens={tokens}
              onPress={() => void joinOnlineGame()}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function StatusCard({
  label,
  tokens,
  onCancel,
}: {
  readonly label: string;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly onCancel?: () => void;
}) {
  return (
    <View style={[styles.note, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}>
      <AppText kind="title" tokens={tokens}>
        {label}
      </AppText>
      <AppText kind="muted" tokens={tokens}>
        Keep this screen open while the local room connects.
      </AppText>
      {onCancel ? (
        <AppButton label="Cancel" variant="quiet" tokens={tokens} onPress={onCancel} />
      ) : null}
    </View>
  );
}

function RoleChoice({
  role,
  description,
  selected,
  tokens,
  onPress,
}: {
  readonly role: ElementalRole;
  readonly description: string;
  readonly selected: boolean;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly onPress: () => void;
}) {
  const label = role === 'ember' ? 'Ember' : 'Tide';
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.role,
        pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
        {
          backgroundColor:
            role === 'ember'
              ? selected
                ? tokens.warning
                : tokens.surface
              : selected
                ? tokens.primary
                : tokens.surface,
          borderColor: selected ? tokens.textPrimary : tokens.border,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <View style={styles.roleCharacter}>
        <ClayElementalSpritePreview role={role} tokens={tokens} size={82} />
      </View>
      <View style={styles.roleHeading}>
        <AppText kind="title" tokens={tokens} style={styles.roleTitle}>
          {label}
        </AppText>
        {selected ? (
          <View style={[styles.selectedBadge, { backgroundColor: tokens.surface }]}>
            <AppText kind="label" tokens={tokens}>
              ✓ YOUR PICK
            </AppText>
          </View>
        ) : null}
      </View>
      <AppText kind="muted" tokens={tokens}>
        {description}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40, gap: 24 },
  activeGameScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 18,
  },
  activeGameCard: { borderRadius: 30, padding: 24, gap: 10 },
  activeGameTitle: { fontSize: 30, lineHeight: 35 },
  waitingCharacters: { flexDirection: 'row', alignItems: 'flex-end', height: 112 },
  hero: { borderRadius: 30, padding: 20, gap: 8 },
  heroMarks: { flexDirection: 'row', alignItems: 'flex-end', height: 74, marginBottom: 2 },
  heroTitle: { fontSize: 30, lineHeight: 35 },
  roles: { flexDirection: 'row', gap: 14 },
  role: { flex: 1, minHeight: 280, borderRadius: 28, borderWidth: 2, padding: 16, gap: 10 },
  roleCharacter: { width: 88, height: 96, alignSelf: 'center', justifyContent: 'center' },
  roleHeading: { gap: 7 },
  roleTitle: { fontSize: 23, lineHeight: 28 },
  selectedBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  note: { borderRadius: 22, padding: 16, gap: 6 },
  onlineDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  errorActions: { gap: 10, marginTop: 8 },
});
