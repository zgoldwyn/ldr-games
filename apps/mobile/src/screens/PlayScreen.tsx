import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useApp } from '../app-context';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';
import { PartnerPresencePill } from '../ui/PartnerPresencePill';

type Destination = 'ElementalDuetSetup' | 'CardGames' | 'WordGames' | 'MiniGames';

const choices: readonly {
  readonly route: Destination;
  readonly icon: string;
  readonly label: string;
  readonly description: string;
  readonly badge?: string;
}[] = [
  {
    route: 'ElementalDuetSetup',
    icon: '≈',
    label: 'Ember & Tide',
    description: 'Explore elemental worlds together.',
    badge: 'CO-OP',
  },
  {
    route: 'CardGames',
    icon: '♥',
    label: 'Card games',
    description: 'Open a live table for two.',
  },
  {
    route: 'WordGames',
    icon: 'Aa',
    label: 'Word games',
    description: 'Fast wordplay against your partner.',
  },
  {
    route: 'MiniGames',
    icon: '◈',
    label: 'Other minigames',
    description: 'Quizzes, drawing, strategy, and more.',
  },
];

export function PlayScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tokens } = useApp();

  return (
    <Screen
      tokens={tokens}
      topInset
      topPadding={false}
      bottomInset={false}
      bottomPadding={false}
      horizontalPadding={false}
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <PartnerPresencePill />
        <View style={styles.choices}>
          {choices.map((choice) => (
            <Pressable
              key={choice.route}
              accessibilityRole="button"
              accessibilityLabel={choice.label}
              accessibilityHint={choice.description}
              onPress={() => navigation.navigate(choice.route)}
              style={({ pressed }) => [
                styles.choice,
                pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
                {
                  backgroundColor: tokens.primary,
                  opacity: pressed ? 0.86 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                },
              ]}
            >
              <View style={[styles.icon, { backgroundColor: tokens.surface }]}>
                <AppText kind="title" tokens={tokens} style={styles.iconText}>
                  {choice.icon}
                </AppText>
              </View>
              <View style={styles.copy}>
                <View style={styles.titleRow}>
                  <AppText kind="title" tokens={tokens} style={styles.title}>
                    {choice.label}
                  </AppText>
                  {choice.badge ? (
                    <View style={[styles.badge, { backgroundColor: tokens.surface }]}>
                      <AppText kind="label" tokens={tokens}>
                        {choice.badge}
                      </AppText>
                    </View>
                  ) : null}
                </View>
                <AppText kind="muted" tokens={tokens}>
                  {choice.description}
                </AppText>
              </View>
              <AppText kind="title" tokens={tokens} style={styles.chevron}>
                ›
              </AppText>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 8 },
  choices: { flex: 1, gap: 20, marginTop: 14 },
  choice: {
    width: '100%',
    flex: 1,
    minHeight: 132,
    borderRadius: 28,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  icon: {
    width: 64,
    height: 76,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
  },
  iconText: { fontSize: 32 },
  copy: { flex: 1, gap: 5 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  title: { fontSize: 23, lineHeight: 28 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  chevron: { fontSize: 34, lineHeight: 38 },
});
