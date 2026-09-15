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
  dimmed = false,
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
  readonly dimmed?: boolean;
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

  const shipControl = (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.dragLayer, animatedStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ship.name}, ${ship.length} cells, ${ship.orientation}${ship.placement === null ? ', not placed' : ', placed'}`}
          accessibilityHint={
            showDetails && ship.placement !== null
              ? 'Placed on the grid. Drag the ship on the board to reposition it.'
              : 'Drag the ship onto the grid. Tap to rotate it.'
          }
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={8}
          onPress={() => onRotate(ship.id)}
          style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
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
  );

  return (
    <View style={[showDetails ? styles.dockSlot : styles.boardSlot, dimmed && styles.dimmed]}>
      {showDetails ? <View style={styles.dockStage}>{shipControl}</View> : shipControl}
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
    width: '33.333%',
    height: 136,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  dockStage: {
    width: 100,
    height: 94,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  boardSlot: { overflow: 'visible' },
  dimmed: { opacity: 0.38 },
  dragLayer: { alignSelf: 'center' },
  copy: { height: 34, alignItems: 'center', justifyContent: 'flex-end' },
  name: { fontWeight: '700', fontSize: 14, lineHeight: 17 },
});
