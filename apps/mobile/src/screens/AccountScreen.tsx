import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useApp } from '../app-context';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';

export function AccountScreen() {
  const { runtime, identity, accountDetails, refreshAccount, tokens } = useApp();
  const [displayName, setDisplayName] = useState(accountDetails?.selfProfile?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState<'profile' | 'password' | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(accountDetails?.selfProfile?.displayName ?? '');
  }, [accountDetails?.selfProfile?.displayName]);

  async function saveProfile() {
    const accountId = identity.session?.accountId;
    if (accountId === undefined) return;
    setBusy('profile');
    setProfileMessage(null);
    const result = await runtime.profile.saveDisplayName(accountId, displayName);
    if (result.ok) {
      setDisplayName(result.value.displayName);
      await refreshAccount();
      setProfileMessage('Display name saved.');
    } else {
      setProfileMessage(result.message);
    }
    setBusy(null);
  }

  async function resetPassword() {
    setPasswordMessage(null);
    if (password !== confirmation) {
      setPasswordMessage('The passwords do not match.');
      return;
    }
    setBusy('password');
    const result = await runtime.profile.resetPassword(password);
    if (result.ok) {
      setPassword('');
      setConfirmation('');
      setPasswordMessage('Password reset successfully.');
    } else {
      setPasswordMessage(result.message);
    }
    setBusy(null);
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}>
            <AppText kind="label" tokens={tokens}>
              SIGNED IN AS
            </AppText>
            <AppText kind="body" tokens={tokens} selectable style={styles.email}>
              {accountDetails?.email ?? 'Loading email…'}
            </AppText>
          </View>

          <AppText kind="label" tokens={tokens} style={styles.section}>
            Your profile
          </AppText>
          <AppText kind="muted" tokens={tokens} style={styles.copy}>
            This is the name your linked partner sees in games.
          </AppText>
          <AppField
            label="Display name"
            tokens={tokens}
            value={displayName}
            onChangeText={setDisplayName}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={40}
            returnKeyType="done"
            onSubmitEditing={() => void saveProfile()}
          />
          <AppButton
            label={busy === 'profile' ? 'Saving…' : 'Save display name'}
            tokens={tokens}
            disabled={busy !== null || displayName.trim().length === 0}
            onPress={() => void saveProfile()}
          />
          {profileMessage !== null ? (
            <AppText
              kind="muted"
              tokens={tokens}
              style={styles.feedback}
              accessibilityLiveRegion="polite"
            >
              {profileMessage}
            </AppText>
          ) : null}

          <AppText kind="label" tokens={tokens} style={styles.section}>
            Linked partner
          </AppText>
          <View
            style={[
              styles.partnerCard,
              clayRaisedStyle(tokens, true),
              { backgroundColor: tokens.surfaceMuted },
            ]}
          >
            <AppText kind="body" tokens={tokens}>
              {identity.pairing === null
                ? 'No linked partner yet'
                : (accountDetails?.partnerProfile?.displayName ?? 'Partner')}
            </AppText>
            {identity.pairing !== null && accountDetails?.partnerProfile === null ? (
              <AppText kind="muted" tokens={tokens} style={styles.partnerHint}>
                They haven’t added a display name yet.
              </AppText>
            ) : null}
          </View>

          <AppText kind="label" tokens={tokens} style={styles.section}>
            Reset password
          </AppText>
          <AppText kind="muted" tokens={tokens} style={styles.copy}>
            Your active signed-in session authorizes this change. Use 12–128 characters with
            uppercase, lowercase, a number, and a symbol.
          </AppText>
          <AppField
            label="New password"
            tokens={tokens}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="newPassword"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />
          <AppField
            label="Confirm new password"
            tokens={tokens}
            value={confirmation}
            onChangeText={setConfirmation}
            secureTextEntry
            textContentType="newPassword"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void resetPassword()}
          />
          <AppButton
            label={busy === 'password' ? 'Resetting…' : 'Reset password'}
            tokens={tokens}
            disabled={busy !== null || password.length === 0 || confirmation.length === 0}
            onPress={() => void resetPassword()}
          />
          {passwordMessage !== null ? (
            <AppText
              kind="muted"
              tokens={tokens}
              style={styles.feedback}
              accessibilityLiveRegion="polite"
            >
              {passwordMessage}
            </AppText>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 24, paddingBottom: 48 },
  card: { borderRadius: 26, padding: 20, marginTop: 16 },
  email: { marginTop: 6, fontWeight: '700' },
  section: { marginTop: 28, marginBottom: 8 },
  copy: { marginBottom: 16 },
  feedback: { marginTop: 12 },
  partnerCard: { borderRadius: 20, padding: 18 },
  partnerHint: { marginTop: 4 },
});
