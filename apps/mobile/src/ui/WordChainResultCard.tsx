import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
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

export function WordChainResultCard({
  won,
  wordCount,
  longestWordLength,
  tokens,
}: {
  readonly won: boolean;
  readonly wordCount: number;
  readonly longestWordLength: number;
  readonly tokens: ThemeTokens;
}) {
  const reveal = useSharedValue(0);
  const flourish = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    reveal.set(
      withSpring(1, {
        duration: reducedMotion ? 0 : 440,
        dampingRatio: 0.78,
        reduceMotion: ReduceMotion.System,
      }),
    );
    flourish.set(
      withDelay(
        reducedMotion ? 0 : 100,
        withSpring(1, {
          duration: reducedMotion ? 0 : 620,
          dampingRatio: 0.7,
          reduceMotion: ReduceMotion.System,
        }),
      ),
    );
    void Haptics.notificationAsync(
      won ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    );
  }, [flourish, reducedMotion, reveal, won]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: reveal.get(),
    transform: [
      { translateY: interpolate(reveal.get(), [0, 1], [14, 0]) },
      { scale: interpolate(reveal.get(), [0, 1], [0.95, 1]) },
    ],
  }));
  const flourishStyle = useAnimatedStyle(() => ({
    opacity: flourish.get(),
    transform: [{ scale: interpolate(flourish.get(), [0, 1], [0.75, 1]) }],
  }));

  return (
    <Animated.View
      accessible
      accessibilityRole="summary"
      accessibilityLiveRegion="assertive"
      style={[
        styles.card,
        clayRaisedStyle(tokens),
        { backgroundColor: won ? tokens.success : tokens.surfaceMuted },
        cardStyle,
      ]}
    >
      <Animated.View pointerEvents="none" style={[styles.sparkles, flourishStyle]}>
        <AppText tokens={tokens} style={[styles.spark, styles.sparkLeft]}>
          ✦
        </AppText>
        <AppText tokens={tokens} style={[styles.spark, styles.sparkRight]}>
          ✦
        </AppText>
      </Animated.View>
      <View style={styles.linkMark} accessible={false}>
        <View style={[styles.letterTile, { backgroundColor: tokens.surface }]}>
          <AppText kind="title" tokens={tokens} style={styles.letter}>
            A
          </AppText>
        </View>
        <View style={[styles.linkLine, { backgroundColor: tokens.onPrimary }]} />
        <View style={[styles.letterTile, styles.secondTile, { backgroundColor: tokens.primary }]}>
          <AppText kind="title" tokens={tokens} style={styles.letter}>
            Z
          </AppText>
        </View>
      </View>
      <View style={styles.copy}>
        <AppText kind="title" tokens={tokens} style={styles.title}>
          {won ? 'Last word standing!' : 'Round conceded'}
        </AppText>
        <AppText tokens={tokens}>
          {won
            ? `You survived ${wordCount} words. The chain reached ${longestWordLength} letters.`
            : `You made it through ${wordCount} words before giving up.`}
        </AppText>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    marginBottom: 20,
    minHeight: 148,
    overflow: 'visible',
    padding: 20,
    position: 'relative',
  },
  copy: { flex: 1 },
  title: { marginBottom: 5 },
  linkMark: { width: 76, height: 92, alignItems: 'center', justifyContent: 'center' },
  letterTile: {
    width: 50,
    height: 50,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
    left: 0,
    top: 2,
    transform: [{ rotate: '-8deg' }],
    zIndex: 2,
  },
  secondTile: { left: 27, top: 39, transform: [{ rotate: '8deg' }] },
  linkLine: { width: 30, height: 5, borderRadius: 999, transform: [{ rotate: '45deg' }] },
  letter: { fontSize: 23, lineHeight: 28 },
  sparkles: { position: 'absolute', inset: 0 },
  spark: { position: 'absolute', fontSize: 24, lineHeight: 28, fontWeight: '900' },
  sparkLeft: { left: -8, top: 19 },
  sparkRight: { right: -7, bottom: 17 },
});
