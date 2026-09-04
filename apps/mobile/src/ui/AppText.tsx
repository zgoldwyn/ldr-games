import { StyleSheet, Text, type TextProps } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';

type Kind = 'title' | 'body' | 'muted' | 'label' | 'error';

const KIND_COLOR: Record<Kind, keyof ThemeTokens> = {
  title: 'textPrimary',
  body: 'textPrimary',
  muted: 'textMuted',
  label: 'textSecondary',
  error: 'error',
};

/** Text styled from semantic tokens, never a raw hex. */
export function AppText({
  kind = 'body',
  tokens,
  style,
  ...rest
}: TextProps & { readonly kind?: Kind; readonly tokens?: ThemeTokens }) {
  const theme = tokens ?? themeTokens();
  return <Text {...rest} style={[styles[kind], { color: theme[KIND_COLOR[kind]] }, style]} />;
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 14, lineHeight: 20 },
  label: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  error: { fontSize: 14, lineHeight: 20 },
});
