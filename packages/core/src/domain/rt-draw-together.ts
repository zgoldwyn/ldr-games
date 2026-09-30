/**
 * Draw Together: shared rules and deterministic helpers for the cooperative
 * real-time drawing game.
 *
 * The active answer deliberately does not exist in {@link DrawTogetherState}.
 * That state is serialized to both partners, while the answer belongs in a
 * server-only record and is returned privately to the drawer.
 */
import { err, ok, type Result } from '../result.js';
import type { MoveError } from '../errors.js';
import { gameId, type AccountId, type GameId, type Timestamp } from './common.js';
import type { GameOutcome, Move } from './game.js';
import {
  invalidMove,
  registerRuleset,
  type RealTimeRuleset,
  type RTGameStateBase,
} from './rt-engine.js';

export const DRAW_TOGETHER = 'draw-together';
export const DRAW_TOGETHER_GAME_ID: GameId = gameId(DRAW_TOGETHER);
export const DRAW_TOGETHER_MATCH_SECONDS = [180, 300, 600] as const;
export const DRAW_TOGETHER_DEFAULT_MATCH_SECONDS = 300;
export const DRAW_TOGETHER_TURN_SECONDS = 60;
export const DRAW_TOGETHER_CHOICE_SECONDS = 8;

export type DrawTogetherMatchSeconds = (typeof DRAW_TOGETHER_MATCH_SECONDS)[number];
export type DrawTogetherDifficulty = 'easy' | 'medium' | 'hard';
export type DrawTogetherPhase = 'waiting' | 'choosing' | 'drawing' | 'reveal' | 'finished';

export interface DrawTogetherAttempt {
  readonly turn: number;
  readonly drawer: AccountId;
  readonly word: string;
  readonly difficulty: DrawTogetherDifficulty;
  readonly result: 'solved' | 'missed';
  readonly elapsedMs: number;
  readonly points: number;
  readonly thumbnailRef?: string;
}

/** Public state readable by both partners. Never add the active answer here. */
export interface DrawTogetherState extends RTGameStateBase {
  readonly game: typeof DRAW_TOGETHER;
  readonly phase: DrawTogetherPhase;
  readonly drawer: AccountId;
  readonly guesser: AccountId;
  readonly score: number;
  readonly solvedCount: number;
  readonly turn: number;
  readonly matchDurationSeconds: DrawTogetherMatchSeconds;
  readonly matchStartedAt: Timestamp | null;
  readonly matchEndsAt: Timestamp | null;
  readonly choiceEndsAt: Timestamp | null;
  readonly turnStartedAt: Timestamp | null;
  readonly turnEndsAt: Timestamp | null;
  readonly activeDifficulty: DrawTogetherDifficulty | null;
  readonly maskedWordPattern: string | null;
  /** Kept so sessions created before word-pattern hints still render safely. */
  readonly maskedWordLength: number | null;
  readonly attempts: readonly DrawTogetherAttempt[];
}

/** A choice returned only to the drawer. */
export interface DrawTogetherWordChoice {
  readonly id: string;
  readonly word: string;
  readonly difficulty: DrawTogetherDifficulty;
}

/** Server-only active-word record. It must never be merged into public state. */
export interface DrawTogetherSecret {
  readonly choiceId: string;
  readonly word: string;
  readonly normalizedWord: string;
  readonly difficulty: DrawTogetherDifficulty;
}

const DIFFICULTY_MULTIPLIER: Record<DrawTogetherDifficulty, number> = {
  easy: 1,
  medium: 1.25,
  hard: 1.5,
};

export function isDrawTogetherMatchSeconds(value: number): value is DrawTogetherMatchSeconds {
  return DRAW_TOGETHER_MATCH_SECONDS.some((seconds) => seconds === value);
}

/** Whole shared points for a correct answer, using server-observed time. */
export function drawTogetherPoints(
  remainingMs: number,
  difficulty: DrawTogetherDifficulty,
): number {
  const capped = Math.max(0, Math.min(DRAW_TOGETHER_TURN_SECONDS * 1_000, remainingMs));
  const speedPoints = Math.floor((100 * capped) / (DRAW_TOGETHER_TURN_SECONDS * 1_000));
  return Math.round((100 + speedPoints) * DIFFICULTY_MULTIPLIER[difficulty]);
}

/** Display-only remaining time derived from an authoritative deadline. */
export function drawTogetherRemainingMs(deadline: Timestamp | null, now: Timestamp): number {
  return deadline === null ? 0 : Math.max(0, deadline - now);
}

