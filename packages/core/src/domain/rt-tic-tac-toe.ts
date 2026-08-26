/**
 * Tic-Tac-Toe: a concrete real-time game ruleset plugging into the pure move
 * engine (Requirements 6.4, 6.11).
 *
 * Tic-Tac-Toe is a deterministic, alternating-turn, two-player game — a minimal
 * but complete exercise of the {@link RealTimeRuleset} contract: it validates
 * moves (turn ownership, bounds, occupancy), updates authoritative state on a
 * valid move, and detects terminal win/draw states. All functions are pure and
 * never mutate the input state; a rejected move yields `Err(INVALID_MOVE)` with
 * the board unchanged (Req 6.11).
 *
 * State is a flat 9-cell board indexed 0..8 as:
 * ```
 *  0 | 1 | 2
 *  3 | 4 | 5
 *  6 | 7 | 8
 * ```
 * Each cell holds the {@link AccountId} that claimed it, or `null` if empty.
 */
import { err, ok, type Result } from '../result.js';
import type { MoveError } from '../errors.js';
import type { AccountId, Timestamp } from './common.js';
import type { GameOutcome } from './game.js';
import {
  invalidMove,
  registerRuleset,
  type RealTimeRuleset,
  type RTGameStateBase,
} from './rt-engine.js';

/** The `game` discriminator key for Tic-Tac-Toe state and moves. */
export const TIC_TAC_TOE = 'tic-tac-toe';

/** A single board cell: the claiming account, or `null` when empty. */
export type TicTacToeCell = AccountId | null;

/** Authoritative Tic-Tac-Toe state: the base envelope plus a 9-cell board. */
export interface TicTacToeState extends RTGameStateBase {
  readonly game: typeof TIC_TAC_TOE;
  /** Exactly nine cells, row-major (see module header). */
  readonly board: readonly TicTacToeCell[];
}

/** A Tic-Tac-Toe move: claim an empty `cell` in 0..8. */
export interface TicTacToeMove {
  readonly type: 'place';
  readonly cell: number;
  // Open index signature keeps the move assignable to the engine's open `Move`.
  readonly [key: string]: unknown;
}

/** The eight winning lines (rows, columns, diagonals) as cell-index triples. */
const WINNING_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** The other partner in the two-player roster. */
function opponent(players: readonly [AccountId, AccountId], actor: AccountId): AccountId {
  return players[0] === actor ? players[1] : players[0];
}

/** Narrow an unknown value to a well-formed {@link TicTacToeMove}. */
function isPlaceMove(move: unknown): move is TicTacToeMove {
  const m = move as Partial<TicTacToeMove>;
  return m?.type === 'place' && typeof m.cell === 'number';
}

/**
 * Find the account occupying a full winning line, or `null` if none is complete.
 */
function findWinner(board: readonly TicTacToeCell[]): AccountId | null {
  for (const [a, b, c] of WINNING_LINES) {
    const first = board[a];
    if (first != null && first === board[b] && first === board[c]) {
      return first;
    }
  }
  return null;
}

/**
 * The Tic-Tac-Toe ruleset. Pure and deterministic; suitable for both the client
 * and the server-authoritative Edge Function.
 */
export const ticTacToeRuleset: RealTimeRuleset<TicTacToeState, TicTacToeMove> = {
  game: TIC_TAC_TOE,
  name: 'Tic-Tac-Toe',

  createInitialState(players, first): TicTacToeState {
    return {
      game: TIC_TAC_TOE,
      players,
      currentTurn: first,
      status: 'in_progress',
      winner: null,
      board: Array<TicTacToeCell>(9).fill(null),
    };
  },

  applyMove(state, actor, move): Result<TicTacToeState, MoveError> {
    // Game must still be in progress (Req 6.11: no moves on a terminal board).
    if (state.status !== 'in_progress') {
      return err(invalidMove('Game is already over'));
    }
    // Actor must be a participant and it must be their turn.
    if (actor !== state.players[0] && actor !== state.players[1]) {
      return err(invalidMove('Actor is not a participant'));
    }
    if (actor !== state.currentTurn) {
      return err(invalidMove('Not this player\'s turn'));
    }
    // Move must be a well-formed placement into a valid, empty cell.
    if (!isPlaceMove(move)) {
      return err(invalidMove('Unrecognized move'));
    }
    const { cell } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      return err(invalidMove('Cell index out of range'));
    }
    if (state.board[cell] !== null) {
      return err(invalidMove('Cell is already occupied'));
    }

    // Valid move: produce a fresh board without mutating the input (Req 6.4).
    const board = state.board.slice();
    board[cell] = actor;

    const winner = findWinner(board);
    if (winner !== null) {
      return ok({ ...state, board, status: 'won', winner, currentTurn: actor });
    }
    if (board.every((c) => c !== null)) {
      return ok({ ...state, board, status: 'draw', winner: null, currentTurn: actor });
    }
    return ok({
      ...state,
      board,
      currentTurn: opponent(state.players, actor),
    });
  },

  isTerminal(state): boolean {
    return state.status !== 'in_progress';
  },

  outcome(state, recordedAt: Timestamp): GameOutcome | null {
    if (state.status === 'in_progress') return null;
    return {
      kind: 'completed',
      winner: state.winner,
      recordedAt,
    };
  },
};

// Self-register on import so the engine can dispatch to Tic-Tac-Toe.
registerRuleset(ticTacToeRuleset);
