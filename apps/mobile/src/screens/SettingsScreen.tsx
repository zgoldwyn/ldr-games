import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COLOR_OPTIONS } from '@ldr/core';

import { requestAccountDeletion } from '../account/delete-account';
import { useApp } from '../app-context';
import { registerApnsToken } from '../notifications/apns-registration';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';

type DeleteStep = 'idle' | 'review';

export function SettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, reload, tokens, colorOption, setColorOption } = useApp();
  const [deleteStep, setDeleteStep] = useState<DeleteStep>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  async function enablePushNotifications() {
    const accountId = identity.session?.accountId;
    if (accountId === undefined) return;
    setPushBusy(true);
    setPushMessage(null);
    const result = await registerApnsToken(runtime.notifications, accountId, true);
    setPushBusy(false);
    setPushMessage(
      result === 'registered'
        ? 'Push notifications are enabled on this device.'
        : result === 'permission-denied'
          ? 'Notifications are turned off. Enable them in iPhone Settings to receive alerts.'
          : result === 'unsupported'
            ? 'Native push registration is available on a physical iPhone.'
            : 'Could not register this device yet. Please try again.',
    );
  }

  async function permanentlyDelete() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestAccountDeletion(runtime.client);
      if (!result.ok) {
        setError(result.message);
        return;
      }

      // The remote credential is gone, so sign-out may reject; its finally path
      // still clears the domain session from SecureStore.
      try {
        await runtime.auth.signOut();
      } catch {
        // Account deletion itself succeeded. Only local cleanup remains.
      }

      Alert.alert('Account deleted', 'Your account and its data have been permanently deleted.', [
        { text: 'Done', onPress: () => void reload() },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="title" tokens={tokens}>
          Settings
        </AppText>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Theme
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.copy}>
          Choose a color palette. Your choice is saved on this device.
        </AppText>
        <View style={styles.paletteRow}>
          {Object.values(COLOR_OPTIONS).map((option) => (
            <Pressable
              key={option.name}
              accessibilityRole="radio"
              accessibilityState={{ selected: colorOption === option.name }}
              onPress={() => setColorOption(option.name)}
              style={[
                styles.palette,
                clayRaisedStyle(option.light, true),
                {
                  backgroundColor: option.light.primary,
                  borderColor:
                    colorOption === option.name ? option.light.onPrimary : option.light.border,
                },
              ]}
            >
              <AppText kind="label" tokens={option.light}>
                {option.label}
              </AppText>
            </Pressable>
          ))}
        </View>

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Notifications
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.copy}>
          Enable alerts for invitations, turns, and reminders on this iPhone.
        </AppText>
        <AppButton
          label={pushBusy ? 'Enabling…' : 'Enable push notifications'}
          tokens={tokens}
          disabled={pushBusy}
          onPress={() => void enablePushNotifications()}
        />
        {pushMessage !== null ? (
          <AppText kind="muted" tokens={tokens} style={styles.feedback}>
            {pushMessage}
          </AppText>
        ) : null}

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Legal & privacy
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.copy}>
          Review our policies and current data practices.
        </AppText>
        <AppButton
          variant="quiet"
          label="Open legal and privacy policies"
          tokens={tokens}
          onPress={() => navigation.navigate('Legal')}
        />

        <AppText kind="label" tokens={tokens} style={styles.section}>
          Account
        </AppText>

        <AppButton
          variant="quiet"
          label="Sign out"
          tokens={tokens}
          disabled={busy}
          onPress={() => void runtime.auth.signOut().then(() => reload())}
        />
        <View style={styles.accountSpacer} />

        {deleteStep === 'idle' ? (
          <>
            <AppText kind="muted" tokens={tokens} style={styles.copy}>
              You can permanently remove your account without contacting support.
            </AppText>
            <AppButton
              variant="quiet"
              label="Delete account"
              tokens={tokens}
              onPress={() => {
                setError(null);
                setDeleteStep('review');
              }}
            />
          </>
        ) : (
          <View
            style={[
              styles.warning,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface, borderColor: tokens.error },
            ]}
          >
            <AppText kind="body" tokens={tokens} style={styles.warningTitle}>
              Permanently delete your account?
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.copy}>
              This is permanent and irreversible. Your credentials, notifications, games, dates,
              reminders, images, and other account data will be removed. If you are paired, your
              partner will be unpaired and notified.
            </AppText>
            <AppButton
              label={busy ? 'Deleting…' : 'Permanently delete account'}
              tokens={tokens}
              disabled={busy}
              onPress={() => void permanentlyDelete()}
            />
            <View style={styles.spacer} />
            <AppButton
              variant="quiet"
              label="Cancel"
              tokens={tokens}
              disabled={busy}
              onPress={() => {
                setError(null);
                setDeleteStep('idle');
              }}
            />
          </View>
        )}

        {error !== null ? (
          <AppText kind="error" tokens={tokens} style={styles.error}>
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32 },
  section: { marginTop: 32, marginBottom: 12 },
  copy: { marginBottom: 16 },
  feedback: { marginTop: 12 },
  warning: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  warningTitle: { fontWeight: '600', marginBottom: 8 },
  spacer: { height: 12 },
  error: { marginTop: 16 },
  accountSpacer: { height: 16 },
  paletteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  palette: {
    minWidth: 92,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
