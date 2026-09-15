import { Pressable, StyleSheet, type PressableProps } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { ThemeTokens } from '@ldr/core';

import { themeTokens } from '../theme';
import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

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
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  const springTo = (value: number) => {
    scale.set(
      withSpring(value, {
        duration: reducedMotion ? 0 : 320,
        dampingRatio: 0.82,
        reduceMotion: ReduceMotion.System,
      }),
    );
  };

  return (
    <Pressable
      {...rest}
      accessibilityRole={rest.accessibilityRole ?? 'button'}
      accessibilityLabel={rest.accessibilityLabel ?? label}
      accessibilityState={{ ...rest.accessibilityState, disabled: disabled === true }}
      disabled={disabled}
      hitSlop={rest.hitSlop ?? 4}
      onPressIn={(event) => {
        springTo(0.97);
        rest.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        springTo(1);
        rest.onPressOut?.(event);
      }}
      style={rest.style}
    >
      <Animated.View
        style={[
          styles.base,
          clayRaisedStyle(theme, true),
          {
            backgroundColor: primary ? theme.primary : theme.surfaceMuted,
            borderColor: primary ? theme.surface : theme.primary,
            opacity: disabled === true ? 0.5 : 1,
          },
          animatedStyle,
        ]}
      >
        <AppText
          kind="body"
          tokens={theme}
          style={{
            color: primary ? theme.onPrimary : theme.textPrimary,
            fontWeight: '700',
            textAlign: 'center',
          }}
        >
          {label}
        </AppText>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
});
