/**
 * Real `supabase-js` implementations of {@link RTGamePorts} and
 * {@link AsyncGamePorts} (Requirements 6.x, 7.x).
 *
 * Thin adapters, matching `auth/supabase-ports.ts`: construct a request, invoke
 * the Edge Function, translate the response. Every decision worth unit-testing
 * lives in the modules; these are exercised end to end by
 * `__harness__/realtime-game.integration.test.ts` and
 * `__harness__/async-game.integration.test.ts`, which are the contracts these
 * shapes are copied from.
 *
 * `rt-move` is one function with an `action` discriminator (`games`, `invite`,
 * `join`, `move`); `rt-rejoin` and `rt-presence` are siblings. `rt-presence` is
 * NOT wired here — producing a presence snapshot means tracking a Presence
 * channel, which is task 21.3's Connection Manager.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { RealTimeGameDef } from '../domain/game.js';
import type { Move, TurnAction } from '../domain/game.js';
import { ERROR_CODES, type AsyncErrorCode, type RTErrorCode } from '../errors.js';
import { narrowCode, readErrorEnvelope } from '../supabase/function-error.js';
import type {
  AsyncGamePorts,
  AsyncSessionOutcome,
  AsyncSessionPayload,
  AsyncStartOptions,
} from './async-game-module.js';
import type { RTCatalogOutcome, RTGamePorts, RTSessionOutcome, RTSessionPayload } from './rt-game-module.js';

const RT_CODES: readonly string[] = [
  ERROR_CODES.PAIRING_REQUIRED,
  ERROR_CODES.SESSION_NOT_FOUND,
  ERROR_CODES.INVALID_MOVE,
  ERROR_CODES.JOIN_WINDOW_EXPIRED,
  ERROR_CODES.REJOIN_WINDOW_EXPIRED,
  ERROR_CODES.INVALID_SESSION_STATE,
];

const ASYNC_CODES: readonly string[] = [
  ERROR_CODES.PAIRING_REQUIRED,
  ERROR_CODES.SESSION_NOT_FOUND,
  ERROR_CODES.NOT_YOUR_TURN,
  ERROR_CODES.INVALID_TURN,
  ERROR_CODES.INVALID_SESSION_STATE,
];

/** Build {@link RTGamePorts} over an authenticated Supabase client. */
export function createSupabaseRTGamePorts(client: SupabaseClient): RTGamePorts {
  async function session(
    fn: 'rt-move' | 'rt-rejoin',
    body: Record<string, unknown>,
  ): Promise<RTSessionOutcome> {
    const { data, error } = await client.functions.invoke<{ session?: RTSessionPayload }>(
      fn,
      { body },
    );

    if (error) {
      const envelope = await readErrorEnvelope(error);
      return {
        ok: false,
        error: {
          // A transport failure falls back to SESSION_NOT_FOUND rather than
          // INVALID_MOVE: telling a player their legal move was illegal is worse
          // than telling them the session could not be reached.
          code: narrowCode<RTErrorCode>(
            envelope?.code,
            RT_CODES,
            ERROR_CODES.SESSION_NOT_FOUND,
          ),
          message: envelope?.message ?? 'The real-time game request failed.',
          // Carries `gameState` on an invalid move, which is what lets the module
          // resynchronise a drifted board (Req 6.11).
          ...(envelope?.details === undefined ? {} : { details: envelope.details }),
        },
      };
    }

    const payload = data?.session;
    if (payload === undefined) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.SESSION_NOT_FOUND,
          message: 'The server returned no session.',
        },
      };
    }
    return { ok: true, session: payload };
  }

  return {
    async listGames(): Promise<RTCatalogOutcome> {
      const { data, error } = await client.functions.invoke<{
        games?: RealTimeGameDef[];
      }>('rt-move', { body: { action: 'games' } });

      if (error) {
        const envelope = await readErrorEnvelope(error);
        return {
          ok: false,
          error: {
            // The catalog is gated on the pairing (Req 6.5), so that is the
            // meaningful failure a shell acts on.
            code: narrowCode<RTErrorCode>(
              envelope?.code,
              RT_CODES,
              ERROR_CODES.PAIRING_REQUIRED,
            ),
            message: envelope?.message ?? 'The game catalog could not be read.',
          },
        };
      }
      return { ok: true, games: data?.games ?? [] };
    },

    invite: (gameId) => session('rt-move', { action: 'invite', gameId }),
    join: (sessionId) => session('rt-move', { action: 'join', sessionId }),
    move: (sessionId, move: Move) => session('rt-move', { action: 'move', sessionId, move }),
    rejoin: (sessionId) => session('rt-rejoin', { sessionId }),
  };
}

/**
 * Build {@link AsyncGamePorts} over an authenticated Supabase client.
 *
 * `fetchSessions` reads `async_sessions` directly rather than through a
 * function: the `async_sessions_select_pairing` RLS policy already restricts the
 * rows to the caller's pairing and checks the session epoch, so a function would
 * add a hop without adding a check.
 */
export function createSupabaseAsyncGamePorts(client: SupabaseClient): AsyncGamePorts {
  async function session(
    fn: 'async-start' | 'async-take-turn',
    body: Record<string, unknown>,
  ): Promise<AsyncSessionOutcome> {
    const { data, error } = await client.functions.invoke<{ session?: AsyncSessionPayload }>(
      fn,
      { body },
    );

    if (error) {
      const envelope = await readErrorEnvelope(error);
      return {
        ok: false,
        error: {
          code: narrowCode<AsyncErrorCode>(
            envelope?.code,
            ASYNC_CODES,
            ERROR_CODES.SESSION_NOT_FOUND,
          ),
          message: envelope?.message ?? 'The asynchronous game request failed.',
        },
      };
    }

    const payload = data?.session;
    if (payload === undefined) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.SESSION_NOT_FOUND,
          message: 'The server returned no session.',
        },
      };
    }
    return { ok: true, session: payload };
  }

  return {
    start: (gameId: string, options: AsyncStartOptions) =>
      session('async-start', { gameId, options }),

    takeTurn: (sessionId: string, action: TurnAction) =>
      session('async-take-turn', { sessionId, action }),

    async fetchSessions(): Promise<readonly AsyncSessionPayload[]> {
      const { data, error } = await client
        .from('async_sessions')
        .select('id, pairing_id, game_id, state, active_turn_holder, turn_pending_since, game_state, outcome');

      if (error || data === null) return [];

      // Normalized to the camelCase payload the module's mapper expects, so both
      // read paths converge on one shape before reaching the cache.
      return data.map((row) => ({
        id: row.id as string,
        pairingId: row.pairing_id as string,
        gameId: row.game_id as string,
        state: row.state as AsyncSessionPayload['state'],
        activeTurnHolder: row.active_turn_holder as string,
        turnPendingSince:
          row.turn_pending_since === null ? 0 : Date.parse(row.turn_pending_since as string),
        gameState: row.game_state as AsyncSessionPayload['gameState'],
        outcome: row.outcome as AsyncSessionPayload['outcome'],
      }));
    },
  };
}
