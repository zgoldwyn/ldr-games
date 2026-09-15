import { forwardRef } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';
import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

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
          clayRaisedStyle(theme, true),
          {
            backgroundColor: theme.surface,
            borderColor: theme.primary,
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
    fontSize: 16,
  },
});
