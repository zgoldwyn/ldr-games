import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useApp } from '../app-context';
import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENTS } from '../legal/legal-content';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

export function LegalScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tokens } = useApp();

  return (
    <Screen tokens={tokens}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="title" tokens={tokens} accessibilityRole="header">
          Legal & privacy
        </AppText>
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
                {
                  backgroundColor: pressed ? tokens.surfaceMuted : tokens.surface,
                  borderColor: tokens.border,
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
  scroll: { paddingBottom: 32 },
  lead: { marginTop: 8, marginBottom: 24 },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  copy: { flex: 1, marginRight: 12 },
  rowTitle: { fontWeight: '600', marginBottom: 4 },
  notice: { marginTop: 12 },
});
