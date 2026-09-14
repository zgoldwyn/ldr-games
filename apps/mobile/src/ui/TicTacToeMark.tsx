import { StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

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
        style={[styles.ring, { borderColor: tokens.primaryStrong }]}
      />
    );
  }

  return (
    <View testID="tic-tac-toe-mark-x" style={styles.cross}>
      <View
        style={[styles.crossStroke, styles.crossForward, { backgroundColor: tokens.textPrimary }]}
      />
      <View
        style={[styles.crossStroke, styles.crossBackward, { backgroundColor: tokens.textPrimary }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cross: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center' },
  crossStroke: { position: 'absolute', width: 58, height: 7, borderRadius: 4 },
  crossForward: { transform: [{ rotate: '45deg' }] },
  crossBackward: { transform: [{ rotate: '-45deg' }] },
  ring: { width: 54, height: 54, borderRadius: 27, borderWidth: 7 },
});
