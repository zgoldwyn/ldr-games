/**
 * Pure asynchronous turn engine (Requirements 7.4, 7.5, 7.7, 7.8).
 *
 * `applyTurn` is the single source of truth for what a turn *means*: it decides
 * whether an attempted turn is allowed, applies its game-specific effect, and
 * hands ownership to the other partner. It is a **pure, deterministic** function
 * of its inputs — no clocks, no I/O, no mutation — so it can run identically in
 * the client and inside the takeTurn Edge Function, and so it is exhaustively
 * property-testable (Property 24). Persistence, notification, and the 48-hour
 * nudge are layered on top elsewhere (tasks 6.3, 16.1).
 *
 * The engine is game-agnostic: the game-specific rules live in pluggable
 * {@link AsyncRuleset}s (Battleship, drawing game). The engine owns the parts
 * that are identical for every asynchronous game — turn-holder authorization,
 * holder transfer, turn recording, and terminal transition — and delegates the
 * move-legality decision and state mutation to the ruleset selected by the
 * game's state.
 */
import type { AccountId, GameId } from './common.js';
import type { AsyncGameDef, AsyncGameState, TurnAction } from './game.js';
import type { TurnError, TurnErrorCode } from '../errors.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { battleshipRuleset } from './async-battleship.js';
import type { BattleshipAction, BattleshipState } from './async-battleship.js';
import { drawingRuleset } from './async-drawing.js';
import type { DrawingAction, DrawingState } from './async-drawing.js';

// ---------------------------------------------------------------------------
// Ruleset abstraction
// ---------------------------------------------------------------------------

/** Common shape of every ruleset's state: a discriminant `kind`. */
export interface RulesetStateBase {
  readonly kind: string;
}

/** Common shape of every ruleset's action: a discriminant `kind`. */
export interface RulesetActionBase {
  readonly kind: string;
}

/**
 * The result of a ruleset applying one valid turn: the new game-specific state,
 * whether the game reached a terminal state, and the winner when it did
 * (`null` for a draw or a non-competitive game).
 */
export interface RulesetApplyResult<S extends RulesetStateBase> {
  readonly rulesetState: S;
  readonly terminal: boolean;
  readonly winner: AccountId | null;
}

/**
 * A pluggable asynchronous game ruleset. `applyAction` is a pure function that
 * validates and applies one turn's game-specific effect for the active turn
 * holder (`actor`) against `opponent`, returning the new state or `null` when
 * the turn is invalid. It must never mutate its inputs.
 */
export interface AsyncRuleset<
  S extends RulesetStateBase,
  A extends RulesetActionBase,
> {
  readonly kind: S['kind'];
  readonly def: AsyncGameDef;
  applyAction(
    state: S,
    actor: AccountId,
    opponent: AccountId,
    action: A,
  ): RulesetApplyResult<S> | null;
}

/** The union of every concrete ruleset's state. */
export type RulesetState = BattleshipState | DrawingState;
/** The union of every concrete ruleset's action. */
export type RulesetAction = BattleshipAction | DrawingAction;

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

/** A recorded turn in an asynchronous game session's history (Requirement 7.5). */
export interface RecordedTurn {
  /** Zero-based position of this turn in the session's history. */
  readonly seq: number;
  /** The partner who took the turn. */
  readonly actor: AccountId;
  /** The action that was applied. */
  readonly action: TurnAction;
}

/**
 * The concrete, structured form of an {@link AsyncGameState} that the engine
 * operates on. It carries the two partners, the current Active_Turn_Holder, the
 * recorded turn history, terminal status and winner, and the ruleset-specific
 * state. It is immutable; `applyTurn` returns a new value and never mutates the
 * input.
 */
export interface AsyncEngineState {
  readonly gameId: GameId;
  readonly players: readonly [AccountId, AccountId];
  readonly activeTurnHolder: AccountId;
  readonly status: 'active' | 'terminal';
  readonly winner: AccountId | null;
  readonly turns: readonly RecordedTurn[];
  readonly ruleset: RulesetState;
}

/** Catalog of the available asynchronous games (Requirement 7.1). */
export const ASYNC_GAME_DEFS: readonly AsyncGameDef[] = [
  battleshipRuleset.def,
  drawingRuleset.def,
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const turnError = (code: TurnErrorCode, message: string): TurnError => ({
  code,
  message,
});

/** The partner who is not `p`, or `undefined` if `p` is not one of `players`. */
function otherPlayer(
  players: readonly [AccountId, AccountId],
  p: AccountId,
): AccountId | undefined {
  if (p === players[0]) return players[1];
  if (p === players[1]) return players[0];
  return undefined;
}

/** Dispatch a turn to the ruleset selected by the game's current state. */
function applyRulesetAction(
  ruleset: RulesetState,
  actor: AccountId,
  opponent: AccountId,
  action: TurnAction,
): RulesetApplyResult<RulesetState> | null {
  switch (ruleset.kind) {
    case 'battleship':
      return battleshipRuleset.applyAction(
        ruleset,
        actor,
        opponent,
        action as unknown as BattleshipAction,
      );
    case 'drawing':
      return drawingRuleset.applyAction(
        ruleset,
        actor,
        opponent,
        action as unknown as DrawingAction,
      );
    default:
      return null;
  }
}

/**
 * Apply an attempted turn to an asynchronous game state.
 *
 * - When `holder` is the current Active_Turn_Holder and the turn is valid, the
 *   turn is recorded, the game state is updated, and the Active_Turn_Holder
 *   designation transfers to the other partner — so the same partner cannot
 *   take two turns in a row (Requirements 7.4, 7.5).
 * - When `holder` is not the Active_Turn_Holder, the turn is rejected with
 *   `NOT_YOUR_TURN` and the state (including the holder) is returned unchanged
 *   (Requirement 7.7).
 * - When the turn is invalid, it is rejected with `INVALID_TURN` and the state
 *   (including the holder) is unchanged (Requirement 7.8). A turn attempted on a
 *   session that is not active is likewise `INVALID_TURN`.
 *
 * The function is pure: it never mutates `state` or `action`, and its result
 * depends only on its arguments.
 */
export function applyTurn(
  state: AsyncGameState,
  holder: AccountId,
  action: TurnAction,
): Result<AsyncGameState, TurnError> {
  const s = state as unknown as AsyncEngineState;

  // A turn can only be taken on an active session.
  if (s.status !== 'active') {
    return err(turnError('INVALID_TURN', 'Session is not active.'));
  }

  // Only the Active_Turn_Holder may take the next turn (Req 7.4, 7.7).
  if (holder !== s.activeTurnHolder) {
    return err(turnError('NOT_YOUR_TURN', 'It is not that partner\u2019s turn.'));
  }

  const opponent = otherPlayer(s.players, holder);
  if (opponent === undefined) {
    // Malformed state: the holder is not one of the two partners.
    return err(turnError('INVALID_TURN', 'The turn is invalid.'));
  }

  const applied = applyRulesetAction(s.ruleset, holder, opponent, action);
  if (applied === null) {
    return err(turnError('INVALID_TURN', 'The turn is invalid.'));
  }

  // Record the turn, update state, and transfer the holder (Req 7.5).
  const next: AsyncEngineState = {
    ...s,
    ruleset: applied.rulesetState,
    turns: [...s.turns, { seq: s.turns.length, actor: holder, action }],
    activeTurnHolder: opponent,
    status: applied.terminal ? 'terminal' : 'active',
    winner: applied.terminal ? applied.winner : s.winner,
  };

  return ok(next as unknown as AsyncGameState);
}
