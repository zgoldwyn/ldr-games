import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { isErr, isOk } from '@ldr/core';

import { messageForError } from '../copy/error-copy';
import { useApp } from '../app-context';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

type Mode = 'signIn' | 'register';

export function SignInScreen() {
  const tokens = themeTokens();
  const { runtime, reload } = useApp();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'register') {
        const result = await runtime.auth.register(email.trim(), password);
        if (isErr(result)) {
          setError(messageForError(result.error));
          return;
        }
        setNotice('Account created. Sign in to continue.');
        setMode('signIn');
        return;
      }

      const result = await runtime.auth.authenticate(email.trim(), password, {
        platform: 'mobile',
        device: Platform.OS === 'ios' ? 'iPhone' : 'Android',
      });
      if (isOk(result)) {
        await reload();
        return;
      }
      setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <AppText kind="title" tokens={tokens}>
            {mode === 'signIn' ? 'Welcome back' : 'Create an account'}
          </AppText>
          <AppText kind="muted" tokens={tokens} style={styles.lead}>
            Just the two of you. Sign in on this phone to pair and play.
          </AppText>

          <AppField
            label="Email"
            tokens={tokens}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
          />
          <AppField
            label="Password"
            tokens={tokens}
            secureTextEntry
            textContentType={mode === 'register' ? 'newPassword' : 'password'}
            value={password}
            onChangeText={setPassword}
          />

          {mode === 'register' ? (
            <AppText kind="muted" tokens={tokens} style={styles.hint}>
              At least 12 characters, with upper and lower case, a number, and a symbol.
            </AppText>
          ) : null}

          {error !== null ? (
            <AppText kind="error" tokens={tokens} style={styles.banner}>
              {error}
            </AppText>
          ) : null}
          {notice !== null ? (
            <AppText kind="muted" tokens={tokens} style={styles.banner}>
              {notice}
            </AppText>
          ) : null}

          <AppButton
            label={mode === 'signIn' ? 'Sign in' : 'Create account'}
            tokens={tokens}
            disabled={busy}
            onPress={() => {
              void submit();
            }}
          />

          <View style={styles.switchRow}>
            <AppButton
              variant="quiet"
              tokens={tokens}
              label={mode === 'signIn' ? 'Need an account?' : 'Already have an account?'}
              onPress={() => {
                setMode(mode === 'signIn' ? 'register' : 'signIn');
                setError(null);
                setNotice(null);
              }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingBottom: 24 },
  lead: { marginTop: 8, marginBottom: 24 },
  hint: { marginBottom: 16 },
  banner: { marginBottom: 16 },
  switchRow: { marginTop: 16 },
});
