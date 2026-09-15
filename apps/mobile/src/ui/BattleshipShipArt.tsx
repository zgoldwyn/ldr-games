import { StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import type { ShipOrientation } from '../games/battleship-fleet';

export function BattleshipShipArt({
  length,
  orientation,
  tokens,
  cellSize = 20,
}: {
  readonly length: number;
  readonly orientation: ShipOrientation;
  readonly tokens: ThemeTokens;
  readonly cellSize?: number;
}) {
  const horizontal = orientation === 'horizontal';
  return (
    <View
      pointerEvents="none"
      style={[
        styles.hull,
        {
          width: horizontal ? length * cellSize : cellSize,
          height: horizontal ? cellSize : length * cellSize,
          backgroundColor: tokens.primaryStrong,
          borderColor: tokens.onPrimary,
          flexDirection: horizontal ? 'row' : 'column',
        },
      ]}
    >
      {Array.from({ length }, (_, index) => (
        <View key={index} style={styles.segment}>
          {index > 0 && index < length - 1 ? (
            <View style={[styles.porthole, { backgroundColor: tokens.surface }]} />
          ) : null}
          {index === Math.floor(length / 2) ? (
            <View
              style={[
                styles.bridge,
                {
                  backgroundColor: tokens.onPrimary,
                  width: horizontal ? 8 : 12,
                  height: horizontal ? 12 : 8,
                },
              ]}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hull: {
    borderWidth: 1,
    borderRadius: 999,
    overflow: 'hidden',
    alignItems: 'stretch',
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  porthole: { width: 4, height: 4, borderRadius: 2, opacity: 0.9 },
  bridge: { position: 'absolute', borderRadius: 3, opacity: 0.72 },
});
