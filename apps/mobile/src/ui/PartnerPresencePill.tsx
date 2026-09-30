import { Platform, StyleSheet, View } from 'react-native';

import { useApp } from '../app-context';
import { AppText } from './AppText';
import { clayRaisedStyle } from './clay';
import {
  ANNIVERSARY_TITLE,
  elapsedDays,
  findImportantDate,
  todayCalendarDate,
} from '../important-dates';

function initial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '•';
}

export function PartnerPresencePill() {
  const { accountDetails, importantDates, partnerPresence, tokens } = useApp();
  const selfName = accountDetails?.selfProfile?.displayName?.trim() || 'You';
  const partnerName = accountDetails?.partnerProfile?.displayName?.trim() || 'Partner';
  const presenceLabel =
    partnerPresence.status === 'online'
      ? 'Online'
      : partnerPresence.status === 'offline'
        ? 'Offline'
        : 'Checking';
  const anniversary = findImportantDate(importantDates, ANNIVERSARY_TITLE);
  const togetherLabel =
    anniversary === undefined
      ? 'Set anniversary'
      : `Together for ${elapsedDays(anniversary.date, todayCalendarDate())} days`;

  return (
    <View
      accessible
      accessibilityLabel={`${selfName} and ${partnerName}. ${presenceLabel}. ${togetherLabel}.`}
      style={[
        styles.pill,
        clayRaisedStyle(tokens, true),
        { backgroundColor: tokens.surface },
      ]}
    >
      <View style={styles.presenceColumn} accessible={false}>
        <View style={styles.avatars}>
          <View style={[styles.avatar, { backgroundColor: tokens.primary }]}>
            <AppText kind="label" tokens={tokens} style={styles.initial}>
              {initial(selfName)}
            </AppText>
          </View>
          <View
            style={[
              styles.avatar,
              styles.partnerAvatar,
              { backgroundColor: tokens.accent, borderColor: tokens.surface },
            ]}
          >
            <AppText kind="label" tokens={tokens} style={styles.initial}>
              {initial(partnerName)}
            </AppText>
          </View>
          <View
            style={[
              styles.presenceDot,
              partnerPresence.status === 'online'
                ? styles.onlineGlow
                : styles.offlineDot,
              {
                backgroundColor:
                  partnerPresence.status === 'online' ? '#45C789' : '#A7B0AC',
                borderColor: tokens.surface,
              },
            ]}
          />
        </View>
        <AppText kind="label" tokens={tokens} style={styles.presenceCaption}>
          {presenceLabel.toUpperCase()}
        </AppText>
      </View>
      <View style={styles.copy}>
        <AppText kind="body" tokens={tokens} numberOfLines={1} style={styles.names}>
          {selfName} + {partnerName}
        </AppText>
        <AppText kind="label" tokens={tokens} numberOfLines={1} style={styles.together}>
          {togetherLabel.toUpperCase()}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 58,
    maxWidth: 330,
    alignSelf: 'center',
    borderRadius: 29,
    paddingVertical: 6,
    paddingLeft: 8,
    paddingRight: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  presenceColumn: { width: 54, alignItems: 'center', justifyContent: 'center' },
  avatars: { width: 52, height: 34, flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  partnerAvatar: { marginLeft: -10, borderWidth: 3 },
  presenceDot: {
    position: 'absolute',
    left: -2,
    top: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  onlineGlow: {
    shadowColor: '#27B677',
    shadowOpacity: 0.75,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  offlineDot: { shadowOpacity: 0, elevation: 0 },
  presenceCaption: { fontSize: 7, lineHeight: 9, marginTop: 1, letterSpacing: 0.4 },
  initial: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontWeight: '800',
  },
  copy: { flex: 1, minWidth: 0, height: 44, justifyContent: 'flex-end' },
  names: { fontWeight: '700' },
  together: { fontSize: 8, lineHeight: 11, letterSpacing: 0.25 },
});
