/**
 * Pure real-time move engine and pluggable ruleset abstraction (Requirements
 * 6.4, 6.11).
 *
 * A real-time game is played by two present partners over an authoritative
 * {@link GameState}. Rather than baking one game's rules into the engine, this
 * module defines a small **ruleset** contract ({@link RealTimeRuleset}) that any
 * concrete game (Tic-Tac-Toe, Connect Four, …) implements, and a tiny
 * **registry** that maps a state's `game` discriminator to its ruleset. The
 * top-level {@link applyMove} engine is the single, shared entry point used
 * identically by the client (for optimistic rendering) and the server-authoritative
 * Edge Function (for validation) — it resolves the ruleset from the state and
 * delegates.
 *
 * Everything here is **pure and deterministic**: no `Date.now()`, no mutation of
 * the input state. A valid move returns `Ok` with a brand-new state object; an
 * invalid move (wrong phase, wrong actor, or a rule violation) returns
 * `Err(INVALID_MOVE)` and the caller's input state is left byte-for-byte
 * unchanged (Req 6.11). This is what property 20 (task 5.2) verifies.
 */
import { err, type Result } from '../result.js';
import { ERROR_CODES, type MoveError } from '../errors.js';
import type { AccountId, GameId, Timestamp } from './common.js';
import type { GameOutcome, GameState, Move } from './game.js';

/**
 * Status of an in-flight real-time game, independent of the session envelope
 * ({@link RTSession}). The engine advances this per move; the session layer
 * (task 5.3) maps a terminal status onto a recorded {@link GameOutcome}.
 */
export type RTGameStatus = 'in_progress' | 'won' | 'draw';

/**
 * Common shape every concrete real-time game state shares so the engine can
 * dispatch and the session layer can read progress without knowing the specific
 * game. Concrete rulesets extend this with their own board/scoreboard fields.
 *
 * - `game` is the ruleset key used by the registry to resolve the ruleset.
 * - `players` is the fixed two-partner roster; `currentTurn` names whoever may
 *   move next (games without alternating turns may ignore it).
 * - `status`/`winner` capture terminal progress; `winner` is `null` for a draw
 *   or while still in progress.
 */
export interface RTGameStateBase {
  readonly game: string;
  readonly players: readonly [AccountId, AccountId];
  readonly currentTurn: AccountId;
  readonly status: RTGameStatus;
  readonly winner: AccountId | null;
  // Open index signature keeps concrete states assignable to the engine's
  // `GameState` (an open `Record<string, unknown>`) while rulesets refine it
  // with their own typed board/scoreboard fields.
  readonly [key: string]: unknown;
}

/**
 * The contract a concrete real-time game plugs into the engine. Implementations
 * MUST be pure: {@link RealTimeRuleset.applyMove} never mutates `state` and
 * returns a fresh state on success.
 *
 * @typeParam S concrete game state, refining {@link RTGameStateBase}
 * @typeParam M concrete move type, refining {@link Move}
 */
export interface RealTimeRuleset<
  S extends RTGameStateBase = RTGameStateBase,
  M extends Move = Move,
> {
  /** Stable ruleset key; matches {@link RTGameStateBase.game} and a {@link RealTimeGameDef.id}. */
  readonly game: string;
  /** Human-friendly game name (Req 6.1 catalog). */
  readonly name: string;
  /**
   * Build the identical initial state presented to both partners when a pending
   * session becomes active (Req 6.3). `first` is the partner who moves first.
   */
  createInitialState(players: readonly [AccountId, AccountId], first: AccountId): S;
  /**
   * Validate and apply `move` by `actor`. Returns `Ok(next)` with a new state on
   * a valid move (Req 6.4); returns `Err(INVALID_MOVE)` without touching `state`
   * on any invalid move — wrong actor, wrong phase, or a rule violation (Req 6.11).
   */
  applyMove(state: S, actor: AccountId, move: M): Result<S, MoveError>;
  /** True once the game has reached a terminal status. */
  isTerminal(state: S): boolean;
  /**
   * Derive the recorded outcome for a terminal state, or `null` if the game is
   * still in progress. `recordedAt` is supplied by the caller to keep this pure.
   */
  outcome(state: S, recordedAt: Timestamp): GameOutcome | null;
}

/** Construct the standard {@link MoveError} for a rejected move (Req 6.11). */
export function invalidMove(message = 'Invalid move'): MoveError {
  return { code: ERROR_CODES.INVALID_MOVE, message };
}

// ---------------------------------------------------------------------------
// Ruleset registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, RealTimeRuleset>();

/**
 * Register a concrete real-time ruleset so the engine can dispatch to it. Later
 * registrations for the same key override earlier ones. Returns the ruleset for
 * convenient chaining/export.
 */
export function registerRuleset<S extends RTGameStateBase, M extends Move>(
  ruleset: RealTimeRuleset<S, M>,
): RealTimeRuleset<S, M> {
  REGISTRY.set(ruleset.game, ruleset as unknown as RealTimeRuleset);
  return ruleset;
}

/** Look up a registered ruleset by its `game` key, or `undefined` if unknown. */
export function getRuleset(game: string): RealTimeRuleset | undefined {
  return REGISTRY.get(game);
}

/** All registered real-time rulesets, e.g. to build the game catalog (Req 6.1). */
export function listRulesets(): readonly RealTimeRuleset[] {
  return [...REGISTRY.values()];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Type guard: a {@link GameState} carries the base real-time fields (in
 * particular a `game` discriminator the registry can resolve).
 */
function isRTGameState(state: GameState): state is GameState & RTGameStateBase {
  return typeof (state as { game?: unknown }).game === 'string';
}

/**
 * Pure real-time move engine (Requirements 6.4, 6.11). Resolves the ruleset from
 * the state's `game` discriminator and delegates validation/application to it.
 *
 * - Valid move → `Ok(nextState)`, a fresh state object; the input is untouched (6.4).
 * - Invalid move, unknown game, or non-real-time state → `Err(INVALID_MOVE)` and
 *   the input `state` is returned to the caller unchanged (6.11).
 *
 * The `actor` is the account attempting the move; rulesets reject moves from a
 * non-participant or out-of-turn actor as invalid.
 */
export function applyMove(
  state: GameState,
  actor: AccountId,
  move: Move,
): Result<GameState, MoveError> {
  if (!isRTGameState(state)) {
    return err(invalidMove('Unrecognized real-time game state'));
  }
  const ruleset = REGISTRY.get(state.game);
  if (!ruleset) {
    return err(invalidMove(`No ruleset registered for game "${state.game}"`));
  }
  return ruleset.applyMove(state, actor, move);
}

/** A {@link GameId}-typed view of a ruleset key, for catalog interop. */
export function rulesetGameId(ruleset: RealTimeRuleset): GameId {
  return ruleset.game as GameId;
}
