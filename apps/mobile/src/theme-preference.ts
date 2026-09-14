import { COLOR_OPTIONS, DEFAULT_COLOR_OPTION, type ColorOptionName } from '@ldr/core';

import type { StringStore } from './session/string-store';

export const THEME_PREFERENCE_KEY = 'ldr.theme.color-option.v1';

export function isColorOptionName(value: unknown): value is ColorOptionName {
  return typeof value === 'string' && Object.hasOwn(COLOR_OPTIONS, value);
}

export async function loadThemePreference(store: StringStore): Promise<ColorOptionName> {
  const saved = await store.getItem(THEME_PREFERENCE_KEY);
  return isColorOptionName(saved) ? saved : DEFAULT_COLOR_OPTION;
}

export async function saveThemePreference(
  store: StringStore,
  option: ColorOptionName,
): Promise<void> {
  await store.setItem(THEME_PREFERENCE_KEY, option);
}
