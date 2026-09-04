import { describe, expect, it } from 'vitest';

import { accountId } from '@ldr/core';

import { markForCell } from './tic-tac-toe-view';

const A = accountId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = accountId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

describe('markForCell', () => {
  it('maps the first player to X and the second to O', () => {
    expect(markForCell(A, [A, B])).toBe('X');
    expect(markForCell(B, [A, B])).toBe('O');
    expect(markForCell(null, [A, B])).toBe('');
  });
});
