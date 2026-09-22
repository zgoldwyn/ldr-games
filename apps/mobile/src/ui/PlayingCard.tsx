import { Pressable, StyleSheet, View } from 'react-native';
import type { SpeedCard, ThemeTokens } from '@ldr/core';

import { rankLabel, suitSymbol } from '../games/speed-view';
import { AppText } from './AppText';
import { clayPressedStyle, clayRaisedStyle } from './clay';

export function PlayingCard({
  card,
  tokens,
  disabled = false,
  onPress,
  compact = false,
}: {
  readonly card: SpeedCard;
  readonly tokens: ThemeTokens;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly compact?: boolean;
}) {
  const symbol = suitSymbol(card.suit);
  const label = `${rankLabel(card.rank)} of ${card.suit}`;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      accessibilityHint={onPress && !disabled ? 'Plays this card' : undefined}
      accessibilityState={{ disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        compact ? styles.compact : styles.full,
        pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
        { backgroundColor: tokens.surface, opacity: disabled ? 0.52 : 1 },
      ]}
    >
      <View style={styles.corner}>
        <AppText kind="body" tokens={tokens} style={styles.rank}>
          {rankLabel(card.rank)}
        </AppText>
        <AppText kind="body" tokens={tokens} style={styles.suit}>
          {symbol}
        </AppText>
      </View>
      <AppText kind="title" tokens={tokens} style={styles.centerSuit}>
        {symbol}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 8, justifyContent: 'space-between' },
  full: { width: 64, height: 94 },
  compact: { width: 72, height: 104 },
  corner: { alignItems: 'flex-start' },
  rank: { fontSize: 18, lineHeight: 20, fontWeight: '800' },
  suit: { fontSize: 17, lineHeight: 19 },
  centerSuit: { alignSelf: 'center', fontSize: 30, lineHeight: 34 },
});
