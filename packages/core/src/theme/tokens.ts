/**
 * Theme design tokens for the LDR Companion App.
 *
 * The theme is swappable via a single active color option. Components reference
 * colors by semantic role (token name) only — never by raw hex value — so that
 * both platform shells (mobile Expo, desktop Electron/web) render an identical
 * experience (Requirement 5.1) and the palette can be changed in one place.
 */

/** Semantic color roles. Components consume these names, not raw hues. */
export interface ThemeTokens {
  /** App canvas (lightest tint). */
  background: string;
  /** Cards, sheets, list rows (slightly elevated from background). */
  surface: string;
  /** Secondary / inactive surfaces. */
  surfaceMuted: string;
  /** Main accent (the selected color option's core pastel). */
  primary: string;
  /** Pressed / active state, small emphasis (a step deeper than primary). */
  primaryStrong: string;
  /** Text / icons on top of primary. */
  onPrimary: string;
  /** Secondary highlight, used sparingly. */
  accent: string;
  /** Main text (soft near-black, never pure #000). */
  textPrimary: string;
  /** Supporting text. */
  textSecondary: string;
  /** Hints, placeholders, timestamps. */
  textMuted: string;
  /** Hairline dividers and outlines (low contrast). */
  border: string;
  /** Status: success (kept in the pastel family). */
  success: string;
  /** Status: warning (kept in the pastel family). */
  warning: string;
  /** Status: error (kept in the pastel family). */
  error: string;
  /** Soft, low-opacity shadow color. */
  shadow: string;
}

/** The set of named color options a user can pick from in settings. */
export type ColorOptionName = 'pink' | 'lavender' | 'mint' | 'sky' | 'butter';

/** A color option carries its display name and its light (primary) token set. */
export interface ColorOption {
  name: ColorOptionName;
  label: string;
  light: ThemeTokens;
}

/** Default color option applied when a user has not chosen one. */
export const DEFAULT_COLOR_OPTION: ColorOptionName = 'pink';

export const COLOR_OPTIONS: Record<ColorOptionName, ColorOption> = {
  pink: {
    name: 'pink',
    label: 'Pink',
    light: {
      background: '#FFF6F8',
      surface: '#FFFFFF',
      surfaceMuted: '#FDEFF3',
      primary: '#F7B8CC',
      primaryStrong: '#E896B2',
      onPrimary: '#5A2A3A',
      accent: '#F6C9B8',
      textPrimary: '#3A2A31',
      textSecondary: '#7A6670',
      textMuted: '#B29CA6',
      border: '#F3E1E8',
      success: '#AED9C0',
      warning: '#F5D9A8',
      error: '#EBA9A9',
      shadow: 'rgba(233, 150, 178, 0.18)',
    },
  },
  lavender: {
    name: 'lavender',
    label: 'Lavender',
    light: {
      background: '#F8F6FD',
      surface: '#FFFFFF',
      surfaceMuted: '#F0ECFA',
      primary: '#C9BCEB',
      primaryStrong: '#A995DE',
      onPrimary: '#33285A',
      accent: '#BFD3F2',
      textPrimary: '#2F2A3A',
      textSecondary: '#6E6780',
      textMuted: '#A69FB8',
      border: '#E7E1F5',
      success: '#AED9C0',
      warning: '#F5D9A8',
      error: '#EBA9A9',
      shadow: 'rgba(169, 149, 222, 0.18)',
    },
  },
  mint: {
    name: 'mint',
    label: 'Mint',
    light: {
      background: '#F4FBF7',
      surface: '#FFFFFF',
      surfaceMuted: '#E8F5EE',
      primary: '#AEE0C6',
      primaryStrong: '#86CBA6',
      onPrimary: '#1F4736',
      accent: '#CDEBDD',
      textPrimary: '#28362F',
      textSecondary: '#5F7269',
      textMuted: '#98AAA1',
      border: '#DCEFE5',
      success: '#AED9C0',
      warning: '#F5D9A8',
      error: '#EBA9A9',
      shadow: 'rgba(134, 203, 166, 0.18)',
    },
  },
  sky: {
    name: 'sky',
    label: 'Sky',
    light: {
      background: '#F4F9FD',
      surface: '#FFFFFF',
      surfaceMuted: '#E8F1FA',
      primary: '#B4D3EE',
      primaryStrong: '#8CB8E0',
      onPrimary: '#1F3A52',
      accent: '#CBE3D9',
      textPrimary: '#293440',
      textSecondary: '#5F6E7C',
      textMuted: '#9AA8B4',
      border: '#DCE9F4',
      success: '#AED9C0',
      warning: '#F5D9A8',
      error: '#EBA9A9',
      shadow: 'rgba(140, 184, 224, 0.18)',
    },
  },
  butter: {
    name: 'butter',
    label: 'Butter',
    light: {
      background: '#FFFBF2',
      surface: '#FFFFFF',
      surfaceMuted: '#FBF2DE',
      primary: '#F3DFA6',
      primaryStrong: '#E6C878',
      onPrimary: '#5A4718',
      accent: '#F5CBB0',
      textPrimary: '#3B3527',
      textSecondary: '#7A7160',
      textMuted: '#B4AB96',
      border: '#F1E6CE',
      success: '#AED9C0',
      warning: '#F5D9A8',
      error: '#EBA9A9',
      shadow: 'rgba(230, 200, 120, 0.18)',
    },
  },
};

/**
 * Resolve the active theme tokens for a given color option. Falls back to the
 * default color option when the provided name is not recognized.
 */
export function getThemeTokens(option: ColorOptionName = DEFAULT_COLOR_OPTION): ThemeTokens {
  return (COLOR_OPTIONS[option] ?? COLOR_OPTIONS[DEFAULT_COLOR_OPTION]).light;
}
