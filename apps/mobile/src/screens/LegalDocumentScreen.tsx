import { Fragment } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useApp } from '../app-context';
import { LEGAL_DOCUMENTS } from '../legal/legal-content';
import type { RootStackParamList } from '../navigation';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';

export function LegalDocumentScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, 'LegalDocument'>) {
  const { tokens } = useApp();
  const document = LEGAL_DOCUMENTS[route.params.document];

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="muted" tokens={tokens} style={styles.effective}>
          Effective {document.effectiveDate}
        </AppText>
        {document.sections.map((section) => (
          <Fragment key={section.heading}>
            <AppText kind="body" tokens={tokens} style={styles.heading} accessibilityRole="header">
              {section.heading}
            </AppText>
            {section.paragraphs.map((paragraph) => (
              <AppText kind="body" tokens={tokens} style={styles.paragraph} key={paragraph}>
                {paragraph}
              </AppText>
            ))}
          </Fragment>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40 },
  effective: { marginBottom: 24 },
  heading: { fontWeight: '700', marginTop: 20, marginBottom: 8 },
  paragraph: { marginBottom: 12 },
});
