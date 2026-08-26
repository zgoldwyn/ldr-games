/**
 * Drawing-game ruleset for the asynchronous turn engine (Requirements 7.4, 7.5,
 * 7.7, 7.8).
 *
 * The drawing game is a gentle collaborative gallery: partners take turns
 * adding a drawing to a shared, ordered collection. Each turn the active turn
 * holder submits a reference to an image plus an optional caption. Only the
 * metadata and turn ordering are modeled here — the actual image bytes are
 * uploaded to pairing-scoped Storage in a later task (16.2). The engine simply
 * tracks each drawing's Storage reference so the turn history stays pure and
 * deterministic.
 *
 * A game with a `maxRounds` cap reaches a terminal (non-competitive, no-winner)
 * state once that many drawings have been contributed; an open-ended gallery
 * (`maxRounds` omitted) never terminates from the ruleset and continues until
 * the pairing dissolves (Requirement 7.11).
 */
import type { AccountId, GameId } from './common.js';
import { gameId } from './common.js';
import type { AsyncGameDef } from './game.js';
import type {
  AsyncEngineState,
  AsyncRuleset,
  RulesetApplyResult,
} from './async-engine.js';

/** Maximum caption length accepted for a drawing turn. */
export const DRAWING_CAPTION_MAX_LENGTH = 280;

/**
 * One contributed drawing. `imageRef` is an opaque Storage reference (bucket
 * key) whose bytes are uploaded separately (task 16.2); the engine only tracks
 * the reference and its metadata.
 */
export interface DrawingEntry {
  readonly artist: AccountId;
  readonly imageRef: string;
  readonly caption?: string;
}

/** Drawing-game ruleset state: the ordered gallery and an optional round cap. */
export interface DrawingState {
  readonly kind: 'drawing';
  readonly drawings: readonly DrawingEntry[];
  readonly maxRounds?: number;
}

/** A drawing turn: contribute one image reference with an optional caption. */
export interface DrawingAction {
  readonly kind: 'drawing.submit';
  readonly imageRef: string;
  readonly caption?: string;
}

/** Catalog entry id for the drawing asynchronous game (Requirement 7.1). */
export const DRAWING_GAME_ID: GameId = gameId('drawing-game');

/** Catalog entry for the drawing asynchronous game (Requirement 7.1). */
export const DRAWING_GAME_DEF: AsyncGameDef = {
  id: DRAWING_GAME_ID,
  name: 'Drawing Game',
};

/**
 * The drawing-game ruleset: validates and applies one drawing contribution for
 * the active turn holder. Returns `null` when the turn is invalid (wrong action
 * shape, blank image reference, over-long caption, or the gallery is already
 * full) so the engine can reject it as `INVALID_TURN` (Requirement 7.8). On a
 * valid turn it appends the drawing and reports whether the round cap has been
 * reached.
 */
export const drawingRuleset: AsyncRuleset<DrawingState, DrawingAction> = {
  kind: 'drawing',
  def: DRAWING_GAME_DEF,

  applyAction(
    state: DrawingState,
    actor: AccountId,
    _opponent: AccountId,
    action: DrawingAction,
  ): RulesetApplyResult<DrawingState> | null {
    if (action === null || typeof action !== 'object') return null;
    if (action.kind !== 'drawing.submit') return null;

    if (typeof action.imageRef !== 'string' || action.imageRef.trim() === '') {
      return null;
    }
    if (action.caption !== undefined) {
      if (
        typeof action.caption !== 'string' ||
        action.caption.length > DRAWING_CAPTION_MAX_LENGTH
      ) {
        return null;
      }
    }

    // Reject once the gallery is already full for a capped game.
    if (state.maxRounds !== undefined && state.drawings.length >= state.maxRounds) {
      return null;
    }

    const entry: DrawingEntry =
      action.caption !== undefined
        ? { artist: actor, imageRef: action.imageRef, caption: action.caption }
        : { artist: actor, imageRef: action.imageRef };
    const drawings = [...state.drawings, entry];

    const nextState: DrawingState = { ...state, drawings };
    const terminal =
      state.maxRounds !== undefined && drawings.length >= state.maxRounds;

    return { rulesetState: nextState, terminal, winner: null };
  },
};

/**
 * Build the initial engine state for a drawing game. `firstHolder` is the
 * partner who draws first (defaults to the first player), designated as the
 * initial Active_Turn_Holder per the game's rules (Requirement 7.2). Omit
 * `maxRounds` for an open-ended gallery that never terminates from inactivity.
 */
export function createDrawingGame(params: {
  readonly players: readonly [AccountId, AccountId];
  readonly firstHolder?: AccountId;
  readonly maxRounds?: number;
}): AsyncEngineState {
  const { players } = params;
  const firstHolder = params.firstHolder ?? players[0];
  return {
    gameId: DRAWING_GAME_ID,
    players,
    activeTurnHolder: firstHolder,
    status: 'active',
    winner: null,
    turns: [],
    ruleset:
      params.maxRounds !== undefined
        ? { kind: 'drawing', drawings: [], maxRounds: params.maxRounds }
        : { kind: 'drawing', drawings: [] },
  };
}
