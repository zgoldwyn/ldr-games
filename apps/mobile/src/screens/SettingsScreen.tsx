import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { requestAccountDeletion } from '../account/delete-account';
import { useApp } from '../app-context';
import { registerApnsToken } from '../notifications/apns-registration';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

type DeleteStep = 'idle' | 'review';

export function SettingsScreen() {
  const tokens = themeTokens();
  const { runtime, identity, reload } = useApp();
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
          Account
        </AppText>

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
            style={[styles.warning, { backgroundColor: tokens.surface, borderColor: tokens.error }]}
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
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  warningTitle: { fontWeight: '600', marginBottom: 8 },
  spacer: { height: 12 },
  error: { marginTop: 16 },
});
