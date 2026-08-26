/**
 * Battleship ruleset for the asynchronous turn engine (Requirements 7.4, 7.5,
 * 7.7, 7.8).
 *
 * Battleship is a strictly turn-based hidden-information game: each partner
 * secretly places ships on their own grid, then partners alternate firing a
 * single shot at the opponent's grid. A shot is a *hit* when it lands on an
 * opponent ship cell and a *miss* otherwise; a partner wins once every cell of
 * every opponent ship has been hit.
 *
 * This module only holds the **pure** rules — validating and applying one shot
 * to an immutable board state. Turn ownership, holder transfer, and turn
 * recording live in {@link ./async-engine.ts}; the engine calls
 * {@link battleshipRuleset.applyAction} for the game-specific effect of a turn.
 */
import type { AccountId, GameId } from './common.js';
import { gameId } from './common.js';
import type { AsyncGameDef } from './game.js';
import type {
  AsyncEngineState,
  AsyncRuleset,
  RulesetApplyResult,
} from './async-engine.js';

/** A single grid coordinate; `row` and `col` are zero-based integers. */
export interface Cell {
  readonly row: number;
  readonly col: number;
}

/** A shot fired by a partner at the opponent's grid, with its resolved result. */
export interface Shot {
  readonly row: number;
  readonly col: number;
  readonly hit: boolean;
}

/**
 * Battleship ruleset state. `ships` are each partner's own ship cells (the
 * targets the *opponent* fires at); `shots` are the shots each partner has
 * fired at their opponent. `size` is the square grid dimension.
 */
export interface BattleshipState {
  readonly kind: 'battleship';
  readonly size: number;
  readonly ships: Readonly<Record<AccountId, readonly Cell[]>>;
  readonly shots: Readonly<Record<AccountId, readonly Shot[]>>;
}

/** A Battleship turn: fire a single shot at coordinate (`row`, `col`). */
export interface BattleshipAction {
  readonly kind: 'battleship.fire';
  readonly row: number;
  readonly col: number;
}

/** Catalog entry for the Battleship asynchronous game (Requirement 7.1). */
export const BATTLESHIP_GAME_ID: GameId = gameId('battleship');

/** Catalog entry for the Battleship asynchronous game (Requirement 7.1). */
export const BATTLESHIP_GAME_DEF: AsyncGameDef = {
  id: BATTLESHIP_GAME_ID,
  name: 'Battleship',
};

const cellKey = (row: number, col: number): string => `${row},${col}`;

const isIntInRange = (value: unknown, size: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < size;

/**
 * The Battleship ruleset: validates and applies one shot for the active turn
 * holder. Returns `null` when the shot is invalid (wrong action shape,
 * off-grid, or a coordinate the actor has already fired at) so the engine can
 * reject the turn as `INVALID_TURN` (Requirement 7.8). On a valid shot it
 * returns the new immutable state, whether the game reached a terminal state,
 * and the winner when it did.
 */
export const battleshipRuleset: AsyncRuleset<BattleshipState, BattleshipAction> = {
  kind: 'battleship',
  def: BATTLESHIP_GAME_DEF,

  applyAction(
    state: BattleshipState,
    actor: AccountId,
    opponent: AccountId,
    action: BattleshipAction,
  ): RulesetApplyResult<BattleshipState> | null {
    if (action === null || typeof action !== 'object') return null;
    if (action.kind !== 'battleship.fire') return null;
    if (!isIntInRange(action.row, state.size)) return null;
    if (!isIntInRange(action.col, state.size)) return null;

    const opponentShips = state.ships[opponent];
    if (opponentShips === undefined) return null;

    const priorShots = state.shots[actor] ?? [];

    // A coordinate may only be fired at once by a given partner (Req 7.8).
    if (priorShots.some((s) => s.row === action.row && s.col === action.col)) {
      return null;
    }

    const shipKeys = new Set(opponentShips.map((c) => cellKey(c.row, c.col)));
    const hit = shipKeys.has(cellKey(action.row, action.col));
    const shot: Shot = { row: action.row, col: action.col, hit };
    const nextShots = [...priorShots, shot];

    const nextState: BattleshipState = {
      ...state,
      shots: { ...state.shots, [actor]: nextShots },
    };

    // The actor wins once every opponent ship cell has been hit.
    const hitKeys = new Set(
      nextShots.filter((s) => s.hit).map((s) => cellKey(s.row, s.col)),
    );
    const allSunk =
      shipKeys.size > 0 && [...shipKeys].every((k) => hitKeys.has(k));

    return {
      rulesetState: nextState,
      terminal: allSunk,
      winner: allSunk ? actor : null,
    };
  },
};

/**
 * Build the initial engine state for a Battleship game. `ships` is each
 * partner's own ship placement; `firstHolder` is the partner who fires first
 * (defaults to the first player), designated as the initial Active_Turn_Holder
 * per the game's rules (Requirement 7.2).
 */
export function createBattleshipGame(params: {
  readonly players: readonly [AccountId, AccountId];
  readonly ships: Readonly<Record<AccountId, readonly Cell[]>>;
  readonly firstHolder?: AccountId;
  readonly size?: number;
}): AsyncEngineState {
  const { players, ships } = params;
  const size = params.size ?? 10;
  const firstHolder = params.firstHolder ?? players[0];
  return {
    gameId: BATTLESHIP_GAME_ID,
    players,
    activeTurnHolder: firstHolder,
    status: 'active',
    winner: null,
    turns: [],
    ruleset: {
      kind: 'battleship',
      size,
      ships,
      shots: { [players[0]]: [], [players[1]]: [] },
    },
  };
}
