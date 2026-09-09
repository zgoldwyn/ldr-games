#!/usr/bin/env node
/* global console, process */

/**
 * One-time hosted setup for App Review's two-person workflow.
 *
 * Required environment:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Passwords are generated in memory and saved only to the current user's macOS
 * Keychain. They are never printed or written into the repository.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}
if (process.platform !== 'darwin') {
  throw new Error('This setup stores credentials in the macOS Keychain.');
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = randomUUID().slice(0, 8);
const reviewers = [
  {
    label: 'Partner A',
    email: `app-review-a-${suffix}@example.test`,
    password: `Aa1!${randomBytes(24).toString('base64url')}`,
    keychainService: 'LDR Companion App Review Partner A',
  },
  {
    label: 'Partner B',
    email: `app-review-b-${suffix}@example.test`,
    password: `Aa1!${randomBytes(24).toString('base64url')}`,
    keychainService: 'LDR Companion App Review Partner B',
  },
];

const createdIds = [];

try {
  for (const reviewer of reviewers) {
    const { data, error } = await admin.auth.admin.createUser({
      email: reviewer.email,
      password: reviewer.password,
      email_confirm: true,
      app_metadata: { epoch: 0, app_review_demo: true },
    });
    if (error || !data.user) {
      throw new Error(`${reviewer.label} Auth creation failed: ${error?.message ?? 'no user'}`);
    }

    const accountId = data.user.id;
    createdIds.push(accountId);
    const { error: accountError } = await admin.from('accounts').insert({ id: accountId });
    if (accountError) throw accountError;
    const { error: sessionError } = await admin
      .from('account_session')
      .insert({ account_id: accountId, epoch: 0 });
    if (sessionError) throw sessionError;
  }

  const { data: pairing, error: pairingError } = await admin
    .from('pairings')
    .insert({ member_a: createdIds[0], member_b: createdIds[1], status: 'active' })
    .select('id')
    .single();
  if (pairingError || !pairing) throw pairingError ?? new Error('Pairing creation failed.');

  const { error: accountUpdateError } = await admin
    .from('accounts')
    .update({ pairing_id: pairing.id })
    .in('id', createdIds);
  if (accountUpdateError) throw accountUpdateError;

  for (const reviewer of reviewers) {
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-a',
      reviewer.email,
      '-s',
      reviewer.keychainService,
      '-w',
      reviewer.password,
    ]);
  }

  for (const reviewer of reviewers) {
    console.log(`${reviewer.label}: ${reviewer.email}`);
    console.log(`  Password: macOS Keychain service “${reviewer.keychainService}”`);
  }
} catch (error) {
  for (const id of createdIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  throw error;
}
