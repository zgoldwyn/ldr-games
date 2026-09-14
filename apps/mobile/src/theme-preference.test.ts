import { describe, expect, it, vi } from 'vitest';

import { loadThemePreference, saveThemePreference, THEME_PREFERENCE_KEY } from './theme-preference';

describe('theme preference', () => {
  it('restores a valid palette and falls back safely for stale values', async () => {
    const store = {
      getItem: vi.fn().mockResolvedValueOnce('mint').mockResolvedValueOnce('neon'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    await expect(loadThemePreference(store)).resolves.toBe('mint');
    await expect(loadThemePreference(store)).resolves.toBe('pink');
  });

  it('persists the selected named palette', async () => {
    const store = {
      getItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn(),
    };
    await saveThemePreference(store, 'sky');
    expect(store.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_KEY, 'sky');
  });
});