/**
 * Display the shared drawing budget. Word selection pauses that budget, while
 * its own short choice deadline continues independently.
 */
export function drawTogetherMatchRemainingMs(
  state: DrawTogetherState | null,
  now: Timestamp,
): number {
  if (state?.matchEndsAt === null || state?.matchEndsAt === undefined) return 0;
  if (state.phase === 'choosing' && state.choiceEndsAt !== null) {
    const choiceStartedAt = state.choiceEndsAt - DRAW_TOGETHER_CHOICE_SECONDS * 1_000;
    return Math.max(0, state.matchEndsAt - choiceStartedAt);
  }
  return drawTogetherRemainingMs(state.matchEndsAt, now);
}

function singularizeToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (
    token.length > 4 &&
    (token.endsWith('ches') ||
      token.endsWith('shes') ||
      token.endsWith('xes') ||
      token.endsWith('zes') ||
      token.endsWith('sses'))
  ) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Normalize case, accents, punctuation, spacing, and simple plurals. */
export function normalizeDrawTogetherGuess(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularizeToken)
    .join(' ');
}

export function isCorrectDrawTogetherGuess(guess: string, answer: string): boolean {
  const normalizedGuess = normalizeDrawTogetherGuess(guess);
  return normalizedGuess.length > 0 && normalizedGuess === normalizeDrawTogetherGuess(answer);
}

/** Reveal only word and character structure: `fire truck` becomes `____ _____`. */
export function drawTogetherWordMask(word: string): string {
  return word
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      [...part].map((character) => (/^[\p{L}\p{N}]$/u.test(character) ? '_' : character)).join(''),
    )
    .join(' ');
}

export function otherDrawTogetherPlayer(
  players: readonly [AccountId, AccountId],
  player: AccountId,
): AccountId {
  return players[0] === player ? players[1] : players[0];
}

export function createDrawTogetherState(
  players: readonly [AccountId, AccountId],
  firstDrawer: AccountId,
  matchDurationSeconds: DrawTogetherMatchSeconds = DRAW_TOGETHER_DEFAULT_MATCH_SECONDS,
): DrawTogetherState {
  return {
    game: DRAW_TOGETHER,
    players,
    currentTurn: firstDrawer,
    status: 'in_progress',
    winner: null,
    phase: 'waiting',
    drawer: firstDrawer,
    guesser: otherDrawTogetherPlayer(players, firstDrawer),
    score: 0,
    solvedCount: 0,
    turn: 0,
    matchDurationSeconds,
    matchStartedAt: null,
    matchEndsAt: null,
    choiceEndsAt: null,
    turnStartedAt: null,
    turnEndsAt: null,
    activeDifficulty: null,
    maskedWordPattern: null,
    maskedWordLength: null,
    attempts: [],
  };
}

export function startDrawTogetherMatch(
  state: DrawTogetherState,
  duration: DrawTogetherMatchSeconds,
  now: Timestamp,
): Result<DrawTogetherState, MoveError> {
  if (state.phase !== 'waiting') return err(invalidMove('This match has already started.'));
  return ok({
    ...state,
    phase: 'choosing',
    matchDurationSeconds: duration,
    matchStartedAt: now,
    matchEndsAt: now + duration * 1_000,
    choiceEndsAt: now + DRAW_TOGETHER_CHOICE_SECONDS * 1_000,
  });
}

export function beginDrawTogetherTurn(
  state: DrawTogetherState,
  difficulty: DrawTogetherDifficulty,
  maskedWordPattern: string,
  now: Timestamp,
): Result<DrawTogetherState, MoveError> {
  if (state.phase !== 'choosing' || state.matchEndsAt === null) {
    return err(invalidMove('A word cannot be chosen right now.'));
  }
  const choiceStartedAt =
    state.choiceEndsAt === null ? now : state.choiceEndsAt - DRAW_TOGETHER_CHOICE_SECONDS * 1_000;
  const pausedForMs = Math.max(0, now - choiceStartedAt);
  const resumedMatchEndsAt = state.matchEndsAt + pausedForMs;
  return ok({
    ...state,
    phase: 'drawing',
    matchEndsAt: resumedMatchEndsAt,
    choiceEndsAt: null,
    turnStartedAt: now,
    turnEndsAt: Math.min(now + DRAW_TOGETHER_TURN_SECONDS * 1_000, resumedMatchEndsAt),
    activeDifficulty: difficulty,
    maskedWordPattern,
    maskedWordLength: Math.max(1, [...maskedWordPattern].filter((char) => char === '_').length),
  });
}

