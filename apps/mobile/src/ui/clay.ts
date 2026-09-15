import type { ViewStyle } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

/** Shared clay depth: detached from the canvas, soft enough to preserve legibility. */
export function clayRaisedStyle(tokens: ThemeTokens, compact = false): ViewStyle {
  return {
    borderColor: tokens.primary,
    borderWidth: 1,
    shadowColor: tokens.shadow,
    shadowOffset: { width: 0, height: compact ? 4 : 8 },
    shadowOpacity: 1,
    shadowRadius: compact ? 8 : 16,
    elevation: compact ? 3 : 6,
  };
}
