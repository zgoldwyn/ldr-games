/**
 * Client RealTimeGameModule — tic-tac-toe over the Local Store
 * (Requirements 6.1, 6.2, 6.3, 6.4, 6.8, 6.11, and 5.1's instant/offline reads).
 *
 * The server is authoritative for every real-time transition: `rt-move` validates
 * with the shared `applyMove` engine and fans the result out over Broadcast,
 * `rt-presence` pauses on a 30s disconnect, and `rt-rejoin` resumes. All of that
 * is integration-tested (task 15.3). This module is the client half: it issues
 * those requests and keeps the last-known session in the {@link LocalStore} so a
 * shell can render instantly and keep rendering while offline.
 *
 * WHY THERE IS NO LOCAL PRE-VALIDATION. It is tempting to run the shared pure
 * `applyMove` before calling the server and skip the round trip when it rejects.
 * That is wrong here. The cache lags the authoritative row by design, so a move
 * the server WOULD accept — the partner has already played and it really is our
 * turn, we just have not received the broadcast — would be refused locally
 * against stale state. Legality is the server's decision alone (Req 6.4, 6.11).
 * The pure engine remains available to a shell for optimistic *rendering*, which
 * is a different thing from authorization.
 *
 * WHAT 21.3 OWNS. This module does not open a channel. The Connection Manager
 * maintains the Broadcast and Presence subscriptions and feeds arriving states in
 * through {@link RealTimeGameModule.applyRemoteState}, exactly as task 14.2 left
 * remote changes to an injected listener rather than caching them itself.
 */
