import { useEffect, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { isValidCalendarDate, type CalendarDate, type ThemeTokens } from '@ldr/core';

import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { clayInsetStyle } from './clay';

function stringsFor(date: CalendarDate) {
  return {
    month: String(date.month),
    day: String(date.day),
    year: String(date.year),
  };
}

export function CalendarDateInput({
  initialDate,
  buttonLabel,
  busy,
  tokens,
  onSave,
}: {
  readonly initialDate: CalendarDate;
  readonly buttonLabel: string;
  readonly busy: boolean;
  readonly tokens: ThemeTokens;
  readonly onSave: (date: CalendarDate) => void;
}) {
  const [values, setValues] = useState(() => stringsFor(initialDate));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(stringsFor(initialDate));
    setError(null);
  }, [initialDate]);

  const submit = () => {
    const date: CalendarDate = {
      month: Number(values.month),
      day: Number(values.day),
      year: Number(values.year),
    };
    if (!isValidCalendarDate(date)) {
      setError('Enter a valid month, day, and four-digit year.');
      return;
    }
    setError(null);
    onSave(date);
  };

  return (
    <View>
      <View style={styles.labels}>
        <AppText kind="label" tokens={tokens} style={styles.shortLabel}>
          Month
        </AppText>
        <AppText kind="label" tokens={tokens} style={styles.shortLabel}>
          Day
        </AppText>
        <AppText kind="label" tokens={tokens} style={styles.yearLabel}>
          Year
        </AppText>
      </View>
      <View style={styles.fields}>
        {(['month', 'day', 'year'] as const).map((field) => (
          <TextInput
            key={field}
            accessibilityLabel={field}
            value={values[field]}
            editable={!busy}
            keyboardType="number-pad"
            maxLength={field === 'year' ? 4 : 2}
            selectTextOnFocus
            onChangeText={(value) => setValues((current) => ({ ...current, [field]: value }))}
            style={[
              styles.field,
              field === 'year' && styles.yearField,
              clayInsetStyle(tokens),
              { backgroundColor: tokens.surfaceMuted, color: tokens.textPrimary },
            ]}
          />
        ))}
      </View>
      {error !== null ? (
        <AppText kind="error" tokens={tokens} style={styles.error}>
          {error}
        </AppText>
      ) : null}
      <AppButton
        label={busy ? 'Saving…' : buttonLabel}
        tokens={tokens}
        disabled={busy}
        onPress={submit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  labels: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  fields: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  shortLabel: { flex: 1 },
  yearLabel: { flex: 1.45 },
  field: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    paddingHorizontal: 12,
    textAlign: 'center',
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 17,
    fontWeight: '700',
  },
  yearField: { flex: 1.45 },
  error: { marginTop: -6, marginBottom: 12 },
});
