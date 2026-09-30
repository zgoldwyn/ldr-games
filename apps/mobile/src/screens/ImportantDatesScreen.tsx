import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { CalendarDate } from '@ldr/core';

import { useApp } from '../app-context';
import {
  ANNIVERSARY_TITLE,
  birthdayTitle,
  buildImportantMilestones,
  findImportantDate,
  formatCalendarDate,
  todayCalendarDate,
} from '../important-dates';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { CalendarDateInput } from '../ui/CalendarDateInput';
import { PartnerPresencePill } from '../ui/PartnerPresencePill';
import { MainPageMarker } from '../ui/MainPageMarker';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

export function ImportantDatesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { accountDetails, importantDates, runtime, tokens } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selfName = accountDetails?.selfProfile?.displayName?.trim() || 'You';
  const partnerName = accountDetails?.partnerProfile?.displayName?.trim() || 'Partner';
  const required = [
    {
      title: ANNIVERSARY_TITLE,
      heading: 'When did you become official?',
      copy: 'This powers your day count and all of your shared milestones.',
    },
    {
      title: birthdayTitle(selfName),
      heading: `When is ${selfName}'s birthday?`,
      copy: 'We’ll keep it in your shared timeline each year.',
    },
    {
      title: birthdayTitle(partnerName),
      heading: `When is ${partnerName}'s birthday?`,
      copy: 'One more date, then your milestone timeline is ready.',
    },
  ] as const;
  const missing = required.find(
    (item) => findImportantDate(importantDates, item.title) === undefined,
  );
  const milestones = useMemo(
    () =>
      buildImportantMilestones({
        dates: importantDates,
        selfName,
        partnerName,
      }),
    [importantDates, partnerName, selfName],
  );

  const saveRequiredDate = async (date: CalendarDate) => {
    if (missing === undefined) return;
    setBusy(true);
    setError(null);
    const result = await runtime.calendar.createDate(missing.title, date, true);
    setBusy(false);
    if (!result.ok) setError(result.error.message);
  };

  return (
    <Screen
      tokens={tokens}
      topInset
      bottomInset={false}
      bottomPadding={false}
      horizontalPadding={false}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <PartnerPresencePill />

        {missing !== undefined ? (
          <View
            style={[
              styles.setupCard,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <AppText kind="label" tokens={tokens} style={styles.eyebrow}>
              SET UP IMPORTANT DATES
            </AppText>
            <AppText kind="title" tokens={tokens} style={styles.setupTitle}>
              {missing.heading}
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.setupCopy}>
              {missing.copy}
            </AppText>
            <CalendarDateInput
              key={missing.title}
              initialDate={todayCalendarDate()}
              buttonLabel="Save and continue"
              busy={busy}
              tokens={tokens}
              onSave={(date) => void saveRequiredDate(date)}
            />
            {error !== null ? (
              <AppText kind="error" tokens={tokens} style={styles.serverError}>
                {error}
              </AppText>
            ) : null}
          </View>
        ) : (
          <>
            <View style={styles.timelineHeading}>
              <MainPageMarker
                title="Upcoming milestones"
                actionLabel="Edit dates"
                tokens={tokens}
                onAction={() => navigation.navigate('EditImportantDates')}
              />
            </View>

            <View style={styles.timeline}>
              {milestones.map((milestone, index) => (
                <View key={milestone.key} style={styles.milestoneRow}>
                  <View style={styles.rail}>
                    <View style={[styles.dot, { backgroundColor: tokens.primaryStrong }]} />
                    {index < milestones.length - 1 ? (
                      <View style={[styles.line, { backgroundColor: tokens.primary }]} />
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityRole="text"
                    style={({ pressed }) => [
                      styles.milestone,
                      pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                      { backgroundColor: tokens.surface },
                    ]}
                  >
                    <View style={styles.milestoneCopy}>
                      <AppText kind="body" tokens={tokens} style={styles.milestoneLabel}>
                        {milestone.label}
                      </AppText>
                      <AppText kind="muted" tokens={tokens}>
                        {formatCalendarDate(milestone.date)}
                      </AppText>
                    </View>
                    <AppText kind="label" tokens={tokens} style={styles.countdown}>
                      {milestone.daysAway === 0 ? 'TODAY' : `${milestone.daysAway}D`}
                    </AppText>
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 28 },
  setupCard: { borderRadius: 28, padding: 22, marginTop: 22 },
  eyebrow: { fontSize: 10, letterSpacing: 1.1, marginBottom: 8 },
  setupTitle: { fontSize: 25, lineHeight: 31 },
  setupCopy: { marginTop: 7, marginBottom: 22 },
  serverError: { marginTop: 14 },
  timelineHeading: {
    marginTop: 24,
    marginBottom: 18,
  },
  timeline: { gap: 0 },
  milestoneRow: { flexDirection: 'row', minHeight: 92 },
  rail: { width: 26, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 24, zIndex: 1 },
  line: { width: 3, flex: 1, marginTop: -1, opacity: 0.45 },
  milestone: {
    flex: 1,
    minHeight: 72,
    marginBottom: 20,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  milestoneCopy: { flex: 1 },
  milestoneLabel: { fontWeight: '700' },
  countdown: { fontWeight: '800' },
});
