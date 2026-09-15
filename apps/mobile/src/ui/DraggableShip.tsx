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

export function DraggableShip({
  ship,
  tokens,
  disabled,
  cellSize,
  dragScale = 1,
  showDetails = false,
  onDrop,
  onDragStart,
  onDragEnd,
  onRotate,
}: {
  readonly ship: DraftShip;
  readonly tokens: ThemeTokens;
  readonly disabled: boolean;
  readonly cellSize: number;
  readonly dragScale?: number;
  readonly showDetails?: boolean;
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
  const reducedMotion = useReducedMotion();

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .minDistance(6)
        .onStart(() => {
          scale.set(dragScale * 1.03);
          scheduleOnRN(onDragStart);
        })
        .onUpdate((event) => {
          translateX.set(event.translationX);
          translateY.set(event.translationY);
        })
        .onEnd((event) => {
          const localAxis = ship.orientation === 'horizontal' ? event.x : event.y;
          const grabbedSegment = Math.max(
            0,
            Math.min(ship.length - 1, Math.floor(localAxis / cellSize)),
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
      cellSize,
      disabled,
      dragScale,
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
    zIndex: scale.get() > 1 ? 100 : 1,
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <View style={showDetails ? styles.dockSlot : styles.boardSlot}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.dragLayer, animatedStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ship.name}, ${ship.length} cells, ${ship.orientation}${ship.placement === null ? ', not placed' : ', placed'}`}
            accessibilityHint="Drag the ship onto the grid. Tap to rotate it."
            disabled={disabled}
            hitSlop={8}
            onPress={() => onRotate(ship.id)}
            style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1 })}
          >
            <BattleshipShipArt
              length={ship.length}
              orientation={ship.orientation}
              tokens={tokens}
              cellSize={cellSize}
            />
          </Pressable>
        </Animated.View>
      </GestureDetector>
      {showDetails ? (
        <View pointerEvents="none" style={styles.copy}>
          <AppText kind="body" tokens={tokens} style={styles.name} numberOfLines={1}>
            {ship.name}
          </AppText>
          <AppText kind="label" tokens={tokens} numberOfLines={1}>
            {ship.placement === null ? 'Ready' : 'On grid'} · {ship.length}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dockSlot: {
    width: '50%',
    minHeight: 70,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  boardSlot: { overflow: 'visible' },
  dragLayer: { alignSelf: 'center' },
  copy: { marginTop: 6, alignItems: 'center' },
  name: { fontWeight: '700' },
});
