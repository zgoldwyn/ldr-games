/**
 * Real-time and asynchronous game shapes (Requirements 6 and 7).
 *
 * The engine state (`GameState`, `AsyncGameState`) and player intents (`Move`,
 * `TurnAction`) are intentionally open records here: concrete game rulesets
 * (Battleship, drawing game, etc.) refine them in later tasks. This file only
 * establishes the session envelopes, definitions, and shared enums.
 */
import type { AccountId, GameId, PairingId, SessionId, Timestamp } from './common.js';

/** Game-specific authoritative state for a real-time game. */
export type GameState = Record<string, unknown>;
/** Game-specific authoritative state for an asynchronous game. */
export type AsyncGameState = Record<string, unknown>;
/** A player intent submitted during an active real-time game. */
export type Move = Record<string, unknown>;
/** A player intent submitted by the active turn holder in an async game. */
export type TurnAction = Record<string, unknown>;

/** How a game session concluded. */
export type GameOutcomeKind =
  | 'completed' // reached a normal terminal state with a result
  | 'ended_without_outcome'; // terminated early, e.g. rejoin window elapsed (6.10)

/**
 * The recorded result of a finished game. `winner` is the winning account, or
 * `null` for a draw or an outcome without a winner.
 */
export interface GameOutcome {
  readonly kind: GameOutcomeKind;
  readonly winner: AccountId | null;
  readonly recordedAt: Timestamp;
}

/** Catalog entry for an available real-time game (Requirement 6.1). */
export interface RealTimeGameDef {
  readonly id: GameId;
  readonly name: string;
}

/** Catalog entry for an available asynchronous game (Requirement 7.1). */
export interface AsyncGameDef {
  readonly id: GameId;
  readonly name: string;
}

/** Lifecycle state of a real-time game session. */
export type RTSessionState = 'pending' | 'active' | 'paused' | 'terminal';

/**
 * A real-time game session. Both partners must be present to play; the session
 * pauses on a 30s disconnect and terminates if not rejoined within 5 minutes
 * (Requirements 6.3, 6.6, 6.7, 6.9, 6.10).
 */
export interface RTSession {
  readonly id: SessionId;
  readonly pairingId: PairingId;
  readonly gameId: GameId;
  readonly state: RTSessionState;
  readonly gameState: GameState;
  /** Set while pending; drives the 60s join window (Requirement 6.9). */
  readonly pendingSince?: Timestamp;
  /** Set while paused; drives the 5-minute resume window (Requirement 6.10). */
  readonly pausedSince?: Timestamp;
  readonly outcome?: GameOutcome;
}

/** Lifecycle state of an asynchronous game session. */
export type AsyncSessionState = 'active' | 'terminal';

/**
 * A durable, turn-based game session that survives arbitrary partner absence
 * and never expires from inactivity (Requirement 7.11). Only the
 * `activeTurnHolder` may take the next turn (Requirement 7.4).
 */
export interface AsyncSession {
  readonly id: SessionId;
  readonly pairingId: PairingId;
  readonly gameId: GameId;
  readonly state: AsyncSessionState;
  readonly activeTurnHolder: AccountId;
  /** Drives the 48-hour turn nudge (Requirement 7.12). */
  readonly turnPendingSince: Timestamp;
  readonly gameState: AsyncGameState;
  readonly outcome?: GameOutcome;
}

/** Per-partner connectivity signal derived from Realtime Presence. */
export interface PresenceState {
  readonly accountId: AccountId;
  readonly online: boolean;
  readonly lastSeenAt: Timestamp;
}
