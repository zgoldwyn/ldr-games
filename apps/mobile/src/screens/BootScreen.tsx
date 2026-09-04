/**
 * Placeholder screen for the scaffold (task 22.1a).
 *
 * Its only job is to prove the thing the scaffold exists to prove: that the
 * shared `@ldr/core` package actually loads and evaluates inside the React
 * Native runtime, and that the app renders from semantic tokens rather than
 * literals (Requirement 5.1). Importing the barrel here is deliberate — it is
 * what catches a core module that cannot survive Hermes.
 *
 * Task 22.1b replaces this with the real screens: sign in / register, pairing,
 * the game list, and the two boards.
 */
import { StyleSheet, Text, View } from 'react-native';
import { ASYNC_GAME_DEFS, CORE_PACKAGE_NAME, listRulesets } from '@ldr/core';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';

/** One labelled row of scaffold diagnostics. */
function Row({
  label,
  value,
  tokens,
}: {
  readonly label: string;
  readonly value: string;
  readonly tokens: ThemeTokens;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: tokens.textSecondary }]}>{label}</Text>
      <Text style={[styles.value, { color: tokens.textPrimary }]}>{value}</Text>
    </View>
  );
}

export function BootScreen() {
  const tokens = themeTokens();

  // Reading the registries proves the shared domain modules ran their
  // self-registration on import, not merely that the bundle resolved.
  const realTimeGames = listRulesets()
    .map((ruleset) => ruleset.name)
    .join(', ');
  const asyncGames = ASYNC_GAME_DEFS.map((def) => def.name).join(', ');

  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: tokens.surface,
            borderColor: tokens.border,
            shadowColor: tokens.shadow,
          },
        ]}
      >
        <Text style={[styles.title, { color: tokens.textPrimary }]}>LDR Companion</Text>
        <Text style={[styles.subtitle, { color: tokens.textMuted }]}>
          Shell scaffold — screens arrive in 22.1b
        </Text>

        <View style={[styles.divider, { backgroundColor: tokens.border }]} />

        <Row label="Shared core" value={CORE_PACKAGE_NAME} tokens={tokens} />
        <Row label="Real-time games" value={realTimeGames} tokens={tokens} />
        <Row label="Async games" value={asyncGames} tokens={tokens} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 20,
  },
  row: {
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  value: {
    marginTop: 2,
    fontSize: 16,
  },
});
