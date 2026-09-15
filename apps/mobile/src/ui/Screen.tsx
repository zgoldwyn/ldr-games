import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';

/** Padded canvas that respects device safe areas. */
export function Screen({
  children,
  tokens,
  topInset = true,
  horizontalPadding = true,
}: {
  readonly children: ReactNode;
  readonly tokens?: ThemeTokens;
  /** Disable when a React Navigation header already owns the top safe area. */
  readonly topInset?: boolean;
  /** Disable for scroll views, which need a full-width viewport for unclipped shadows. */
  readonly horizontalPadding?: boolean;
}) {
  const theme = tokens ?? themeTokens();
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: theme.background }]}
      edges={topInset ? ['top', 'bottom'] : ['bottom']}
    >
      <View style={[styles.inner, horizontalPadding && styles.horizontalPadding]}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  inner: { flex: 1, paddingVertical: 24 },
  horizontalPadding: { paddingHorizontal: 24 },
});
