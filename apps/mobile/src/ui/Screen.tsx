import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';

/** Padded canvas that respects device safe areas. */
export function Screen({
  children,
  tokens,
}: {
  readonly children: ReactNode;
  readonly tokens?: ThemeTokens;
}) {
  const theme = tokens ?? themeTokens();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={styles.inner}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  inner: { flex: 1, padding: 24 },
});
