import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { invitationCode, isErr, isOk } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import type { RootStackParamList } from '../navigation';
import { startPairingRefreshWatcher } from '../pairing/pairing-refresh-watcher';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayRaisedStyle } from '../ui/clay';

export function PairingScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { runtime, identity, reload, tokens } = useApp();
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return startPairingRefreshWatcher({
      isPaired: async () => (await runtime.pairing.getPairing()) !== null,
      onPaired: reload,
    });
  }, [reload, runtime.pairing]);

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
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          Create a 72-hour code, or enter the one your partner sent you.
        </AppText>

        <View
          style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.surfaceMuted }]}
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
            label="Settings"
            tokens={tokens}
            onPress={() => navigation.navigate('Settings')}
          />
          <View style={styles.spacer} />
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
  scroll: { paddingHorizontal: 24, paddingBottom: 32 },
  lead: { marginBottom: 24 },
  card: {
    borderRadius: 28,
    padding: 24,
    marginBottom: 32,
  },
  code: { marginVertical: 16, letterSpacing: 2 },
  banner: { marginTop: 16 },
  signOut: { marginTop: 40 },
  account: { marginBottom: 12 },
  spacer: { height: 12 },
});
