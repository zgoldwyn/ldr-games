import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isErr, type QuizDef, type QuizId, type QuizSession } from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayPressedStyle, clayRaisedStyle } from '../ui/clay';

type Props = NativeStackScreenProps<RootStackParamList, 'QuizLibrary'>;

export function QuizLibraryScreen({ navigation }: Props) {
  const { runtime, tokens } = useApp();
  const [quizzes, setQuizzes] = useState<readonly QuizDef[]>([]);
  const [active, setActive] = useState<QuizSession | null>(null);
  const [playedQuizIds, setPlayedQuizIds] = useState<ReadonlySet<QuizId>>(new Set());
  const [busyQuiz, setBusyQuiz] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [catalog, current, played] = await Promise.all([
      runtime.quiz.listQuizzes(),
      runtime.quiz.activeSession(),
      runtime.quiz.playedQuizIds(),
    ]);
    setQuizzes(catalog);
    setActive(current);
    setPlayedQuizIds(new Set(played));
    setError(catalog.length === 0 ? 'No quizzes are available yet.' : null);
    setLoading(false);
  }, [runtime.quiz]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function start(quiz: QuizDef) {
    setBusyQuiz(quiz.id);
    setError(null);
    try {
      const result = await runtime.quiz.startSession(quiz.id);
      if (isErr(result)) {
        const current = await runtime.quiz.activeSession();
        if (current !== null) {
          navigation.navigate('CouplesQuiz', { sessionId: current.id });
          return;
        }
        setError(messageForError(result.error));
        return;
      }
      navigation.navigate('CouplesQuiz', { sessionId: result.value.id });
    } finally {
      setBusyQuiz(null);
    }
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <AppText kind="title" tokens={tokens}>
          How well do you know each other?
        </AppText>
        <AppText kind="muted" tokens={tokens} style={styles.lead}>
          Answer privately, then predict your partner’s answers. You each earn a point for every
          match.
        </AppText>

        {active !== null ? (
          <View
            style={[styles.resume, clayRaisedStyle(tokens), { backgroundColor: tokens.primary }]}
          >
            <AppText kind="label" tokens={tokens}>
              QUIZ IN PROGRESS
            </AppText>
            <AppText kind="body" tokens={tokens} style={styles.resumeTitle}>
              {quizzes.find((quiz) => quiz.id === active.quizId)?.theme ?? 'Couples Quiz'}
            </AppText>
            <AppText kind="muted" tokens={tokens} style={styles.resumeCopy}>
              {active.phase === 'self_answer'
                ? 'Private answers'
                : 'Time to guess your partner’s answers'}
            </AppText>
            <AppButton
              label="Continue quiz"
              tokens={tokens}
              onPress={() => navigation.navigate('CouplesQuiz', { sessionId: active.id })}
            />
          </View>
        ) : null}

        <AppText kind="label" tokens={tokens} style={styles.sectionTitle}>
          PICK A THEME
        </AppText>
        {loading ? (
          <AppText kind="muted" tokens={tokens}>
            Loading quizzes…
          </AppText>
        ) : (
          quizzes.map((quiz, index) => {
            const played = playedQuizIds.has(quiz.id);
            return (
              <Pressable
                key={quiz.id}
                accessibilityRole="button"
                accessibilityLabel={`${quiz.theme}, ${quiz.questionIds.length} questions${played ? ', played' : ''}`}
                accessibilityHint={
                  active === null ? 'Starts this quiz' : 'Finish your active quiz first'
                }
                disabled={active !== null || busyQuiz !== null}
                onPress={() => void start(quiz)}
                style={({ pressed }) => [
                  styles.quizCard,
                  pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens, true),
                  {
                    backgroundColor: index % 2 === 0 ? tokens.surfaceMuted : tokens.surface,
                    opacity: active !== null ? 0.55 : 1,
                  },
                ]}
              >
                <View style={styles.quizCopy}>
                  <View style={styles.quizTitleRow}>
                    <AppText kind="body" tokens={tokens} style={styles.quizTitle}>
                      {quiz.theme}
                    </AppText>
                    {played ? (
                      <View
                        style={[styles.playedBadge, { backgroundColor: tokens.primary }]}
                        accessibilityElementsHidden
                      >
                        <AppText
                          kind="label"
                          tokens={tokens}
                          style={[styles.playedCheck, { color: tokens.onPrimary }]}
                        >
                          ✓
                        </AppText>
                      </View>
                    ) : null}
                  </View>
                  <AppText kind="muted" tokens={tokens}>
                    {quiz.questionIds.length} questions
                  </AppText>
                </View>
                <AppText kind="title" tokens={tokens} accessibilityElementsHidden>
                  {index === 0 ? '♡' : index === 1 ? '✦' : '⌁'}
                </AppText>
              </Pressable>
            );
          })
        )}

        {error !== null ? (
          <AppText
            kind="error"
            tokens={tokens}
            accessibilityLiveRegion="assertive"
            style={styles.error}
          >
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40 },
  lead: { marginTop: 10, marginBottom: 24 },
  resume: { borderRadius: 28, padding: 20, marginBottom: 30 },
  resumeTitle: { marginTop: 6, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  resumeCopy: { marginTop: 4, marginBottom: 16 },
  sectionTitle: { marginBottom: 12 },
  quizCard: {
    minHeight: 92,
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quizCopy: { flex: 1, paddingRight: 12 },
  quizTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  quizTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  playedBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playedCheck: { fontSize: 12, lineHeight: 14, fontWeight: '800' },
  error: { marginTop: 8 },
});
