import { forwardRef } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';
import { AppText } from './AppText';
import { clayInsetStyle } from './clay';

/** Labelled field. Placeholder colour comes from `textMuted`. */
export const AppField = forwardRef<
  TextInput,
  TextInputProps & { readonly label: string; readonly tokens?: ThemeTokens }
>(function AppField({ label, tokens, ...rest }, ref) {
  const theme = tokens ?? themeTokens();
  return (
    <View style={styles.wrap}>
      <AppText kind="label" tokens={theme} style={styles.label}>
        {label}
      </AppText>
      <TextInput
        {...rest}
        ref={ref}
        accessibilityLabel={rest.accessibilityLabel ?? label}
        placeholderTextColor={theme.textMuted}
        style={[
          styles.input,
          clayInsetStyle(theme),
          {
            backgroundColor: theme.surfaceMuted,
            borderColor: theme.primaryStrong,
            color: theme.textPrimary,
          },
          rest.style,
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: { marginBottom: 8 },
  input: {
    minHeight: 48,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 16,
    fontWeight: '500',
  },
});
