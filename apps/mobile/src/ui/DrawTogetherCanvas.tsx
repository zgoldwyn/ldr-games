import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Path, Skia, usePathValue, type SkPath } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  drawPointOnCanvas,
  normalizeDrawPoint,
  type DrawPoint,
  type DrawStroke,
  type DrawStrokeBatch,
} from '../games/draw-together-canvas';

const LIVE_BATCH_POINTS = 8;

function strokePath(stroke: DrawStroke, width: number, height: number): SkPath {
  const path = Skia.Path.Make();
  const first = stroke.points[0];
  if (first === undefined) return path;
  const start = drawPointOnCanvas(first, width, height);
  path.moveTo(start.x, start.y);
  if (stroke.points.length === 1) path.lineTo(start.x + 0.01, start.y);
  for (const point of stroke.points.slice(1)) {
    const next = drawPointOnCanvas(point, width, height);
    path.lineTo(next.x, next.y);
  }
  return path;
}

export function DrawTogetherCanvas({
  width,
  height,
  strokes,
  color,
  strokeWidth,
  backgroundColor,
  disabled = false,
  onStroke,
  onStrokeBatch,
}: {
  readonly width: number;
  readonly height: number;
  readonly strokes: readonly DrawStroke[];
  readonly color: string;
  readonly strokeWidth: number;
  readonly backgroundColor: string;
  readonly disabled?: boolean;
  readonly onStroke: (stroke: DrawStroke) => void;
  readonly onStrokeBatch?: (batch: DrawStrokeBatch) => void;
}) {
  const currentPoints = useSharedValue<readonly DrawPoint[]>([]);
  const currentStrokeId = useSharedValue('');
  const sentPointCount = useSharedValue(0);
  const batchSequence = useSharedValue(0);
  const currentPath = usePathValue((builder) => {
    'worklet';
    const points = currentPoints.get();
    const first = points[0];
    if (first === undefined) return;
    builder.moveTo(first.x * width, first.y * height);
    if (points.length === 1) builder.lineTo(first.x * width + 0.01, first.y * height);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point !== undefined) builder.lineTo(point.x * width, point.y * height);
    }
  });

  const committed = useMemo(
    () => strokes.map((stroke) => ({ stroke, path: strokePath(stroke, width, height) })),
    [height, strokes, width],
  );

  const commitStroke = useCallback(
    (id: string, points: readonly DrawPoint[]) => {
      if (points.length === 0) return;
      onStroke({
        id,
        color,
        width: strokeWidth,
        points,
      });
    },
    [color, onStroke, strokeWidth],
  );

  const emitLiveBatch = useCallback(
    (strokeId: string, sequence: number, points: readonly DrawPoint[], final: boolean) => {
      onStrokeBatch?.({ strokeId, sequence, color, width: strokeWidth, points, final });
    },
    [color, onStrokeBatch, strokeWidth],
  );

  useAnimatedReaction(
    () => {
      const count = currentPoints.get().length;
      return count - sentPointCount.get() >= LIVE_BATCH_POINTS ? count : -1;
    },
    (count) => {
      if (count < 0) return;
      const start = sentPointCount.get();
      const points = currentPoints.get().slice(start, count);
      const sequence = batchSequence.get();
      sentPointCount.set(count);
      batchSequence.set(sequence + 1);
      scheduleOnRN(emitLiveBatch, currentStrokeId.get(), sequence, points, false);
    },
    [emitLiveBatch],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .minDistance(0)
        .onBegin((event) => {
          currentStrokeId.set(
            `${Date.now()}-${Math.round(event.absoluteX)}-${Math.round(event.absoluteY)}`,
          );
          sentPointCount.set(0);
          batchSequence.set(0);
          currentPoints.set([normalizeDrawPoint(event.x, event.y, width, height)]);
        })
        .onUpdate((event) => {
          const point = normalizeDrawPoint(event.x, event.y, width, height);
          currentPoints.set((points) => [...points, point]);
        })
        .onEnd(() => {
          const points = currentPoints.get();
          const sent = sentPointCount.get();
          scheduleOnRN(
            emitLiveBatch,
            currentStrokeId.get(),
            batchSequence.get(),
            points.slice(sent),
            true,
          );
          scheduleOnRN(commitStroke, currentStrokeId.get(), points);
        })
        .onFinalize(() => {
          currentPoints.set([]);
        }),
    [
      batchSequence,
      commitStroke,
      currentPoints,
      currentStrokeId,
      disabled,
      emitLiveBatch,
      height,
      sentPointCount,
      width,
    ],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessibilityLabel={disabled ? 'Partner drawing canvas' : 'Drawing canvas'}
        accessibilityRole="image"
        style={[styles.frame, { width, height, backgroundColor }]}
      >
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          {committed.map(({ stroke, path }) => (
            <Path
              key={stroke.id}
              path={path}
              color={stroke.color}
              style="stroke"
              strokeWidth={stroke.width}
              strokeCap="round"
              strokeJoin="round"
            />
          ))}
          <Path
            path={currentPath}
            color={color}
            style="stroke"
            strokeWidth={strokeWidth}
            strokeCap="round"
            strokeJoin="round"
          />
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 24,
    overflow: 'hidden',
  },
});
