import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { requestAccountDeletion } from './delete-account';

function clientReturning(data: unknown, error: unknown = null) {
  const invoke = vi.fn().mockResolvedValue({ data, error });
  return {
    client: { functions: { invoke } } as unknown as SupabaseClient,
    invoke,
  };
}

describe('requestAccountDeletion', () => {
  it('sends the server-side reconfirmation only from the final action', async () => {
    const { client, invoke } = clientReturning({ deleted: true });

    await expect(requestAccountDeletion(client)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('delete-account', {
      body: { confirmed: true },
    });
  });

  it('does not report completion when the endpoint fails or declines deletion', async () => {
    await expect(
      requestAccountDeletion(clientReturning(null, new Error('offline')).client),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      requestAccountDeletion(clientReturning({ deleted: false }).client),
    ).resolves.toMatchObject({ ok: false });
  });
});
