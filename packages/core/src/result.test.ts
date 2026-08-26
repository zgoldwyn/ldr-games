import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, type Result } from './result.js';

describe('Result', () => {
  it('ok() wraps a value in the Ok branch', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it('err() wraps an error in the Err branch', () => {
    const r = err('boom');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });

  it('isOk narrows to the Ok branch and isErr is its complement', () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err('nope');

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);

    if (isOk(success)) {
      // type narrowed to Ok<number>
      expect(success.value).toBe(1);
    }
    if (isErr(failure)) {
      // type narrowed to Err<string>
      expect(failure.error).toBe('nope');
    }
  });
});
