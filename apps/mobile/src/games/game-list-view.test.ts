import { describe, expect, it } from 'vitest';
import { accountId, notificationId } from '@ldr/core';

import {
  gameListNotificationAction,
  isCurrentQuizUpdate,
  sessionStateLabel,
  unfinishedGames,
  withoutIncomingInvites,
} from './game-list-view';

describe('game list presentation', () => {
  it('keeps playable sessions and removes completed ones from Play', () => {
    const sessions = [
      { id: 'waiting', state: 'pending' },
      { id: 'playing', state: 'active' },
      { id: 'paused', state: 'paused' },
      { id: 'done', state: 'terminal' },
    ];
    expect(unfinishedGames(sessions).map((session) => session.id)).toEqual([
      'waiting',
      'playing',
      'paused',
    ]);
  });

  it('turns machine states into user-facing labels', () => {
    expect(sessionStateLabel('pending')).toBe('Waiting for partner');
    expect(sessionStateLabel('active')).toBe('In progress');
    expect(sessionStateLabel('paused')).toBe('Paused');
    expect(sessionStateLabel('terminal')).not.toBe('terminal');
  });

  it('does not show an invited session again under Your games', () => {
    const sessions = [
      { id: 'incoming', state: 'pending' },
      { id: 'mine', state: 'active' },
    ];

    expect(
      withoutIncomingInvites(unfinishedGames(sessions), new Set(['incoming'])).map(
        (session) => session.id,
      ),
    ).toEqual(['mine']);
  });
});

describe('game list notifications', () => {
  const notification = (kind: string) => ({
    id: notificationId('11111111-1111-4111-8111-111111111111'),
    recipientAccountId: accountId('22222222-2222-4222-8222-222222222222'),
    category: 'quiz' as const,
    payload: { kind, sessionId: '33333333-3333-4333-8333-333333333333' },
    createdAt: 1,
    dedupeKey: kind,
    acknowledgedAt: null,
    deliveredAt: null,
  });

  it('routes quiz phase and result notifications back into the session', () => {
    expect(gameListNotificationAction(notification('quiz_started'))).toMatchObject({
      kind: 'quiz',
      phase: 'self_answer',
    });
    expect(gameListNotificationAction(notification('quiz_guessing_ready'))).toMatchObject({
      kind: 'quiz',
      phase: 'guessing',
    });
    expect(gameListNotificationAction(notification('quiz_results_ready'))).toMatchObject({
      kind: 'quiz',
      phase: 'complete',
    });
    expect(gameListNotificationAction(notification('unknown'))).toBeNull();
  });

  it('drops old quiz phase updates after the session advances', () => {
    const started = gameListNotificationAction(notification('quiz_started'))!;
    const guessing = gameListNotificationAction(notification('quiz_guessing_ready'))!;
    expect(isCurrentQuizUpdate(started, 'self_answer')).toBe(true);
    expect(isCurrentQuizUpdate(started, 'guessing')).toBe(false);
    expect(isCurrentQuizUpdate(guessing, 'guessing')).toBe(true);
    expect(isCurrentQuizUpdate(guessing, 'complete')).toBe(false);
    expect(isCurrentQuizUpdate(guessing, null)).toBe(false);
  });
});
