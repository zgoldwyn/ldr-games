import { useMemo } from 'react';
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

import type { DraftShip, DraftShipId } from '../games/battleship-placement';
import { AppText } from './AppText';
import { BattleshipShipArt } from './BattleshipShipArt';
import { clayRaisedStyle } from './clay';

const ART_CELL_SIZE = 15;

export function DraggableShip({
  ship,
  tokens,
  disabled,
  onDrop,
  onDragStart,
  onDragEnd,
  onRotate,
}: {
  readonly ship: DraftShip;
  readonly tokens: ThemeTokens;
  readonly disabled: boolean;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (
    id: DraftShipId,
    absoluteX: number,
    absoluteY: number,
    grabbedSegment: number,
  ) => void;
  readonly onRotate: (id: DraftShipId) => void;
}) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const artX = useSharedValue(0);
  const artY = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .minDistance(8)
        .onStart(() => {
          scale.set(1.04);
          scheduleOnRN(onDragStart);
        })
        .onUpdate((event) => {
          translateX.set(event.translationX);
          translateY.set(event.translationY);
        })
        .onEnd((event) => {
          const localAxis =
            ship.orientation === 'horizontal' ? event.x - artX.get() : event.y - artY.get();
          const grabbedSegment = Math.max(
            0,
            Math.min(ship.length - 1, Math.floor(localAxis / ART_CELL_SIZE)),
          );
          scheduleOnRN(onDrop, ship.id, event.absoluteX, event.absoluteY, grabbedSegment);
        })
        .onFinalize((event) => {
          const config = {
            duration: reducedMotion ? 0 : 400,
            dampingRatio: 0.8,
            velocity: event.velocityX,
            reduceMotion: ReduceMotion.System,
          };
          translateX.set(withSpring(0, config));
          translateY.set(withSpring(0, { ...config, velocity: event.velocityY }));
          scale.set(withSpring(1, { duration: reducedMotion ? 0 : 220, dampingRatio: 1 }));
          scheduleOnRN(onDragEnd);
        }),
    [
      disabled,
      artX,
      artY,
      onDragEnd,
      onDragStart,
      onDrop,
      reducedMotion,
      scale,
      ship.id,
      ship.length,
      ship.orientation,
      translateX,
      translateY,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.dragLayer, animatedStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ship.name}, ${ship.length} cells, ${ship.orientation}${ship.placement === null ? ', not placed' : ', placed'}`}
          accessibilityHint="Drag onto your grid. Tap to rotate."
          disabled={disabled}
          hitSlop={6}
          pressRetentionOffset={12}
          onPress={() => onRotate(ship.id)}
          style={({ pressed }) => [
            styles.card,
            clayRaisedStyle(tokens, true),
            {
              backgroundColor: ship.placement === null ? tokens.surface : tokens.surfaceMuted,
              borderColor: ship.placement === null ? tokens.border : tokens.primaryStrong,
              opacity: disabled ? 0.5 : pressed ? 0.78 : 1,
            },
          ]}
        >
          <View
            onLayout={(event) => {
              artX.set(event.nativeEvent.layout.x);
              artY.set(event.nativeEvent.layout.y);
            }}
          >
            <BattleshipShipArt
              length={ship.length}
              orientation={ship.orientation}
              tokens={tokens}
              cellSize={ART_CELL_SIZE}
            />
          </View>
          <AppText kind="muted" tokens={tokens} style={styles.name}>
            {ship.name} · {ship.length}
          </AppText>
          <AppText kind="label" tokens={tokens}>
            {ship.placement === null ? 'Drag to place' : 'Placed · drag to move'}
          </AppText>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  dragLayer: { width: '31.5%', marginRight: '1.75%', marginBottom: 8, zIndex: 10 },
  card: {
    minHeight: 122,
    borderWidth: 1,
    borderRadius: 22,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { marginTop: 8, fontWeight: '600' },
});
