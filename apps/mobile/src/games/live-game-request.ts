import {
  DRAW_TOGETHER_GAME_ID,
  SPEED_GAME_ID,
  TIC_TAC_TOE,
  WORD_CHAIN_GAME_ID,
  type Notification,
  type RTSession,
} from '@ldr/core';

export type LiveGameRoute = 'TicTacToe' | 'DrawTogether' | 'Speed' | 'WordChain';

export interface PendingLiveRequest {
  readonly notification: Notification;
  readonly session: RTSession;
  readonly route: LiveGameRoute;
  readonly name: string;
}

function gameDestination(
  gameId: string,
): { readonly route: LiveGameRoute; readonly name: string } | null {
  switch (gameId) {
    case TIC_TAC_TOE:
      return { route: 'TicTacToe', name: 'Tic-tac-toe' };
    case DRAW_TOGETHER_GAME_ID:
      return { route: 'DrawTogether', name: 'Draw Together' };
    case SPEED_GAME_ID:
      return { route: 'Speed', name: 'Speed' };
    case WORD_CHAIN_GAME_ID:
      return { route: 'WordChain', name: 'Word Chain' };
    default:
      return null;
  }
}

/** An unacknowledged invitation takes over the screen only while it can be joined. */
export function pendingLiveRequest(
  notifications: readonly Notification[],
  sessions: readonly RTSession[],
): PendingLiveRequest | null {
  for (const notification of notifications) {
    if (notification.category !== 'game_invite' || notification.acknowledgedAt !== null) continue;
    const payload = notification.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const invite = payload as { readonly type?: unknown; readonly sessionId?: unknown };
    if (invite.type !== 'rt_game_invite' || typeof invite.sessionId !== 'string') continue;
    const session = sessions.find(
      (item) => item.id === invite.sessionId && item.state === 'pending',
    );
    if (session === undefined) continue;
    const destination = gameDestination(session.gameId);
    if (destination === null) continue;
    return { notification, session, ...destination };
  }
  return null;
}
