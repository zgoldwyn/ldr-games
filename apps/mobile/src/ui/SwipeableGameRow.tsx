import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { ThemeTokens } from '@ldr/core';

import { AppText } from './AppText';

const ACTION_WIDTH = 92;

export function SwipeableGameRow({
  children,
  tokens,
  disabled,
  accessibilityLabel,
  onOpen,
  onDelete,
}: {
  readonly children: ReactNode;
  readonly tokens: ThemeTokens;
  readonly disabled: boolean;
  readonly accessibilityLabel: string;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
}) {
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const [revealed, setRevealed] = useState(false);

  const settle = (open: boolean) => {
    'worklet';
    translateX.set(
      withSpring(open ? -ACTION_WIDTH : 0, {
        duration: reducedMotion ? 0 : 360,
        dampingRatio: 0.86,
        reduceMotion: ReduceMotion.System,
      }),
    );
    scheduleOnRN(setRevealed, open);
  };

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .activeOffsetX([-12, 12])
        .failOffsetY([-10, 10])
        .onStart(() => {
          startX.set(translateX.get());
        })
        .onUpdate((event) => {
          translateX.set(Math.max(-ACTION_WIDTH, Math.min(0, startX.get() + event.translationX)));
        })
        .onEnd(() => settle(translateX.get() < -ACTION_WIDTH * 0.45)),
    [disabled, reducedMotion, startX, translateX],
  );

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.get() }] }));

  return (
    <View style={styles.clip}>
      <View style={[styles.action, { backgroundColor: tokens.error }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${accessibilityLabel}`}
          disabled={disabled}
          hitSlop={6}
          onPress={onDelete}
          style={styles.deleteButton}
        >
          <AppText tokens={tokens} style={[styles.deleteLabel, { color: tokens.surface }]}>
            Delete
          </AppText>
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint="Opens the game. Swipe left for delete options."
            disabled={disabled}
            onPress={() => {
              if (revealed) {
                settle(false);
                return;
              }
              onOpen();
            }}
          >
            {children}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { borderRadius: 24, marginBottom: 12, overflow: 'hidden', position: 'relative' },
  action: {
    position: 'absolute',
    inset: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  deleteButton: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: ACTION_WIDTH,
  },
  deleteLabel: { fontWeight: '800' },
});
