import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  isErr,
  sessionId,
  type AccountId,
  type Answer,
  type QuizQuestion,
  type QuizSessionSnapshot,
} from '@ldr/core';

import { useApp } from '../app-context';
import { messageForError } from '../copy/error-copy';
import { answerLabel, editableQuizQuestions, quizDraftComplete } from '../games/couples-quiz-view';
import type { RootStackParamList } from '../navigation';
import { AppButton } from '../ui/AppButton';
import { AppField } from '../ui/AppField';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayInsetStyle, clayPressedStyle, clayRaisedStyle } from '../ui/clay';

type Props = NativeStackScreenProps<RootStackParamList, 'CouplesQuiz'>;

export function CouplesQuizScreen({ route }: Props) {
  const { runtime, identity, accountDetails, tokens } = useApp();
  const id = sessionId(route.params.sessionId);
  const self = identity.session?.accountId;
  const [snapshot, setSnapshot] = useState<QuizSessionSnapshot | null>(null);
  const [questions, setQuestions] = useState<readonly QuizQuestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const refresh = useCallback(async () => {
    if (submitting.current) return;
    const next = await runtime.quiz.refreshSession(id);
    if (next === null) {
      setError('That quiz could not be found.');
      return;
    }
    setSnapshot(next);
    const catalog = await runtime.quiz.listQuestions(next.session.quizId);
    setQuestions(catalog);
    setError(catalog.length === 0 ? 'The questions for this quiz could not be loaded.' : null);
  }, [id, runtime.quiz]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (snapshot?.session.phase === 'complete') return;
    const handle = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(handle);
  }, [refresh, snapshot?.session.phase]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const question = useMemo(() => {
    if (snapshot === null || self === undefined) return null;
    return editableQuizQuestions(questions, snapshot, self)[questionIndex] ?? null;
  }, [questions, self, snapshot, questionIndex]);
  const editableQuestions =
    snapshot !== null && self !== undefined ? editableQuizQuestions(questions, snapshot, self) : [];
  const progress =
    snapshot !== null && self !== undefined
      ? {
          completed: questions.length - editableQuestions.length + questionIndex,
          total: questions.length,
        }
      : { completed: 0, total: questions.length };
  const partnerId =
    snapshot === null || self === undefined
      ? undefined
      : (Object.keys(snapshot.session.scores) as AccountId[]).find((account) => account !== self);
  const partnerName = accountDetails?.partnerProfile?.displayName ?? 'your partner';
  const isGuessing = snapshot?.session.phase === 'guessing';
  const currentValue = question === null ? '' : (drafts[question.id] ?? '');
  const onLastQuestion = questionIndex === editableQuestions.length - 1;

  useEffect(() => {
    setDrafts({});
    setQuestionIndex(0);
  }, [id, snapshot?.session.phase]);

  function saveDraft(value: string) {
    if (question === null) return;
    setDrafts((current) => ({ ...current, [question.id]: value }));
  }

  async function submitRound() {
    if (snapshot === null || !quizDraftComplete(editableQuestions, drafts)) return;
    setBusy(true);
    submitting.current = true;
    setError(null);
    try {
      let failed = false;
      for (const item of editableQuestions) {
        const value = drafts[item.id];
        if (value === undefined) {
          setError('Please answer every question before submitting.');
          return;
        }
        const answer: Answer =
          item.type === 'multiple_choice'
            ? { kind: 'choice', value }
            : { kind: 'text', value: value.trim() };
        const result = isGuessing
          ? await runtime.quiz.submitGuess(id, item.id, answer)
          : await runtime.quiz.submitSelfAnswer(id, item.id, answer);
        if (isErr(result)) {
          setError(messageForError(result.error));
          setQuestionIndex(0);
          failed = true;
          break;
        }
      }
      // A response can fail after the server accepted it. Re-read before
      // retrying so already committed answers are never sent a second time.
      const next = failed
        ? ((await runtime.quiz.refreshSession(id)) ?? runtime.quiz.cached(id))
        : runtime.quiz.cached(id);
      if (next !== undefined) setSnapshot(next);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          {snapshot === null || self === undefined ? (
            <AppText kind="muted" tokens={tokens}>
              Loading your quiz…
            </AppText>
          ) : snapshot.session.phase === 'complete' ? (
            <>
              <View
                style={[
                  styles.scoreCard,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.primary },
                ]}
              >
                <AppText kind="label" tokens={tokens}>
                  FINAL SCORE
                </AppText>
                <View style={styles.scoreRow}>
                  <View style={styles.scoreSide}>
                    <AppText kind="title" tokens={tokens}>
                      {snapshot.session.scores[self] ?? 0}
                    </AppText>
                    <AppText kind="muted" tokens={tokens}>
                      You
                    </AppText>
                  </View>
                  <AppText kind="title" tokens={tokens}>
                    ♡
                  </AppText>
                  <View style={styles.scoreSide}>
                    <AppText kind="title" tokens={tokens}>
                      {partnerId === undefined ? 0 : (snapshot.session.scores[partnerId] ?? 0)}
                    </AppText>
                    <AppText kind="muted" tokens={tokens}>
                      {partnerName}
                    </AppText>
                  </View>
                </View>
              </View>
              <AppText kind="label" tokens={tokens} style={styles.sectionTitle}>
                YOUR RESULTS
              </AppText>
              {questions.map((item, index) => {
                const result = snapshot.results?.questions.find(
                  (entry) => entry.questionId === item.id,
                );
                const partnerAnswer =
                  partnerId === undefined ? null : (result?.selfAnswers[partnerId] ?? null);
                const ownGuess = result?.guesses[self] ?? null;
                return (
                  <View
                    key={item.id}
                    style={[
                      styles.resultCard,
                      clayRaisedStyle(tokens, true),
                      { backgroundColor: tokens.surfaceMuted },
                    ]}
                  >
                    <AppText kind="label" tokens={tokens}>
                      QUESTION {index + 1}
                    </AppText>
                    <AppText kind="body" tokens={tokens} style={styles.resultPrompt}>
                      {item.prompt}
                    </AppText>
                    <AppText kind="muted" tokens={tokens}>
                      {partnerName}: {answerLabel(partnerAnswer)}
                    </AppText>
                    <AppText kind="muted" tokens={tokens}>
                      Your guess: {answerLabel(ownGuess)}
                    </AppText>
                  </View>
                );
              })}
            </>
          ) : question === null ? (
            <View
              style={[
                styles.waiting,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surfaceMuted },
              ]}
            >
              <AppText kind="title" tokens={tokens}>
                You’re all caught up
              </AppText>
              <AppText kind="muted" tokens={tokens} style={styles.waitingCopy}>
                Waiting for {partnerName} to finish this round. This screen will update
                automatically.
              </AppText>
              <AppButton
                label="Check now"
                variant="quiet"
                tokens={tokens}
                onPress={() => void refresh()}
              />
            </View>
          ) : (
            <>
              <View style={styles.progressRow}>
                <AppText kind="label" tokens={tokens}>
                  {isGuessing ? `GUESS ${partnerName.toUpperCase()}` : 'ANSWER FOR YOURSELF'}
                </AppText>
                <AppText kind="muted" tokens={tokens}>
                  {progress.completed + 1} of {progress.total}
                </AppText>
              </View>
              <View
                style={[
                  styles.questionCard,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.primary },
                ]}
              >
                <AppText kind="title" tokens={tokens} style={styles.questionText}>
                  {question.prompt}
                </AppText>
                {isGuessing ? (
                  <AppText kind="muted" tokens={tokens} style={styles.questionHint}>
                    What do you think {partnerName} answered?
                  </AppText>
                ) : null}
              </View>

              {question.type === 'multiple_choice' ? (
                <View style={styles.choices}>
                  {(question.choices ?? []).map((choice) => {
                    const chosen = currentValue === choice;
                    return (
                      <Pressable
                        key={choice}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: chosen }}
                        onPress={() => saveDraft(choice)}
                        style={({ pressed }) => [
                          styles.choice,
                          chosen
                            ? clayInsetStyle(tokens)
                            : pressed
                              ? clayPressedStyle(tokens)
                              : clayRaisedStyle(tokens, true),
                          { backgroundColor: chosen ? tokens.primary : tokens.surfaceMuted },
                        ]}
                      >
                        <AppText kind="body" tokens={tokens} style={styles.choiceText}>
                          {choice}
                        </AppText>
                        <AppText kind="body" tokens={tokens}>
                          {chosen ? '●' : '○'}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <AppField
                  label={isGuessing ? `${partnerName} answered…` : 'My answer'}
                  tokens={tokens}
                  value={currentValue}
                  onChangeText={saveDraft}
                  maxLength={100}
                  returnKeyType="done"
                />
              )}

              <View style={styles.controls}>
                {questionIndex > 0 ? (
                  <View style={styles.backButton}>
                    <AppButton
                      label="Back"
                      variant="quiet"
                      tokens={tokens}
                      disabled={busy}
                      onPress={() => setQuestionIndex((index) => index - 1)}
                    />
                  </View>
                ) : null}
                <View style={styles.forwardButton}>
                  {onLastQuestion ? (
                    <AppButton
                      label={isGuessing ? 'Submit guesses' : 'Submit answers'}
                      tokens={tokens}
                      disabled={busy || !quizDraftComplete(editableQuestions, drafts)}
                      onPress={() => void submitRound()}
                    />
                  ) : (
                    <AppButton
                      label="Next question"
                      tokens={tokens}
                      disabled={busy || currentValue.trim().length === 0}
                      onPress={() => setQuestionIndex((index) => index + 1)}
                    />
                  )}
                </View>
              </View>
            </>
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
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  questionCard: { borderRadius: 28, padding: 22, marginBottom: 22 },
  questionText: { fontSize: 24, lineHeight: 31 },
  questionHint: { marginTop: 10 },
  choices: { gap: 12, marginBottom: 20 },
  choice: {
    minHeight: 64,
    borderRadius: 20,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  choiceText: { flex: 1, paddingRight: 12 },
  controls: { flexDirection: 'row', gap: 12 },
  backButton: { flex: 1 },
  forwardButton: { flex: 2 },
  waiting: { borderRadius: 28, padding: 22 },
  waitingCopy: { marginTop: 10, marginBottom: 18 },
  scoreCard: { borderRadius: 28, padding: 22, marginBottom: 30, alignItems: 'center' },
  scoreRow: {
    marginTop: 14,
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  scoreSide: { minWidth: 90, alignItems: 'center' },
  sectionTitle: { marginBottom: 12 },
  resultCard: { borderRadius: 22, padding: 17, marginBottom: 14 },
  resultPrompt: { fontWeight: '700', marginTop: 5, marginBottom: 10 },
  error: { marginTop: 18 },
});
