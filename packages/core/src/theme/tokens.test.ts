import { describe, expect, it } from 'vitest';
import {
  COLOR_OPTIONS,
  DEFAULT_COLOR_OPTION,
  getThemeTokens,
  type ColorOptionName,
} from './tokens.js';

describe('theme tokens', () => {
  it('defaults to the pink color option', () => {
    expect(DEFAULT_COLOR_OPTION).toBe('pink');
    expect(getThemeTokens()).toEqual(COLOR_OPTIONS.pink.light);
  });

  it('resolves each named color option to a complete token set', () => {
    const requiredTokens = [
      'background',
      'surface',
      'surfaceMuted',
      'primary',
      'primaryStrong',
      'onPrimary',
      'accent',
      'textPrimary',
      'textSecondary',
      'textMuted',
      'border',
      'success',
      'warning',
      'error',
      'shadow',
    ] as const;

    for (const name of Object.keys(COLOR_OPTIONS) as ColorOptionName[]) {
      const tokens = getThemeTokens(name);
      for (const token of requiredTokens) {
        expect(tokens[token], `${name}.${token}`).toBeTruthy();
      }
    }
  });

  it('falls back to the default option for an unknown name', () => {
    const tokens = getThemeTokens('unknown' as ColorOptionName);
    expect(tokens).toEqual(COLOR_OPTIONS[DEFAULT_COLOR_OPTION].light);
  });
});
