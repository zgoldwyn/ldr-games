import { Platform, StyleSheet, Text, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import { clayRaisedStyle } from './clay';

const marks: Readonly<Record<string, string>> = {
  Play: '✦',
  'Your Games': '↺',
  Leaderboard: '★',
  Scores: '★',
  Settings: '⚙︎',
  'Other Minigames': '◈',
  'Card Games': '♥',
  'Word Games': 'Aa',
  'Word Chain': 'Aa',
  Speed: '♠',
  'Ember & Tide': '≈',
  'Tic-tac-toe': '×',
  Battleship: '⌁',
  'Draw Together': '✎',
  'Couples Quiz': '?',
  Quizzes: '?',
  Account: '☺',
  'Pair up': '∞',
  'Legal & privacy': '§',
};

export function NavigationTitle({
  title,
  tokens,
}: {
  readonly title: string;
  readonly tokens: ThemeTokens;
}) {
  const mark = marks[title] ?? '✦';
  return (
    <View
      accessibilityRole="header"
      style={[
        styles.plaque,
        clayRaisedStyle(tokens, true),
        { backgroundColor: tokens.surface },
      ]}
    >
      <View style={[styles.mark, { backgroundColor: tokens.primary }]} accessible={false}>
        <Text style={[styles.markText, { color: tokens.textPrimary }]}>{mark}</Text>
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: tokens.textPrimary }]}>
        {title}
      </Text>
      <View style={[styles.spark, { backgroundColor: tokens.accent }]} accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  plaque: {
    minHeight: 36,
    maxWidth: 250,
    borderRadius: 16,
    paddingLeft: 6,
    paddingRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  mark: {
    width: 25,
    height: 25,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
  },
  markText: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  title: {
    flexShrink: 1,
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '800',
    letterSpacing: -0.35,
  },
  spark: { width: 5, height: 5, borderRadius: 3, marginLeft: -2, alignSelf: 'flex-start', marginTop: 7 },
});
