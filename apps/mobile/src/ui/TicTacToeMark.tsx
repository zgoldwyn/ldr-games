import { StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { clayInsetStyle, clayRaisedStyle } from './clay';

export function TicTacToeMark({
  mark,
  tokens,
  backgroundColor,
}: {
  readonly mark: 'X' | 'O';
  readonly tokens: ThemeTokens;
  readonly backgroundColor: string;
}) {
  if (mark === 'O') {
    return (
      <View
        testID="tic-tac-toe-mark-o"
        style={[
          styles.ring,
          clayRaisedStyle(tokens, true),
          { backgroundColor: tokens.primaryStrong },
        ]}
      >
        <View style={[styles.ringCenter, clayInsetStyle(tokens), { backgroundColor }]} />
      </View>
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
  ring: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  ringCenter: { width: 30, height: 30, borderRadius: 15 },
});
