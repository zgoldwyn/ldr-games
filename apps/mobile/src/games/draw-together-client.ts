import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { DrawTogetherState, DrawTogetherWordChoice, RTSession, SessionId } from '@ldr/core';

import type { DrawStrokeBatch } from './draw-together-canvas';

export interface DrawTogetherResponse {
  readonly session: RTSession;
  readonly choices: readonly DrawTogetherWordChoice[];
  readonly word: string | null;
  readonly correct: boolean | null;
  readonly bestScore: number | null;
}

export type DrawTogetherResult =
  | { readonly ok: true; readonly value: DrawTogetherResponse }
  | { readonly ok: false; readonly message: string };

export interface DrawTogetherLiveChannel {
  readonly sendStroke: (batch: DrawStrokeBatch) => Promise<void>;
  readonly sendUndo: (strokeId: string) => Promise<void>;
  readonly sendClear: () => Promise<void>;
  readonly unsubscribe: () => void;
}

function asResponse(value: unknown): DrawTogetherResponse | null {
  if (value === null || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  const session = payload.session;
  if (session === null || typeof session !== 'object') return null;
  const raw = session as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.pairingId !== 'string' ||
    raw.gameId !== 'draw-together' ||
    typeof raw.state !== 'string' ||
    raw.gameState === null ||
    typeof raw.gameState !== 'object'
  ) {
    return null;
  }
  return {
    session: session as RTSession,
    choices: Array.isArray(payload.choices)
      ? (payload.choices as readonly DrawTogetherWordChoice[])
      : [],
    word: typeof payload.word === 'string' ? payload.word : null,
    correct: typeof payload.correct === 'boolean' ? payload.correct : null,
    bestScore: typeof payload.bestScore === 'number' ? payload.bestScore : null,
  };
}

export function drawTogetherState(session: RTSession | undefined): DrawTogetherState | null {
  if (session?.gameId !== 'draw-together') return null;
  const state = session.gameState as Partial<DrawTogetherState>;
  return state.game === 'draw-together' ? (state as DrawTogetherState) : null;
}

export function createDrawTogetherClient(client: SupabaseClient) {
  async function invoke(
    sessionId: SessionId,
    action: 'state' | 'start' | 'choose' | 'guess' | 'timeout',
    extra: Record<string, unknown> = {},
  ): Promise<DrawTogetherResult> {
    const { data, error } = await client.functions.invoke('draw-together', {
      body: { sessionId, action, ...extra },
    });
    if (error) {
      const context = error.context as Response | undefined;
      try {
        const envelope = (await context?.clone().json()) as { readonly message?: unknown };
        if (typeof envelope?.message === 'string') {
          return { ok: false, message: envelope.message };
        }
      } catch {
        // Fall through to a stable transport message.
      }
      return { ok: false, message: 'The Draw Together server could not be reached.' };
    }
    const parsed = asResponse(data);
    return parsed === null
      ? { ok: false, message: 'The Draw Together server returned an invalid response.' }
      : { ok: true, value: parsed };
  }

  function subscribeLive(
    sessionId: SessionId,
    handlers: {
      readonly onStroke: (batch: DrawStrokeBatch) => void;
      readonly onUndo: (strokeId: string) => void;
      readonly onClear: () => void;
    },
  ): DrawTogetherLiveChannel {
    const channel: RealtimeChannel = client.channel(`draw_session:${sessionId}`);
    channel.on('broadcast', { event: 'stroke' }, ({ payload }) => {
      handlers.onStroke(payload as DrawStrokeBatch);
    });
    channel.on('broadcast', { event: 'clear' }, () => handlers.onClear());
    channel.on('broadcast', { event: 'undo' }, ({ payload }) => {
      if (typeof payload.strokeId === 'string') handlers.onUndo(payload.strokeId);
    });
    channel.subscribe();

    return {
      async sendStroke(batch): Promise<void> {
        await channel.send({ type: 'broadcast', event: 'stroke', payload: batch });
      },
      async sendClear(): Promise<void> {
        await channel.send({ type: 'broadcast', event: 'clear', payload: {} });
      },
      async sendUndo(strokeId): Promise<void> {
        await channel.send({ type: 'broadcast', event: 'undo', payload: { strokeId } });
      },
      unsubscribe(): void {
        void client.removeChannel(channel);
      },
    };
  }

  return {
    state: (sessionId: SessionId) => invoke(sessionId, 'state'),
    start: (sessionId: SessionId, durationSeconds: number) =>
      invoke(sessionId, 'start', { durationSeconds }),
    choose: (sessionId: SessionId, choiceId: string) => invoke(sessionId, 'choose', { choiceId }),
    guess: (sessionId: SessionId, guess: string) => invoke(sessionId, 'guess', { guess }),
    timeout: (sessionId: SessionId) => invoke(sessionId, 'timeout'),
    subscribeLive,
  };
}
