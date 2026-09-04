import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { invitationCode, isErr, isOk } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { themeTokens } from '../theme';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

export function PairingScreen() {
  const tokens = themeTokens();
  const { runtime, identity, reload } = useApp();
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.pairing.createInvitation();
      if (isOk(result)) {
        setIssued(result.value.code);
        return;
      }
      setError(messageForError(result.error));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.pairing.acceptInvitation(
        invitationCode(code.trim().toUpperCase()),
      );
      if (isErr(result)) {
        setError(messageForError(result.error));
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="title" tokens={tokens}>
          Pair up
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          Create a 72-hour code, or enter the one your partner sent you.
        </AppText>

        <View
          style={[styles.card, { backgroundColor: tokens.surface, borderColor: tokens.border }]}
        >
          <AppText kind="label" tokens={tokens}>
            Your invitation
          </AppText>
          <AppText kind="title" tokens={tokens} selectable style={styles.code}>
            {issued ?? '--------'}
          </AppText>
          <AppButton
            label="Create invitation"
            tokens={tokens}
            disabled={busy}
            onPress={() => {
              void create();
            }}
          />
        </View>

        <AppField
          label="Partner's code"
          tokens={tokens}
          autoCapitalize="none"
          autoCorrect={false}
          value={code}
          onChangeText={(value) => setCode(value.toUpperCase())}
        />
        <AppButton
          label="Accept invitation"
          tokens={tokens}
          disabled={busy || code.trim().length === 0}
          onPress={() => {
            void accept();
          }}
        />

        {error !== null ? (
          <AppText kind="error" tokens={tokens} style={styles.banner}>
            {error}
          </AppText>
        ) : null}

        <View style={styles.signOut}>
          <AppText kind="muted" tokens={tokens} style={styles.account}>
            Signed in as {identity.session?.accountId ?? ''}
          </AppText>
          <AppButton
            variant="quiet"
            label="Sign out"
            tokens={tokens}
            onPress={() => {
              void runtime.auth.signOut().then(() => reload());
            }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32 },
  lead: { marginTop: 8, marginBottom: 24 },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    marginBottom: 32,
  },
  code: { marginVertical: 16, letterSpacing: 2 },
  banner: { marginTop: 16 },
  signOut: { marginTop: 40 },
  account: { marginBottom: 12 },
});
