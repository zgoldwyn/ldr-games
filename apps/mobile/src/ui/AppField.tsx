import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';
import { AppText } from './AppText';

/** Labelled field. Placeholder colour comes from `textMuted`. */
export function AppField({
  label,
  tokens,
  ...rest
}: TextInputProps & { readonly label: string; readonly tokens?: ThemeTokens }) {
  const theme = tokens ?? themeTokens();
  return (
    <View style={styles.wrap}>
      <AppText kind="label" tokens={theme} style={styles.label}>
        {label}
      </AppText>
      <TextInput
        {...rest}
        placeholderTextColor={theme.textMuted}
        style={[
          styles.input,
          {
            backgroundColor: theme.surface,
            borderColor: theme.border,
            color: theme.textPrimary,
          },
          rest.style,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: { marginBottom: 8 },
  input: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
});
