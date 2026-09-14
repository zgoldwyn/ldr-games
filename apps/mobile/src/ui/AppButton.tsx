import { Pressable, StyleSheet, type PressableProps } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';
import { AppText } from './AppText';

/** Primary or quiet button, coloured from tokens. */
export function AppButton({
  label,
  variant = 'primary',
  tokens,
  disabled,
  ...rest
}: PressableProps & {
  readonly label: string;
  readonly variant?: 'primary' | 'quiet';
  readonly tokens?: ThemeTokens;
}) {
  const theme = tokens ?? themeTokens();
  const primary = variant === 'primary';

  return (
    <Pressable
      {...rest}
      accessibilityRole={rest.accessibilityRole ?? 'button'}
      accessibilityLabel={rest.accessibilityLabel ?? label}
      accessibilityState={{ ...rest.accessibilityState, disabled: disabled === true }}
      disabled={disabled}
      hitSlop={rest.hitSlop ?? 4}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: primary
            ? pressed
              ? theme.primaryStrong
              : theme.primary
            : theme.surfaceMuted,
          borderColor: theme.border,
          opacity: disabled === true ? 0.5 : 1,
        },
      ]}
    >
      <AppText
        kind="body"
        tokens={theme}
        style={{
          color: primary ? theme.onPrimary : theme.textPrimary,
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
});
