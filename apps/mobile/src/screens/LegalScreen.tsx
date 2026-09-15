import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useApp } from '../app-context';
import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENTS } from '../legal/legal-content';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

export function LegalScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tokens } = useApp();

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          Read how LDR Companion handles data, accounts, and purchases.
        </AppText>

        {LEGAL_DOCUMENT_ORDER.map((id) => {
          const document = LEGAL_DOCUMENTS[id];
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${document.title}`}
              onPress={() => navigation.navigate('LegalDocument', { document: id })}
              style={({ pressed }) => [
                styles.row,
                pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
                {
                  backgroundColor: pressed ? tokens.primary : tokens.surfaceMuted,
                },
              ]}
            >
              <View style={styles.copy}>
                <AppText kind="body" tokens={tokens} style={styles.rowTitle}>
                  {document.title}
                </AppText>
                <AppText kind="muted" tokens={tokens}>
                  {document.summary}
                </AppText>
              </View>
              <AppText kind="body" tokens={tokens} accessibilityElementsHidden>
                ›
              </AppText>
            </Pressable>
          );
        })}

        <AppText kind="muted" tokens={tokens} style={styles.notice}>
          These are pre-release drafts. Operator and territory-specific details must be completed
          before public release.
        </AppText>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 32 },
  lead: { marginBottom: 24 },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
  },
  copy: { flex: 1, marginRight: 12 },
  rowTitle: { fontWeight: '600', marginBottom: 4 },
  notice: { marginTop: 12 },
});
