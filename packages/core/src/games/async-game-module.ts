/**
 * Client AsyncGameModule — battleship over the Local Store
 * (Requirements 7.1, 7.2, 7.3, 7.5, 7.7, 7.8, 7.10, and 5.1's offline reads).
 *
 * The server owns every turn decision: `async-take-turn` validates with the
 * shared `applyTurn` engine, transfers the Active_Turn_Holder and inserts the
 * your-turn notification inside one transaction, all integration-tested (task
 * 16.3). This module issues those requests and caches the resulting sessions.
 *
 * TWO ARRIVAL PATHS, TWO MAPPERS. Unlike the real-time game, an asynchronous
 * session propagates over **Postgres Changes** rather than Broadcast, because it
 * must survive arbitrary partner absence (Req 7.11) and be re-derivable on
 * reconnect. So a session reaches this module either as the Edge Function's
 * camelCase response or as the raw replicated row — snake_case, with an ISO
 * `turn_pending_since`. Both are mapped explicitly; sharing one mapper would
 * silently drop `active_turn_holder` and strand the board on the wrong player.
 *
 * WHY WRITES ARE VERSIONED. Those two paths race: the `takeTurn` response and
 * the Realtime replay of the very same commit can arrive in either order, and a
 * *previous* commit's replay can land after a newer response. The recorded turn
 * count is the natural monotonic version — Req 7.5 appends exactly one turn per
 * valid turn — so a late row is ignored instead of visibly rewinding the board.
 *
 * The drawing game is deferred (task 21.2 note): its Edge Function path and
 * Storage wiring already exist and are tested, so adding it later is UI-only.
 */
import { ASYNC_GAME_DEFS } from '../domain/async-engine.js';
import type { AccountId, GameId, PairingId, SessionId } from '../domain/common.js';
import type {
  AsyncGameDef,
  AsyncGameState,
  AsyncSession,
  AsyncSessionState,
  GameOutcome,
  TurnAction,
} from '../domain/game.js';
import type { AsyncError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { LocalStore, StoreListener } from '../store/local-store.js';

/** A session as `async-start` / `async-take-turn` return it. */
export interface AsyncSessionPayload {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: AsyncSessionState;
  readonly activeTurnHolder: string;
  readonly turnPendingSince: number;
  readonly gameState: AsyncGameState;
  readonly outcome?: GameOutcome | null;
}

/** A session as Postgres Changes replicates the `async_sessions` row. */
export interface AsyncSessionRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly game_id: string;
  readonly state: AsyncSessionState;
  readonly active_turn_holder: string;
  readonly turn_pending_since: string | null;
  readonly game_state: AsyncGameState;
  readonly outcome?: GameOutcome | null;
}

/** Shared tail of both mappers: `outcome` is dropped when absent (Req 7.10). */
function withOutcome(
  base: Omit<AsyncSession, 'outcome'>,
  outcome: GameOutcome | null | undefined,
): AsyncSession {
  return outcome === null || outcome === undefined ? base : { ...base, outcome };
}

/** Map the Edge Function payload onto the domain {@link AsyncSession}. */
export function asyncSessionFromPayload(payload: AsyncSessionPayload): AsyncSession {
  return withOutcome(
    {
      id: payload.id as SessionId,
      pairingId: payload.pairingId as PairingId,
      gameId: payload.gameId as GameId,
      state: payload.state,
      activeTurnHolder: payload.activeTurnHolder as AccountId,
      turnPendingSince: payload.turnPendingSince,
      gameState: payload.gameState,
    },
    payload.outcome,
  );
}

/** Map a replicated `async_sessions` row onto the domain {@link AsyncSession}. */
export function asyncSessionFromRow(row: AsyncSessionRow): AsyncSession {
  return withOutcome(
    {
      id: row.id as SessionId,
      pairingId: row.pairing_id as PairingId,
      gameId: row.game_id as GameId,
      state: row.state,
      activeTurnHolder: row.active_turn_holder as AccountId,
      // Postgres hands back an ISO timestamp; the domain speaks epoch millis,
      // and the 48-hour nudge window (Req 7.12) is measured against this.
      turnPendingSince: row.turn_pending_since === null ? 0 : Date.parse(row.turn_pending_since),
      gameState: row.game_state,
    },
    row.outcome,
  );
}

/**
 * The monotonic version of a session: how many turns have been recorded.
 * Req 7.5 appends exactly one per valid turn, so this never decreases for a
 * given session.
 */
function turnCount(session: AsyncSession): number {
  const turns = (session.gameState as { turns?: readonly unknown[] }).turns;
  return Array.isArray(turns) ? turns.length : 0;
}

