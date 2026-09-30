import { describe, expect, it } from 'vitest';

import { PLATFORMER_PATCH_RATE_MS, PLATFORMER_TICK_RATE } from './constants.js';

describe('platformer network cadence', () => {
  it('delivers authoritative patches at the 30 Hz simulation cadence', () => {
    expect(PLATFORMER_TICK_RATE).toBe(30);
    expect(PLATFORMER_PATCH_RATE_MS).toBe(Math.floor(1_000 / PLATFORMER_TICK_RATE));
  });
});
