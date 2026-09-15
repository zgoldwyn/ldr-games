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
        styles.clayShell,
        {
          width: horizontal ? length * cellSize : cellSize,
          height: horizontal ? cellSize : length * cellSize,
          backgroundColor: tokens.onPrimary,
          shadowColor: tokens.shadow,
          padding: cellSize * 0.055,
          shadowOffset: { width: 0, height: cellSize * 0.11 },
          shadowRadius: cellSize * 0.17,
        },
      ]}
    >
      <View
        style={[
          styles.hull,
          {
            backgroundColor: tokens.primaryStrong,
            borderColor: tokens.surface,
            borderWidth: cellSize * 0.03,
            flexDirection: horizontal ? 'row' : 'column',
          },
        ]}
      >
        {Array.from({ length }, (_, index) => (
          <View key={index} style={styles.segment}>
            <View
              style={[
                styles.dot,
                {
                  width: cellSize * 0.18,
                  height: cellSize * 0.18,
                  borderRadius: cellSize * 0.09,
                  backgroundColor: tokens.surface,
                },
              ]}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clayShell: {
    borderRadius: 999,
    shadowOpacity: 1,
    elevation: 4,
  },
  hull: {
    flex: 1,
    borderRadius: 999,
    alignItems: 'stretch',
    overflow: 'hidden',
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dot: { minWidth: 3, minHeight: 3 },
});
