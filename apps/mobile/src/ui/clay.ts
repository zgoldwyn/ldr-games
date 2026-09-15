import type { ViewStyle } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

function hexWithAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  if (!/^[\dA-Fa-f]{6}$/.test(value)) return hex;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Puffy L1 surface: colored lift, top-left light, and bottom-right inner depth. */
export function clayRaisedStyle(tokens: ThemeTokens, compact = false): ViewStyle {
  const distance = compact ? 3 : 6;
  return {
    boxShadow: [
      {
        offsetX: distance,
        offsetY: distance,
        blurRadius: compact ? 10 : 18,
        spreadDistance: 0,
        color: hexWithAlpha(tokens.primaryStrong, compact ? 0.2 : 0.28),
      },
      {
        offsetX: -distance,
        offsetY: -distance,
        blurRadius: compact ? 10 : 18,
        spreadDistance: 0,
        color: 'rgba(255, 255, 255, 0.62)',
      },
      {
        inset: true,
        offsetX: compact ? 2 : 4,
        offsetY: compact ? 2 : 4,
        blurRadius: compact ? 5 : 8,
        spreadDistance: 0,
        color: 'rgba(255, 255, 255, 0.52)',
      },
      {
        inset: true,
        offsetX: compact ? -3 : -6,
        offsetY: compact ? -3 : -6,
        blurRadius: compact ? 7 : 12,
        spreadDistance: 0,
        color: hexWithAlpha(tokens.primaryStrong, compact ? 0.16 : 0.24),
      },
    ],
    elevation: compact ? 2 : 5,
  };
}

/** A clay control while pressed: the depth collapses as the surface squishes. */
export function clayPressedStyle(tokens: ThemeTokens): ViewStyle {
  return {
    boxShadow: [
      {
        offsetX: 3,
        offsetY: 3,
        blurRadius: 10,
        spreadDistance: 0,
        color: hexWithAlpha(tokens.primaryStrong, 0.24),
      },
      {
        inset: true,
        offsetX: 2,
        offsetY: 2,
        blurRadius: 6,
        spreadDistance: 0,
        color: 'rgba(255, 255, 255, 0.38)',
      },
      {
        inset: true,
        offsetX: -3,
        offsetY: -3,
        blurRadius: 8,
        spreadDistance: 0,
        color: hexWithAlpha(tokens.primaryStrong, 0.25),
      },
    ],
    elevation: 1,
  };
}

/** Recessed well for fields and other editable surfaces. */
export function clayInsetStyle(tokens: ThemeTokens): ViewStyle {
  return {
    boxShadow: [
      {
        inset: true,
        offsetX: 3,
        offsetY: 3,
        blurRadius: 8,
        spreadDistance: 0,
        color: hexWithAlpha(tokens.primaryStrong, 0.18),
      },
      {
        inset: true,
        offsetX: -3,
        offsetY: -3,
        blurRadius: 8,
        spreadDistance: 0,
        color: 'rgba(255, 255, 255, 0.72)',
      },
    ],
  };
}
