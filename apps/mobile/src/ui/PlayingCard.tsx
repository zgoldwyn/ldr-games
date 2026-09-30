import { Image, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import type { SpeedCard, ThemeTokens } from '@ldr/core';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { playingCardImage } from '../games/playing-card-images';
import { rankLabel } from '../games/speed-view';
import { clayPressedStyle, clayRaisedStyle } from './clay';

export function PlayingCard({
  card,
  tokens,
  disabled = false,
  onPress,
  compact = false,
  onLayout,
}: {
  readonly card: SpeedCard;
  readonly tokens: ThemeTokens;
  readonly disabled?: boolean;
  readonly onPress?: () => boolean | 'cooldown' | void;
  readonly compact?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const label = `${rankLabel(card.rank)} of ${card.suit}`;
  const shakeX = useSharedValue(0);
  const shakeRotation = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.get() }, { rotate: `${shakeRotation.get()}deg` }],
  }));

  function handlePress() {
    const result = onPress?.();
    if (result !== false && result !== 'cooldown') return;
    const timing = { easing: Easing.bezier(0.77, 0, 0.175, 1), reduceMotion: ReduceMotion.System };
    if (result === 'cooldown') {
      shakeX.set(
        withSequence(
          withTiming(-2, { ...timing, duration: 25 }),
          withTiming(2, { ...timing, duration: 35 }),
          withTiming(0, { ...timing, duration: 30 }),
        ),
      );
      return;
    }
    shakeX.set(
      withSequence(
        withTiming(-7, { ...timing, duration: 35 }),
        withTiming(6, { ...timing, duration: 45 }),
        withTiming(-5, { ...timing, duration: 40 }),
        withTiming(3, { ...timing, duration: 35 }),
        withTiming(0, { ...timing, duration: 35 }),
      ),
    );
    shakeRotation.set(
      withSequence(
        withTiming(-2, { ...timing, duration: 35 }),
        withTiming(2, { ...timing, duration: 45 }),
        withTiming(-1.5, { ...timing, duration: 40 }),
        withTiming(0.75, { ...timing, duration: 35 }),
        withTiming(0, { ...timing, duration: 35 }),
      ),
    );
  }

  return (
    <Animated.View onLayout={onLayout} style={shakeStyle}>
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={label}
        accessibilityHint={onPress ? 'Attempts to play this card' : undefined}
        accessibilityState={{ disabled }}
        disabled={disabled || !onPress}
        onPress={handlePress}
        pressRetentionOffset={10}
        style={({ pressed }) => [
          styles.card,
          compact ? styles.compact : styles.full,
          pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
          { backgroundColor: '#FFFDF8' },
        ]}
      >
        <Image source={playingCardImage(card)} resizeMode="stretch" style={styles.image} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 10, padding: 0, overflow: 'hidden' },
  full: { width: 64, height: 90 },
  compact: { width: 72, height: 101 },
  image: { width: '100%', height: '100%' },
});
