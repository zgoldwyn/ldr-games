import { StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

/** Layout-preserving, motion-free loading state that is safe for Reduce Motion. */
export function SkeletonLoader({ tokens }: { readonly tokens: ThemeTokens }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading app content"
      style={styles.root}
    >
      <AppText kind="muted" tokens={tokens} accessibilityLiveRegion="polite">
        Restoring your session
      </AppText>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.blocks}
      >
        <View style={[styles.title, { backgroundColor: tokens.surfaceMuted }]} />
        <View style={[styles.line, { backgroundColor: tokens.surfaceMuted }]} />
        <View style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]} />
        <View style={[styles.card, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  blocks: { width: '100%', marginTop: 20 },
  title: { width: '54%', height: 28, borderRadius: 10, marginBottom: 12 },
  line: { width: '82%', height: 16, borderRadius: 8, marginBottom: 28 },
  card: { width: '100%', height: 88, borderRadius: 24, marginBottom: 16 },
});
