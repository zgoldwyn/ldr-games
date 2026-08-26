/**
 * A `Result<T, E>` is a discriminated union representing either a successful
 * value (`Ok<T>`) or a failure (`Err<E>`). It is the return shape used across
 * the shared domain — validation, conflict resolution, the move/turn engines,
 * quiz scoring, and every service module — so that failures are explicit,
 * machine-readable, and never thrown across module boundaries.
 *
 * The discriminant is the literal `ok` field, which narrows the union in a
 * `switch`/`if` and is also checked by the {@link isOk} / {@link isErr} guards.
 */

/** Successful branch of a {@link Result}. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure branch of a {@link Result}. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Either a success carrying a `T` value or a failure carrying an `E` error. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful {@link Result}. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed {@link Result}. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard: narrows a {@link Result} to its {@link Ok} branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard: narrows a {@link Result} to its {@link Err} branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
