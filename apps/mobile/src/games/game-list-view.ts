import { TIC_TAC_TOE, type Notification } from '@ldr/core';

export type GameListNotificationAction =
  | { readonly kind: 'rt'; readonly sessionId: string; readonly gameId: string }
  | { readonly kind: 'async'; readonly sessionId: string }
  | {
      readonly kind: 'quiz';
      readonly sessionId: string;
      readonly phase: 'self_answer' | 'guessing' | 'complete';
    };

export function gameListNotificationAction(
  notification: Notification,
): GameListNotificationAction | null {
  if (notification.payload === null || typeof notification.payload !== 'object') return null;
  const payload = notification.payload as {
    readonly type?: unknown;
    readonly kind?: unknown;
    readonly sessionId?: unknown;
    readonly gameId?: unknown;
  };
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return null;

  if (notification.category === 'quiz') {
    if (payload.kind === 'quiz_started') {
      return { kind: 'quiz', sessionId: payload.sessionId, phase: 'self_answer' };
    }
    if (payload.kind === 'quiz_guessing_ready') {
      return { kind: 'quiz', sessionId: payload.sessionId, phase: 'guessing' };
    }
    if (payload.kind === 'quiz_results_ready') {
      return { kind: 'quiz', sessionId: payload.sessionId, phase: 'complete' };
    }
    return null;
  }

  if (notification.category !== 'game_invite') return null;
  if (payload.type === 'rt_game_invite') {
    return {
      kind: 'rt',
      sessionId: payload.sessionId,
      gameId: typeof payload.gameId === 'string' ? payload.gameId : TIC_TAC_TOE,
    };
  }
  if (payload.kind === 'async_game_invite') {
    return { kind: 'async', sessionId: payload.sessionId };
  }
  return null;
}

/** Only the update for a session's current phase belongs on the Play screen. */
export function isCurrentQuizUpdate(
  action: GameListNotificationAction,
  currentPhase: 'self_answer' | 'guessing' | 'complete' | null | undefined,
): boolean {
  return action.kind !== 'quiz' || action.phase === currentPhase;
}

export function unfinishedGames<T extends { readonly state: string }>(
  sessions: readonly T[],
): readonly T[] {
  return sessions.filter((session) => session.state !== 'terminal');
}

/**
 * A partner's pending game is already represented by its invitation card.
 * Withhold that same session from "Your games" until the invite is handled so
 * one durable session never looks like two different games.
 */
export function withoutIncomingInvites<T extends { readonly id: string }>(
  sessions: readonly T[],
  invitedSessionIds: ReadonlySet<string>,
): readonly T[] {
  return sessions.filter((session) => !invitedSessionIds.has(session.id));
}

export function sessionStateLabel(state: string): string {
  switch (state) {
    case 'pending':
      return 'Waiting for partner';
    case 'active':
      return 'In progress';
    case 'paused':
      return 'Paused';
    default:
      return 'Game';
  }
}
