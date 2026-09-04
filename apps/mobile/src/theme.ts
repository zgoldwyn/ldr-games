/**
 * Bridge from the shared `@ldr/core` tokens to React Navigation's theme
 * (Requirement 5.1).
 *
 * React Navigation insists on its own `Theme` object for the pieces it renders
 * itself — headers, card backgrounds, the back-button tint. Without this bridge
 * those would keep React Navigation's stock blue-on-white while the rest of the
 * app rendered the pastel palette, so the chrome and the content would disagree.
 *
 * Per the theme steering doc, nothing here invents a colour: every value is a
 * semantic token, so switching the active colour option re-themes the navigation
 * chrome along with everything else.
 */
import { DefaultTheme } from '@react-navigation/native';
import type { Theme } from '@react-navigation/native';
import { getThemeTokens } from '@ldr/core';
import type { ColorOptionName, ThemeTokens } from '@ldr/core';

/** The token set for the active colour option. */
export function themeTokens(option?: ColorOptionName): ThemeTokens {
  return getThemeTokens(option);
}

/** Map core tokens onto the object React Navigation renders its chrome from. */
export function navigationTheme(tokens: ThemeTokens): Theme {
  return {
    ...DefaultTheme,
    dark: false,
    colors: {
      primary: tokens.primary,
      background: tokens.background,
      card: tokens.surface,
      text: tokens.textPrimary,
      border: tokens.border,
      // Badge counts (Req 11.1) are the only consumer today; `accent` keeps them
      // inside the pastel family rather than React Navigation's stock red.
      notification: tokens.accent,
    },
  };
}
