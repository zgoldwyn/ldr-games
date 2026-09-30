import { Pressable, StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

export function MainPageMarker({
  title,
  detail,
  actionLabel,
  onAction,
  tokens,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly tokens: ThemeTokens;
}) {
  return (
    <View
      style={[
        styles.marker,
        clayRaisedStyle(tokens, true),
        { backgroundColor: tokens.surfaceMuted },
      ]}
    >
      <View style={styles.copy}>
        <AppText kind="body" tokens={tokens} style={styles.title}>
          {title}
        </AppText>
        {detail !== undefined ? (
          <AppText kind="label" tokens={tokens} numberOfLines={1} style={styles.detail}>
            {detail}
          </AppText>
        ) : null}
      </View>
      {actionLabel !== undefined && onAction !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={8}
          onPress={onAction}
          style={({ pressed }) => [styles.action, { opacity: pressed ? 0.5 : 1 }]}
        >
          <AppText kind="label" tokens={tokens} style={styles.actionText}>
            {actionLabel.toUpperCase()} ›
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  marker: {
    minHeight: 52,
    borderRadius: 18,
    paddingVertical: 9,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontWeight: '800', lineHeight: 20 },
  detail: { fontSize: 9, lineHeight: 12, marginTop: 1 },
  action: { minHeight: 36, justifyContent: 'center', paddingLeft: 8 },
  actionText: { fontSize: 9, lineHeight: 12, letterSpacing: 0.5, fontWeight: '800' },
});
