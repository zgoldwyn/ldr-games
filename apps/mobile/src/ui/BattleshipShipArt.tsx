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
      <View
        style={[
          styles.deckLine,
          horizontal
            ? {
                left: cellSize * 0.4,
                right: cellSize * 0.4,
                top: cellSize / 2 - 1.5,
                height: 3,
              }
            : {
                top: cellSize * 0.4,
                bottom: cellSize * 0.4,
                left: cellSize / 2 - 1.5,
                width: 3,
              },
          { backgroundColor: tokens.onPrimary },
        ]}
      />
      {Array.from({ length }, (_, index) => (
        <View key={index} style={styles.segment}>
          {index !== Math.floor(length / 2) ? (
            <View style={[styles.porthole, { backgroundColor: tokens.surface }]} />
          ) : null}
          {index === Math.floor(length / 2) ? (
            <View
              style={[
                styles.bridge,
                {
                  backgroundColor: tokens.onPrimary,
                  borderColor: tokens.surface,
                  width: horizontal ? 12 : 15,
                  height: horizontal ? 15 : 12,
                },
              ]}
            >
              <View style={[styles.bridgeWindow, { backgroundColor: tokens.surface }]} />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hull: {
    borderWidth: 2,
    borderRadius: 999,
    overflow: 'hidden',
    alignItems: 'stretch',
  },
  deckLine: { position: 'absolute', alignSelf: 'center', borderRadius: 999, opacity: 0.24 },
  segment: { flex: 1, zIndex: 1, alignItems: 'center', justifyContent: 'center' },
  porthole: { width: 5, height: 5, borderRadius: 3, opacity: 0.95 },
  bridge: {
    position: 'absolute',
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bridgeWindow: { width: 4, height: 4, borderRadius: 2 },
});
