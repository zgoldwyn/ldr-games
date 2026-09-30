import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { CalendarDate } from '@ldr/core';

import { useApp } from '../app-context';
import {
  ANNIVERSARY_TITLE,
  FIRST_DATE_TITLE,
  birthdayTitle,
  findImportantDate,
  formatCalendarDate,
  todayCalendarDate,
} from '../important-dates';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { CalendarDateInput } from '../ui/CalendarDateInput';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

export function EditImportantDatesScreen() {
  const { accountDetails, importantDates, runtime, tokens } = useApp();
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const selfName = accountDetails?.selfProfile?.displayName?.trim() || 'You';
  const partnerName = accountDetails?.partnerProfile?.displayName?.trim() || 'Partner';
  const options = [
    { title: ANNIVERSARY_TITLE, label: 'Anniversary', icon: '♥' },
    { title: FIRST_DATE_TITLE, label: 'First date', icon: '✦' },
    { title: birthdayTitle(selfName), label: `${selfName}'s birthday`, icon: '♟' },
    { title: birthdayTitle(partnerName), label: `${partnerName}'s birthday`, icon: '♟' },
  ] as const;
  const selected =
    selectedTitle === null ? undefined : options.find((option) => option.title === selectedTitle);
  const existing =
    selectedTitle === null ? undefined : findImportantDate(importantDates, selectedTitle);

  const save = async (date: CalendarDate) => {
    if (selected === undefined) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const result =
      existing === undefined
        ? await runtime.calendar.createDate(selected.title, date, true)
        : await runtime.calendar.editDate(existing.id, selected.title, date, true);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSaved(`${selected.label} updated.`);
    setSelectedTitle(null);
  };

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {selected === undefined ? (
          <>
            <AppText kind="title" tokens={tokens}>
              What do you want to edit?
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.lead}>
              Changes are shared with your partner right away.
            </AppText>
            {saved !== null ? (
              <AppText kind="label" tokens={tokens} style={styles.saved}>
                {saved}
              </AppText>
            ) : null}
            <View style={styles.options}>
              {options.map((option) => {
                const value = findImportantDate(importantDates, option.title);
                return (
                  <Pressable
                    key={option.title}
                    accessibilityRole="button"
                    onPress={() => {
                      setError(null);
                      setSelectedTitle(option.title);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                      { backgroundColor: tokens.surface },
                    ]}
                  >
                    <View style={[styles.icon, { backgroundColor: tokens.primary }]}>
                      <AppText kind="body" tokens={tokens} style={styles.iconText}>
                        {option.icon}
                      </AppText>
                    </View>
                    <View style={styles.optionCopy}>
                      <AppText kind="body" tokens={tokens} style={styles.optionTitle}>
                        {option.label}
                      </AppText>
                      <AppText kind="muted" tokens={tokens}>
                        {value === undefined ? 'Not set' : formatCalendarDate(value.date)}
                      </AppText>
                    </View>
                    <AppText kind="body" tokens={tokens}>
                      ›
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : (
          <View
            style={[styles.editor, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}
          >
            <AppText kind="label" tokens={tokens} style={styles.editorEyebrow}>
              EDIT DATE
            </AppText>
            <AppText kind="title" tokens={tokens} style={styles.editorTitle}>
              {selected.label}
            </AppText>
            <CalendarDateInput
              key={selected.title}
              initialDate={existing?.date ?? todayCalendarDate()}
              buttonLabel={existing === undefined ? 'Add date' : 'Save changes'}
              busy={busy}
              tokens={tokens}
              onSave={(date) => void save(date)}
            />
            {error !== null ? (
              <AppText kind="error" tokens={tokens} style={styles.error}>
                {error}
              </AppText>
            ) : null}
            <AppButton
              label="Choose a different date"
              variant="quiet"
              tokens={tokens}
              disabled={busy}
              style={styles.backButton}
              onPress={() => setSelectedTitle(null)}
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 30 },
  lead: { marginTop: 8 },
  saved: { marginTop: 16 },
  options: { gap: 16, marginTop: 24 },
  option: {
    minHeight: 76,
    borderRadius: 22,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  icon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 22, fontWeight: '800' },
  optionCopy: { flex: 1 },
  optionTitle: { fontWeight: '700' },
  editor: { borderRadius: 28, padding: 22, marginTop: 8 },
  editorEyebrow: { fontSize: 10, letterSpacing: 1.1, marginBottom: 6 },
  editorTitle: { fontSize: 25, lineHeight: 31, marginBottom: 22 },
  error: { marginTop: 14 },
  backButton: { marginTop: 14 },
});
