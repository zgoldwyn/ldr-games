export interface DrawPoint {
  /** Horizontal position normalized to the canvas width. */
  readonly x: number;
  /** Vertical position normalized to the canvas height. */
  readonly y: number;
}

export interface DrawStroke {
  readonly id: string;
  readonly color: string;
  readonly width: number;
  readonly points: readonly DrawPoint[];
}

export interface DrawStrokeBatch {
  readonly strokeId: string;
  readonly sequence: number;
  readonly color: string;
  readonly width: number;
  readonly points: readonly DrawPoint[];
  readonly final: boolean;
}

export interface RemoteStrokeBuffer {
  readonly strokeId: string;
  readonly nextSequence: number;
  readonly color: string;
  readonly width: number;
  readonly points: readonly DrawPoint[];
  readonly final: boolean;
}

export type StrokeBatchResult =
  | { readonly kind: 'applied'; readonly buffer: RemoteStrokeBuffer }
  | { readonly kind: 'duplicate'; readonly buffer: RemoteStrokeBuffer }
  | { readonly kind: 'gap'; readonly expectedSequence: number };

const clampUnit = (value: number): number => {
  'worklet';
  return Math.max(0, Math.min(1, value));
};

/** Canvas-size-independent wire coordinates. */
export function normalizeDrawPoint(x: number, y: number, width: number, height: number): DrawPoint {
  'worklet';
  if (width <= 0 || height <= 0) return { x: 0, y: 0 };
  return { x: clampUnit(x / width), y: clampUnit(y / height) };
}

export function drawPointOnCanvas(point: DrawPoint, width: number, height: number): DrawPoint {
  return { x: clampUnit(point.x) * width, y: clampUnit(point.y) * height };
}

/**
 * Apply a realtime stroke batch exactly once. A sequence gap asks the caller
 * for a recovery snapshot rather than drawing an unknowably broken line.
 */
export function applyDrawStrokeBatch(
  current: RemoteStrokeBuffer | undefined,
  batch: DrawStrokeBatch,
): StrokeBatchResult {
  if (!Number.isInteger(batch.sequence) || batch.sequence < 0) {
    return { kind: 'gap', expectedSequence: current?.nextSequence ?? 0 };
  }
  if (current !== undefined && current.strokeId !== batch.strokeId) {
    return { kind: 'gap', expectedSequence: 0 };
  }

  const expected = current?.nextSequence ?? 0;
  if (batch.sequence < expected) {
    return { kind: 'duplicate', buffer: current as RemoteStrokeBuffer };
  }
  if (batch.sequence > expected) {
    return { kind: 'gap', expectedSequence: expected };
  }

  return {
    kind: 'applied',
    buffer: {
      strokeId: batch.strokeId,
      nextSequence: expected + 1,
      color: current?.color ?? batch.color,
      width: current?.width ?? batch.width,
      points: [...(current?.points ?? []), ...batch.points],
      final: batch.final,
    },
  };
}

/** Split a stroke into bounded Broadcast payloads with ordered sequences. */
export function drawStrokeBatches(stroke: DrawStroke, maxPoints = 12): readonly DrawStrokeBatch[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 1) return [];
  const batches: DrawStrokeBatch[] = [];
  for (let index = 0; index < stroke.points.length; index += maxPoints) {
    const points = stroke.points.slice(index, index + maxPoints);
    batches.push({
      strokeId: stroke.id,
      sequence: batches.length,
      color: stroke.color,
      width: stroke.width,
      points,
      final: index + maxPoints >= stroke.points.length,
    });
  }
  return batches;
}
