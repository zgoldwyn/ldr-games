import { StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { clayRaisedStyle } from './clay';

export function TicTacToeMark({
  mark,
  tokens,
}: {
  readonly mark: 'X' | 'O';
  readonly tokens: ThemeTokens;
}) {
  if (mark === 'O') {
    return (
      <View
        testID="tic-tac-toe-mark-o"
        style={[styles.ring, clayRaisedStyle(tokens, true), { borderColor: tokens.primaryStrong }]}
      />
    );
  }

  return (
    <View testID="tic-tac-toe-mark-x" style={styles.cross}>
      <View
        style={[
          styles.crossStroke,
          styles.crossForward,
          clayRaisedStyle(tokens, true),
          { backgroundColor: tokens.primaryStrong },
        ]}
      />
      <View
        style={[
          styles.crossStroke,
          styles.crossBackward,
          clayRaisedStyle(tokens, true),
          { backgroundColor: tokens.primaryStrong },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cross: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center' },
  crossStroke: { position: 'absolute', width: 58, height: 10, borderRadius: 8 },
  crossForward: { transform: [{ rotate: '45deg' }] },
  crossBackward: { transform: [{ rotate: '-45deg' }] },
  ring: { width: 54, height: 54, borderRadius: 27, borderWidth: 10 },
});
