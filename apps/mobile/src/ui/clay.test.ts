import { describe, expect, it } from 'vitest';
import { getThemeTokens } from '@ldr/core';

import { clayInsetStyle, clayPressedStyle, clayRaisedStyle } from './clay';

describe('clay surface recipes', () => {
  const tokens = getThemeTokens('lavender');

  it('combines colored lift with top-left light and inset depth', () => {
    const shadows = clayRaisedStyle(tokens).boxShadow;

    expect(Array.isArray(shadows)).toBe(true);
    expect(shadows).toHaveLength(4);
    expect(shadows?.[0]).toMatchObject({ offsetX: 6, offsetY: 6, blurRadius: 18 });
    expect(shadows?.[1]).toMatchObject({ offsetX: -6, offsetY: -6, blurRadius: 18 });
    expect(shadows?.[2]).toMatchObject({ inset: true, offsetX: 4, offsetY: 4 });
    expect(shadows?.[3]).toMatchObject({ inset: true, offsetX: -6, offsetY: -6 });
  });

  it('collapses depth for pressed controls and recesses inputs', () => {
    expect(clayPressedStyle(tokens).boxShadow).toHaveLength(3);
    expect(clayInsetStyle(tokens).boxShadow).toHaveLength(2);
    expect(clayInsetStyle(tokens).boxShadow?.every((shadow) => shadow.inset)).toBe(true);
  });
});
