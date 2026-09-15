import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
} from 'react-native-reanimated';
import type { ThemeTokens } from '@ldr/core';

import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';

export function BattleshipResultCard({
  won,
  tokens,
}: {
  readonly won: boolean;
  readonly tokens: ThemeTokens;
}) {
  const reveal = useSharedValue(0);
  const celebration = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    reveal.set(
      withSpring(1, {
        duration: reducedMotion ? 0 : 460,
        dampingRatio: 0.76,
        reduceMotion: ReduceMotion.System,
      }),
    );
    if (won) {
      celebration.set(
        withDelay(
          reducedMotion ? 0 : 90,
          withSpring(1, {
            duration: reducedMotion ? 0 : 720,
            dampingRatio: 0.64,
            reduceMotion: ReduceMotion.System,
          }),
        ),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [celebration, reducedMotion, reveal, won]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: reveal.get(),
    transform: [
      { translateY: interpolate(reveal.get(), [0, 1], [14, 0]) },
      { scale: interpolate(reveal.get(), [0, 1], [0.94, 1]) },
    ],
  }));
  const burstStyle = useAnimatedStyle(() => ({
    opacity: celebration.get(),
    transform: [
      { rotate: `${interpolate(celebration.get(), [0, 1], [-18, 8])}deg` },
      { scale: interpolate(celebration.get(), [0, 1], [0.35, 1]) },
    ],
  }));

  return (
    <Animated.View
      accessible
      accessibilityRole="summary"
      accessibilityLiveRegion="assertive"
      style={[
        styles.card,
        clayRaisedStyle(tokens),
        {
          backgroundColor: won ? tokens.success : tokens.textPrimary,
          borderColor: won ? tokens.primaryStrong : tokens.textSecondary,
        },
        cardStyle,
      ]}
    >
      {won ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, burstStyle]}>
          <AppText tokens={tokens} style={[styles.spark, styles.sparkTop]}>
            ✦
          </AppText>
          <AppText tokens={tokens} style={[styles.spark, styles.sparkLeft]}>
            ✦
          </AppText>
          <AppText tokens={tokens} style={[styles.spark, styles.sparkRight]}>
            ✦
          </AppText>
          <AppText tokens={tokens} style={[styles.spark, styles.sparkBottom]}>
            ✦
          </AppText>
        </Animated.View>
      ) : null}
      <AppText
        kind="title"
        tokens={tokens}
        style={[styles.title, { color: won ? tokens.textPrimary : tokens.surface }]}
      >
        {won ? 'Victory!' : 'Fleet lost'}
      </AppText>
      <AppText tokens={tokens} style={{ color: won ? tokens.textSecondary : tokens.surfaceMuted }}>
        {won
          ? 'Every ship is sunk. Nicely played.'
          : 'Your fleet has gone dark. Start another game for a rematch.'}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 28,
    marginTop: 12,
    minHeight: 132,
    overflow: 'visible',
    padding: 22,
    position: 'relative',
  },
  title: { marginBottom: 6 },
  spark: { position: 'absolute', fontSize: 25, lineHeight: 28, fontWeight: '900' },
  sparkTop: { top: -13, left: '48%' },
  sparkLeft: { top: 34, left: -9 },
  sparkRight: { top: 24, right: -8 },
  sparkBottom: { bottom: -13, right: 44 },
});
