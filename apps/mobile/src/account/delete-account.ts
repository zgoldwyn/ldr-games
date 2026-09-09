import type { SupabaseClient } from '@supabase/supabase-js';

export type AccountDeletionResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Invoke the destructive endpoint only from the UI's explicit second step.
 * The literal confirmation is also checked server-side (Req 12.2, 12.8).
 */
export async function requestAccountDeletion(
  client: SupabaseClient,
): Promise<AccountDeletionResult> {
  const { data, error } = await client.functions.invoke('delete-account', {
    body: { confirmed: true },
  });

  if (error !== null || (data as { deleted?: unknown } | null)?.deleted !== true) {
    return {
      ok: false,
      message: 'We could not delete your account. Nothing else was changed; please try again.',
    };
  }

  return { ok: true };
}
