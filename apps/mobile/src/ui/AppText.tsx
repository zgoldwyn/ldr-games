import { Platform, StyleSheet, Text, type TextProps } from 'react-native';
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
  title: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  body: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  muted: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  label: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  error: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
});
