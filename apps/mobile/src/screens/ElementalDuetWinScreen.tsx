import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ELEMENTAL_PLATFORMER_TICKS_PER_SECOND } from '@ldr/core';

import { useApp } from '../app-context';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayInsetStyle, clayRaisedStyle } from '../ui/clay';
import { ClayElementalSpritePreview } from '../ui/ClayElementalSprite';

function formatClearTime(ticks: number): string {
  const tenths = Math.floor((ticks * 10) / ELEMENTAL_PLATFORMER_TICKS_PER_SECOND);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

export function ElementalDuetWinScreen() {
  const { tokens } = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { clearTicks, levelCount } =
    useRoute<RouteProp<RootStackParamList, 'ElementalDuetWin'>>().params;

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View
            style={[styles.artwork, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}
          >
            <View style={[styles.halo, { backgroundColor: tokens.surfaceMuted }]} />
            <AppText kind="title" tokens={tokens} style={[styles.sparkle, styles.sparkleLeft]}>
              ✦
            </AppText>
            <AppText kind="title" tokens={tokens} style={[styles.sparkle, styles.sparkleRight]}>
              ✧
            </AppText>
            <View style={styles.spirits}>
              <ClayElementalSpritePreview role="ember" tokens={tokens} size={94} />
              <ClayElementalSpritePreview role="tide" tokens={tokens} size={94} />
            </View>
            <View style={[styles.ground, { backgroundColor: tokens.primary }]} />
          </View>

          <AppText kind="label" tokens={tokens} style={styles.eyebrow}>
            EMBER & TIDE · JOURNEY COMPLETE
          </AppText>
          <AppText kind="title" tokens={tokens} style={styles.title} accessibilityRole="header">
            You won!
          </AppText>
          <AppText kind="body" tokens={tokens} style={styles.message}>
            Ember and Tide made it home together.
          </AppText>

          <View
            style={[
              styles.result,
              clayInsetStyle(tokens),
              { backgroundColor: tokens.surfaceMuted },
            ]}
          >
            <View style={styles.resultItem}>
              <AppText kind="label" tokens={tokens} style={styles.resultLabel}>
                LEVELS CLEARED
              </AppText>
              <AppText kind="title" tokens={tokens} style={styles.resultValue}>
                {levelCount}
              </AppText>
            </View>
            <View style={[styles.divider, { backgroundColor: tokens.border }]} />
            <View style={styles.resultItem}>
              <AppText kind="label" tokens={tokens} style={styles.resultLabel}>
                FINAL CLEAR
              </AppText>
              <AppText kind="title" tokens={tokens} style={styles.resultValue}>
                {formatClearTime(clearTicks)}
              </AppText>
            </View>
          </View>

          <View style={styles.button}>
            <AppButton
              label="Back to Play"
              tokens={tokens}
              onPress={() => navigation.navigate('MainTabs', { screen: 'Play' })}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 22 },
  content: { alignItems: 'center', width: '100%', maxWidth: 440, alignSelf: 'center' },
  artwork: {
    width: '100%',
    height: 210,
    borderRadius: 32,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: 245,
    height: 245,
    borderRadius: 123,
    top: -75,
  },
  spirits: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 38 },
  ground: { position: 'absolute', bottom: 25, width: 220, height: 8, borderRadius: 4 },
  sparkle: { position: 'absolute', fontSize: 30, opacity: 0.7 },
  sparkleLeft: { left: 36, top: 36 },
  sparkleRight: { right: 42, top: 28 },
  eyebrow: { marginTop: 30, textAlign: 'center', letterSpacing: 1.4 },
  title: { fontSize: 48, lineHeight: 58, marginTop: 8, textAlign: 'center' },
  message: { marginTop: 6, textAlign: 'center' },
  result: {
    width: '100%',
    flexDirection: 'row',
    borderRadius: 22,
    paddingVertical: 20,
    marginTop: 30,
  },
  resultItem: { flex: 1, alignItems: 'center' },
  resultLabel: { fontSize: 11, letterSpacing: 0.7 },
  resultValue: { fontSize: 24, lineHeight: 31, marginTop: 5 },
  divider: { width: 1, alignSelf: 'stretch' },
  button: { width: '100%', marginTop: 28 },
});