export type AsyncSessionOutcome =
  | { readonly ok: true; readonly session: AsyncSessionPayload }
  | { readonly ok: false; readonly error: AsyncError };

/** Game-specific start options, e.g. battleship's `ships`, `size`, `firstHolder`. */
export type AsyncStartOptions = Record<string, unknown>;

/** Injected collaborators. */
export interface AsyncGamePorts {
  /** `async-start` — create a session and designate a holder (Req 7.2, 7.9). */
  readonly start: (
    gameId: string,
    options: AsyncStartOptions,
  ) => Promise<AsyncSessionOutcome>;
  /** `async-take-turn` — apply one turn (Req 7.5, 7.7, 7.8). */
  readonly takeTurn: (
    sessionId: string,
    action: TurnAction,
  ) => Promise<AsyncSessionOutcome>;
  /** Every async session for the caller's pairing, read through RLS. */
  readonly fetchSessions: () => Promise<readonly AsyncSessionPayload[]>;
}

export interface AsyncGameModule {
  /** The available asynchronous games (Req 7.1). */
  listGames(): readonly AsyncGameDef[];
  /** Start a session (Req 7.2). */
  start(
    gameId: string,
    options: AsyncStartOptions,
  ): Promise<Result<AsyncSession, AsyncError>>;
  /** Take one turn as the Active_Turn_Holder (Req 7.5, 7.7, 7.8). */
  takeTurn(
    sessionId: SessionId,
    action: TurnAction,
  ): Promise<Result<AsyncSession, AsyncError>>;
  /** Reload every session from the server (Req 7.3). */
  refresh(): Promise<readonly AsyncSession[]>;
  /** Apply a replicated row; called by the Connection Manager (task 21.3). */
  applyRemoteRow(row: AsyncSessionRow): void;
  /** The last-known session, readable synchronously and offline. */
  cached(sessionId: SessionId): AsyncSession | undefined;
  /** Every cached asynchronous session. */
  list(): readonly AsyncSession[];
  /** Whether `accountId` may take the next turn (Req 7.4). */
  isMyTurn(sessionId: SessionId, accountId: AccountId): boolean;
  /** Observe cache changes so a board re-renders. */
  subscribe(listener: StoreListener): () => void;
}

/** Build an asynchronous game module over the given ports and cache. */
export function createAsyncGameModule(
  ports: AsyncGamePorts,
  store: LocalStore,
): AsyncGameModule {
  function cache(session: AsyncSession): AsyncSession {
    store.put('async_session', session.id, session, turnCount(session));
    return session;
  }

  return {
    listGames(): readonly AsyncGameDef[] {
      // A local constant, so the catalog renders offline and on a cold start.
      // The pairing requirement (Req 7.1) is enforced where it matters — the
      // server refuses `async-start` with PAIRING_REQUIRED (Req 7.9).
      return ASYNC_GAME_DEFS;
    },

    async start(
      gameId: string,
      options: AsyncStartOptions,
    ): Promise<Result<AsyncSession, AsyncError>> {
      const outcome = await ports.start(gameId, options);
      return outcome.ok
        ? ok(cache(asyncSessionFromPayload(outcome.session)))
        : err(outcome.error);
    },

    async takeTurn(
      sessionId: SessionId,
      action: TurnAction,
    ): Promise<Result<AsyncSession, AsyncError>> {
      const outcome = await ports.takeTurn(sessionId, action);
      // A refusal writes nothing. `async-take-turn` echoes no state (unlike
      // `rt-move`), so there is nothing to resynchronise from, and the contract
      // guarantees the server-side row is unchanged anyway (Req 7.7, 7.8).
      return outcome.ok
        ? ok(cache(asyncSessionFromPayload(outcome.session)))
        : err(outcome.error);
    },

    async refresh(): Promise<readonly AsyncSession[]> {
      const payloads = await ports.fetchSessions();
      return payloads.map((p) => cache(asyncSessionFromPayload(p)));
    },

    applyRemoteRow(row: AsyncSessionRow): void {
      cache(asyncSessionFromRow(row));
    },

    cached(sessionId: SessionId): AsyncSession | undefined {
      return store.get<AsyncSession>('async_session', sessionId);
    },

    list(): readonly AsyncSession[] {
      return store.list<AsyncSession>('async_session');
    },

    isMyTurn(sessionId: SessionId, accountId: AccountId): boolean {
      const session = store.get<AsyncSession>('async_session', sessionId);
      // A finished game has no next turn, so a terminal session is never "mine".
      if (session === undefined || session.state !== 'active') return false;
      return session.activeTurnHolder === accountId;
    },

    subscribe(listener: StoreListener): () => void {
      return store.subscribe('async_session', listener);
    },
  };
}
