import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { isErr, isOk } from '@ldr/core';

import { messageForError } from '../copy/error-copy';
import { useApp } from '../app-context';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

type Mode = 'signIn' | 'register';

export function SignInScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, reload, tokens } = useApp();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const canSubmit = !busy && (mode === 'signIn' || legalAccepted);

  async function submit() {
    if (!canSubmit) return;
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
    <Screen tokens={tokens} horizontalPadding={false}>
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
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <AppField
            ref={passwordRef}
            label="Password"
            tokens={tokens}
            secureTextEntry
            textContentType={mode === 'register' ? 'newPassword' : 'password'}
            value={password}
            onChangeText={setPassword}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />

          {mode === 'register' ? (
            <>
              <AppText kind="muted" tokens={tokens} style={styles.hint}>
                At least 12 characters, with upper and lower case, a number, and a symbol.
              </AppText>
              <View style={styles.policyLinks}>
                <AppButton
                  variant="quiet"
                  label="Read Terms"
                  tokens={tokens}
                  onPress={() => navigation.navigate('LegalDocument', { document: 'terms' })}
                />
                <AppButton
                  variant="quiet"
                  label="Read Privacy Policy"
                  tokens={tokens}
                  onPress={() => navigation.navigate('LegalDocument', { document: 'privacy' })}
                />
              </View>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: legalAccepted }}
                accessibilityLabel="I agree to the Terms and acknowledge the Privacy Policy"
                onPress={() => setLegalAccepted((accepted) => !accepted)}
                style={({ pressed }) => [
                  styles.consent,
                  pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                  {
                    backgroundColor: pressed ? tokens.primary : tokens.surfaceMuted,
                  },
                ]}
              >
                <View
                  accessibilityElementsHidden
                  style={[
                    styles.checkbox,
                    {
                      backgroundColor: legalAccepted ? tokens.primary : tokens.surface,
                      borderColor: legalAccepted ? tokens.primaryStrong : tokens.border,
                    },
                  ]}
                >
                  <AppText kind="body" tokens={tokens}>
                    {legalAccepted ? '✓' : ''}
                  </AppText>
                </View>
                <AppText kind="body" tokens={tokens} style={styles.consentCopy}>
                  I agree to the Terms and acknowledge the Privacy Policy.
                </AppText>
              </Pressable>
            </>
          ) : null}

          {error !== null ? (
            <AppText
              kind="error"
              tokens={tokens}
              style={styles.banner}
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
            >
              {error}
            </AppText>
          ) : null}
          {notice !== null ? (
            <AppText
              kind="muted"
              tokens={tokens}
              style={styles.banner}
              accessibilityLiveRegion="polite"
            >
              {notice}
            </AppText>
          ) : null}

          <AppButton
            label={mode === 'signIn' ? 'Sign in' : 'Create account'}
            tokens={tokens}
            disabled={!canSubmit}
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
                setLegalAccepted(false);
                setError(null);
                setNotice(null);
              }}
            />
          </View>
          <View style={styles.legalRow}>
            <AppButton
              variant="quiet"
              tokens={tokens}
              label="Legal and privacy"
              onPress={() => navigation.navigate('Legal')}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 24, paddingBottom: 24 },
  lead: { marginTop: 8, marginBottom: 24 },
  hint: { marginBottom: 16 },
  banner: { marginBottom: 16 },
  switchRow: { marginTop: 16 },
  legalRow: { marginTop: 12 },
  policyLinks: { gap: 8, marginBottom: 12 },
  consent: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    padding: 12,
    marginBottom: 16,
  },
  checkbox: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
  },
  consentCopy: { flex: 1, marginLeft: 12 },
});
