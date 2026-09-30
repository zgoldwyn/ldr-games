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
  topPadding = true,
  bottomInset = true,
  bottomPadding = true,
  horizontalPadding = true,
}: {
  readonly children: ReactNode;
  readonly tokens?: ThemeTokens;
  /** Disable when a React Navigation header already owns the top safe area. */
  readonly topInset?: boolean;
  /** Disable when scroll content should begin directly below a navigation header. */
  readonly topPadding?: boolean;
  /** Disable when a bottom navigator already owns the device safe area. */
  readonly bottomInset?: boolean;
  /** Disable when content should meet a bottom navigator without an extra band. */
  readonly bottomPadding?: boolean;
  /** Disable for scroll views, which need a full-width viewport for unclipped shadows. */
  readonly horizontalPadding?: boolean;
}) {
  const theme = tokens ?? themeTokens();
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: theme.background }]}
      edges={[
        ...(topInset ? (['top'] as const) : []),
        ...(bottomInset ? (['bottom'] as const) : []),
      ]}
    >
      <View
        style={[
          styles.inner,
          !topPadding && styles.withoutTopPadding,
          !bottomPadding && styles.withoutBottomPadding,
          horizontalPadding && styles.horizontalPadding,
        ]}
      >
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  inner: { flex: 1, paddingVertical: 24 },
  withoutTopPadding: { paddingTop: 0 },
  withoutBottomPadding: { paddingBottom: 0 },
  horizontalPadding: { paddingHorizontal: 24 },
});
