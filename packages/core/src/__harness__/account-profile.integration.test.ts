import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createPairing,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  getIntegrationConfig,
  signIn,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

const cfg = getIntegrationConfig();

describe.skipIf(cfg === null)('Account profile RLS (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  let self: TestAccount;
  let partner: TestAccount;
  let outsider: TestAccount;
  let selfClient: SupabaseClient;
  let partnerClient: SupabaseClient;
  let outsiderClient: SupabaseClient;

  beforeAll(async () => {
    admin = createServiceClient(config);
    [self, partner, outsider] = await Promise.all([
      createTestAccount(admin),
      createTestAccount(admin),
      createTestAccount(admin),
    ]);
    await createPairing(admin, self.id, partner.id);
    [selfClient, partnerClient, outsiderClient] = await Promise.all([
      signIn(config, self),
      signIn(config, partner),
      signIn(config, outsider),
    ]);
  });

  afterAll(async () => {
    await Promise.all(
      [self?.id, partner?.id, outsider?.id]
        .filter((id): id is string => id !== undefined)
        .map((id) => deleteTestAccount(admin, id).catch(() => undefined)),
    );
  });

  it('lets each account write its own name and lets only the current partner read it', async () => {
    const created = await selfClient
      .from('account_profiles')
      .insert({ account_id: self.id, display_name: 'Alex' });
    expect(created.error).toBeNull();

    const partnerRead = await partnerClient
      .from('account_profiles')
      .select('account_id, display_name')
      .eq('account_id', self.id)
      .maybeSingle();
    expect(partnerRead.error).toBeNull();
    expect(partnerRead.data).toEqual({ account_id: self.id, display_name: 'Alex' });

    const outsiderRead = await outsiderClient
      .from('account_profiles')
      .select('account_id')
      .eq('account_id', self.id);
    expect(outsiderRead.error).toBeNull();
    expect(outsiderRead.data).toEqual([]);

    const partnerOverwrite = await partnerClient
      .from('account_profiles')
      .update({ display_name: 'Not Alex' })
      .eq('account_id', self.id);
    expect(partnerOverwrite.error).toBeNull();

    const unchanged = await selfClient
      .from('account_profiles')
      .select('display_name')
      .eq('account_id', self.id)
      .single();
    expect(unchanged.data?.display_name).toBe('Alex');
  });
});
