import { describe, expect, it } from 'vitest';
import {
  COLOR_OPTIONS,
  DEFAULT_COLOR_OPTION,
  getThemeTokens,
  type ColorOptionName,
} from './tokens.js';

describe('theme tokens', () => {
  function luminance(hex: string): number {
    const channels = hex
      .slice(1)
      .match(/../g)!
      .map((value) => Number.parseInt(value, 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  }

  function contrast(a: string, b: string): number {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

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

  it('meets WCAG AA contrast for text and essential component boundaries', () => {
    for (const option of Object.values(COLOR_OPTIONS)) {
      const tokens = option.light;
      expect(
        contrast(tokens.textPrimary, tokens.background),
        `${option.name} primary text`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens.textSecondary, tokens.background),
        `${option.name} secondary text`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens.textMuted, tokens.background),
        `${option.name} muted text`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens.error, tokens.background),
        `${option.name} error text`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens.onPrimary, tokens.primary),
        `${option.name} button text`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens.border, tokens.surface),
        `${option.name} component boundary`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