export function finishDrawTogetherMatch(state: DrawTogetherState): DrawTogetherState {
  return {
    ...state,
    phase: 'finished',
    status: 'draw',
    winner: null,
    choiceEndsAt: null,
    turnStartedAt: null,
    turnEndsAt: null,
    activeDifficulty: null,
    maskedWordPattern: null,
    maskedWordLength: null,
  };
}

/** Record a solved or missed selected word and hand drawing to the partner. */
export function completeDrawTogetherTurn(
  state: DrawTogetherState,
  params: {
    readonly word: string;
    readonly difficulty: DrawTogetherDifficulty;
    readonly solved: boolean;
    readonly now: Timestamp;
    readonly thumbnailRef?: string;
  },
): Result<DrawTogetherState, MoveError> {
  if (
    state.phase !== 'drawing' ||
    state.turnStartedAt === null ||
    state.turnEndsAt === null ||
    state.matchEndsAt === null
  ) {
    return err(invalidMove('There is no active drawing to complete.'));
  }

  const elapsedMs = Math.max(
    0,
    Math.min(DRAW_TOGETHER_TURN_SECONDS * 1_000, params.now - state.turnStartedAt),
  );
  const points = params.solved
    ? drawTogetherPoints(Math.max(0, state.turnEndsAt - params.now), params.difficulty)
    : 0;
  const attempt: DrawTogetherAttempt = {
    turn: state.turn,
    drawer: state.drawer,
    word: params.word,
    difficulty: params.difficulty,
    result: params.solved ? 'solved' : 'missed',
    elapsedMs,
    points,
    ...(params.thumbnailRef === undefined ? {} : { thumbnailRef: params.thumbnailRef }),
  };
  const nextDrawer = state.guesser;
  const next: DrawTogetherState = {
    ...state,
    phase: 'choosing',
    currentTurn: nextDrawer,
    drawer: nextDrawer,
    guesser: state.drawer,
    score: state.score + points,
    solvedCount: state.solvedCount + (params.solved ? 1 : 0),
    turn: state.turn + 1,
    choiceEndsAt: params.now + DRAW_TOGETHER_CHOICE_SECONDS * 1_000,
    turnStartedAt: null,
    turnEndsAt: null,
    activeDifficulty: null,
    maskedWordPattern: null,
    maskedWordLength: null,
    attempts: [...state.attempts, attempt],
  };
  return ok(params.now >= state.matchEndsAt ? finishDrawTogetherMatch(next) : next);
}

/**
 * Draw Together actions use a dedicated server endpoint because generic move
 * state is shared with both players and therefore cannot safely carry a word.
 */
export const drawTogetherRuleset: RealTimeRuleset<DrawTogetherState, Move> = {
  game: DRAW_TOGETHER,
  name: 'Draw Together',

  createInitialState(players, firstDrawer) {
    return createDrawTogetherState(players, firstDrawer);
  },

  applyMove(_state, _actor, _move): Result<DrawTogetherState, MoveError> {
    return err(invalidMove('Draw Together actions use the private game endpoint.'));
  },

  isTerminal(state): boolean {
    return state.phase === 'finished';
  },

  outcome(state, recordedAt): GameOutcome | null {
    if (state.phase !== 'finished') return null;
    return { kind: 'completed', winner: null, recordedAt };
  },
};

registerRuleset(drawTogetherRuleset);

/** Narrow a public game-state payload without ever accepting an embedded word. */
export function isDrawTogetherState(value: unknown): value is DrawTogetherState {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Partial<DrawTogetherState> & { readonly word?: unknown };
  return (
    state.game === DRAW_TOGETHER &&
    state.word === undefined &&
    Array.isArray(state.players) &&
    state.players.length === 2 &&
    typeof state.drawer === 'string' &&
    typeof state.guesser === 'string' &&
    typeof state.score === 'number' &&
    typeof state.turn === 'number' &&
    typeof state.phase === 'string'
  );
}

/** Validate a chosen duration at an API boundary. */
export function parseDrawTogetherMatchSeconds(
  value: unknown,
): Result<DrawTogetherMatchSeconds, MoveError> {
  if (typeof value === 'number' && isDrawTogetherMatchSeconds(value)) return ok(value);
  return err(invalidMove('Match duration must be 3, 5, or 10 minutes.'));
}