import type { GameId, SessionId } from '../domain/common.js';
import type { GameOutcome, GameState, Move, RealTimeGameDef, RTSession } from '../domain/game.js';
import type { RTSessionState } from '../domain/game.js';
import type { PairingId } from '../domain/common.js';
import type { RTError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { LocalStore, StoreListener } from '../store/local-store.js';

/** A real-time session as the `rt-move` / `rt-rejoin` functions return it. */
export interface RTSessionPayload {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: RTSessionState;
  readonly gameState: GameState;
  readonly outcome?: GameOutcome | null;
}

/**
 * Map the wire session onto the domain {@link RTSession}.
 *
 * `outcome` is dropped when null rather than passed through: it is optional on
 * `RTSession`, so a literal null would read as "finished, with no result" to a
 * shell that checks for its presence (Req 6.8).
 */
export function rtSessionFromPayload(payload: RTSessionPayload): RTSession {
  const outcome = payload.outcome;
  return {
    id: payload.id as SessionId,
    pairingId: payload.pairingId as PairingId,
    gameId: payload.gameId as GameId,
    state: payload.state,
    gameState: payload.gameState,
    ...(outcome === null || outcome === undefined ? {} : { outcome }),
  };
}

/** Success or a stable refusal from one of the real-time Edge Functions. */
export type RTSessionOutcome =
  | { readonly ok: true; readonly session: RTSessionPayload }
  | { readonly ok: false; readonly error: RTError };

export type RTCatalogOutcome =
  | { readonly ok: true; readonly games: readonly RealTimeGameDef[] }
  | { readonly ok: false; readonly error: RTError };

/** Injected collaborators, each a single `rt-move` action or sibling function. */
export interface RTGamePorts {
  /** `{ action: 'games' }` — the catalog (Req 6.1). */
  readonly listGames: () => Promise<RTCatalogOutcome>;
  /** `{ action: 'invite', gameId }` — create a pending session (Req 6.2). */
  readonly invite: (gameId: string) => Promise<RTSessionOutcome>;
  /** `{ action: 'join', sessionId }` — join within the 60s window (Req 6.3). */
  readonly join: (sessionId: string) => Promise<RTSessionOutcome>;
  /** `{ action: 'move', sessionId, move }` — a validated move (Req 6.4, 6.11). */
  readonly move: (sessionId: string, move: Move) => Promise<RTSessionOutcome>;
  /** `rt-rejoin` — resume a paused session within 5 minutes (Req 6.7). */
  readonly rejoin: (sessionId: string) => Promise<RTSessionOutcome>;
}

export interface RealTimeGameModule {
  /** The available real-time games (Req 6.1). */
  listGames(): Promise<Result<readonly RealTimeGameDef[], RTError>>;
  /** Invite the partner to a new session (Req 6.2). */
  invite(gameId: string): Promise<Result<RTSession, RTError>>;
  /** Join a pending session (Req 6.3). */
  join(sessionId: SessionId): Promise<Result<RTSession, RTError>>;
  /** Submit a move for server validation (Req 6.4, 6.11). */
  move(sessionId: SessionId, move: Move): Promise<Result<RTSession, RTError>>;
  /** Resume a paused session (Req 6.7). */
  rejoin(sessionId: SessionId): Promise<Result<RTSession, RTError>>;
  /** Apply a state delivered over Broadcast; called by the Connection Manager. */
  applyRemoteState(payload: RTSessionPayload): void;
  /** The last-known session, readable synchronously and offline. */
  cached(sessionId: SessionId): RTSession | undefined;
  /** Every cached real-time session. */
  list(): readonly RTSession[];
  /** Observe cache changes so a board re-renders. */
  subscribe(listener: StoreListener): () => void;
}

/** Build a real-time game module over the given ports and cache. */
export function createRealTimeGameModule(
  ports: RTGamePorts,
  store: LocalStore,
): RealTimeGameModule {
  function cache(payload: RTSessionPayload): RTSession {
    const session = rtSessionFromPayload(payload);
    // No version: real-time state arrives on ONE ordered Broadcast channel, and
    // requests are only issued in response to a user action, so there is no
    // second stream to race with. Inventing a version here would mean deriving
    // one from game-specific board contents, which the store must not know about.
    store.put('rt_session', session.id, session);
    return session;
  }

  /**
   * Apply the authoritative state a rejection echoes back.
   *
   * `rt-move` returns the unchanged state in `error.details.gameState` on an
   * invalid move precisely so a client that has drifted can correct itself
   * (Req 6.11). Ignoring it would leave the drift in place and make the next
   * move fail for the same invisible reason.
   */
  function resyncFromRejection(sessionId: SessionId, error: RTError): void {
    const echoed = error.details?.gameState;
    if (echoed === undefined || echoed === null) return;

    const cached = store.get<RTSession>('rt_session', sessionId);
    // Only correct a session already known; a rejection must never conjure one,
    // since the echo carries no session envelope of its own.
    if (cached === undefined) return;

    store.put('rt_session', sessionId, {
      ...cached,
      gameState: echoed as GameState,
    });
  }

  async function request(
    sessionId: SessionId | null,
    call: () => Promise<RTSessionOutcome>,
  ): Promise<Result<RTSession, RTError>> {
    const outcome = await call();
    if (outcome.ok) return ok(cache(outcome.session));
    if (sessionId !== null) resyncFromRejection(sessionId, outcome.error);
    return err(outcome.error);
  }

  return {
    async listGames(): Promise<Result<readonly RealTimeGameDef[], RTError>> {
      const outcome = await ports.listGames();
      return outcome.ok ? ok(outcome.games) : err(outcome.error);
    },

    invite: (gameId: string) => request(null, () => ports.invite(gameId)),
    join: (sessionId: SessionId) => request(sessionId, () => ports.join(sessionId)),
    move: (sessionId: SessionId, move: Move) =>
      request(sessionId, () => ports.move(sessionId, move)),
    rejoin: (sessionId: SessionId) => request(sessionId, () => ports.rejoin(sessionId)),

    applyRemoteState(payload: RTSessionPayload): void {
      cache(payload);
    },

    cached(sessionId: SessionId): RTSession | undefined {
      return store.get<RTSession>('rt_session', sessionId);
    },

    list(): readonly RTSession[] {
      return store.list<RTSession>('rt_session');
    },

    subscribe(listener: StoreListener): () => void {
      return store.subscribe('rt_session', listener);
    },
  };
}
