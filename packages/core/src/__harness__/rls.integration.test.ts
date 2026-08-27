import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createPairing,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  dissolvePairing,
  getIntegrationConfig,
  signIn,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for the RLS + Storage policies from migration
// 20260826062549 (task 2.3) against the schema from tasks 2.1/2.2.
//
// These run through TWO authenticated test users on a live Supabase stack and
// assert the authorization boundaries required by:
//   - Requirement 4.4 (pairing-scoped access; former partner loses access on
//     dissolution; individual data retained)
//   - Requirement 8.4 (a partner's quiz self-answers are withheld during the
//     self-answer phase and revealed afterward)
//   - Storage RLS blocks cross-pairing access to drawing images.
//
// The suite is GATED: it skips itself unless SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are present in the environment (see
// getIntegrationConfig). This keeps it green where no local stack is available
// while running end to end wherever a stack URL + keys are provided.

const cfg = getIntegrationConfig();

describe.skipIf(cfg === null)('RLS + Storage policies (integration)', () => {
  // Inside the (non-skipped) block cfg is guaranteed non-null. The service
  // client is created in beforeAll (not at collection time) so the skipped-suite
  // path never dereferences a null config.
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;

  // Pairing 1 (a1 + a2): primary pairing used for positive reads, quiz, storage.
  let a1: TestAccount;
  let a2: TestAccount;
  let pairing1: string;
  // Pairing 2 (b1 + b2): the "other" pairing used for cross-pairing isolation.
  let b1: TestAccount;
  let b2: TestAccount;
  // Pairing 3 (c1 + c2): dedicated to the dissolution test.
  let c1: TestAccount;
  let c2: TestAccount;
  let pairing3: string;

  // Seeded pairing-scoped rows.
  let dateP1Id: string;
  let dateP3Id: string;
  let quizId: string;
  let quizSessionId: string;

  // Authenticated (RLS-scoped) clients.
  let clientA1: SupabaseClient; // member of pairing 1
  let clientA2: SupabaseClient; // member of pairing 1 (a1's partner)
  let clientB1: SupabaseClient; // member of pairing 2 (outsider to pairing 1)
  let clientC1: SupabaseClient; // member of pairing 3

  const drawingPath = () => `${pairing1}/drawing.png`;

  beforeAll(async () => {
    admin = createServiceClient(config);

    // --- accounts + pairings -------------------------------------------------
    [a1, a2, b1, b2, c1, c2] = await Promise.all([
      createTestAccount(admin),
      createTestAccount(admin),
      createTestAccount(admin),
      createTestAccount(admin),
      createTestAccount(admin),
      createTestAccount(admin),
    ]);

    pairing1 = await createPairing(admin, a1.id, a2.id);
    await createPairing(admin, b1.id, b2.id); // pairing 2 (isolation outsider)
    pairing3 = await createPairing(admin, c1.id, c2.id);

    // --- relationship dates (pairing-scoped) --------------------------------
    const dateP1 = await admin
      .from('relationship_dates')
      .insert({ pairing_id: pairing1, title: 'Anniversary', date: '2020-06-15' })
      .select('id')
      .single();
    if (dateP1.error || !dateP1.data) {
      throw new Error(`seed date P1 failed: ${dateP1.error?.message ?? 'no row'}`);
    }
    dateP1Id = dateP1.data.id as string;

    const dateP3 = await admin
      .from('relationship_dates')
      .insert({ pairing_id: pairing3, title: 'First Call', date: '2021-01-01' })
      .select('id')
      .single();
    if (dateP3.error || !dateP3.data) {
      throw new Error(`seed date P3 failed: ${dateP3.error?.message ?? 'no row'}`);
    }
    dateP3Id = dateP3.data.id as string;

    // --- quiz catalog + session + self-answers (pairing 1) ------------------
    const quizDef = await admin.from('quiz_defs').insert({ theme: 'Test' }).select('id').single();
    if (quizDef.error || !quizDef.data) {
      throw new Error(`seed quiz_def failed: ${quizDef.error?.message ?? 'no row'}`);
    }
    quizId = quizDef.data.id as string;

    const question = await admin
      .from('quiz_questions')
      .insert({
        quiz_id: quizId,
        type: 'multiple_choice',
        prompt: 'Favourite colour?',
        choices: ['red', 'green', 'blue'],
      })
      .select('id')
      .single();
    if (question.error || !question.data) {
      throw new Error(`seed quiz_question failed: ${question.error?.message ?? 'no row'}`);
    }
    const questionId = question.data.id as string;

    const quizSession = await admin
      .from('quiz_sessions')
      .insert({ pairing_id: pairing1, quiz_id: quizId, phase: 'self_answer' })
      .select('id')
      .single();
    if (quizSession.error || !quizSession.data) {
      throw new Error(`seed quiz_session failed: ${quizSession.error?.message ?? 'no row'}`);
    }
    quizSessionId = quizSession.data.id as string;

    const selfAnswers = await admin.from('quiz_self_answers').insert([
      {
        session_id: quizSessionId,
        account_id: a1.id,
        question_id: questionId,
        answer: { kind: 'choice', value: 'red' },
      },
      {
        session_id: quizSessionId,
        account_id: a2.id,
        question_id: questionId,
        answer: { kind: 'choice', value: 'blue' },
      },
    ]);
    if (selfAnswers.error) {
      throw new Error(`seed quiz_self_answers failed: ${selfAnswers.error.message}`);
    }

    // --- storage: private drawing under pairing 1's folder ------------------
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await admin.storage
      .from('drawings')
      .upload(`${pairing1}/drawing.png`, png, { contentType: 'image/png', upsert: true });
    if (upload.error) {
      throw new Error(`seed storage upload failed: ${upload.error.message}`);
    }

    // --- authenticated clients ----------------------------------------------
    [clientA1, clientA2, clientB1, clientC1] = await Promise.all([
      signIn(config, a1),
      signIn(config, a2),
      signIn(config, b1),
      signIn(config, c1),
    ]);
  }, 60_000);

  afterAll(async () => {
    // Deleting the auth users cascades to accounts -> pairings -> pairing-scoped
    // rows (dates, quiz sessions, self-answers). Global catalog rows and the
    // storage object are removed explicitly. Teardown is best-effort.
    try {
      await admin.storage.from('drawings').remove([`${pairing1}/drawing.png`]);
    } catch {
      /* ignore */
    }
    for (const acc of [a1, a2, b1, b2, c1, c2]) {
      if (acc) {
        try {
          await deleteTestAccount(admin, acc.id);
        } catch {
          /* ignore */
        }
      }
    }
    if (quizId) {
      try {
        // quiz_questions cascade from quiz_defs; quiz_sessions were removed with
        // the pairing cascade above, so the def is now unreferenced.
        await admin.from('quiz_defs').delete().eq('id', quizId);
      } catch {
        /* ignore */
      }
    }
  }, 60_000);

  // Req 4.4 — pairing scope: an outsider cannot read another pairing's rows.
  it('cross-pairing rows are unreadable by an outside pairing', async () => {
    // Positive control: a member of pairing 1 can read pairing 1's date.
    const owner = await clientA1.from('relationship_dates').select('id, pairing_id');
    expect(owner.error).toBeNull();
    const ownerIds = (owner.data ?? []).map((r) => r.id as string);
    expect(ownerIds).toContain(dateP1Id);
    for (const row of owner.data ?? []) {
      expect(row.pairing_id).toBe(pairing1);
    }

    // Isolation: a member of pairing 2 sees none of pairing 1's rows.
    const outsider = await clientB1.from('relationship_dates').select('id, pairing_id');
    expect(outsider.error).toBeNull();
    const outsiderIds = (outsider.data ?? []).map((r) => r.id as string);
    expect(outsiderIds).not.toContain(dateP1Id);
    for (const row of outsider.data ?? []) {
      expect(row.pairing_id).not.toBe(pairing1);
    }

    // Even a direct, filtered fetch of the specific row returns nothing.
    const targeted = await clientB1
      .from('relationship_dates')
      .select('id')
      .eq('id', dateP1Id);
    expect(targeted.error).toBeNull();
    expect(targeted.data ?? []).toHaveLength(0);
  });

  // Req 4.4 — a former partner loses access to pairing-owned data on dissolution.
  it('a former partner loses pairing-data access after dissolution', async () => {
    // Before dissolution: c1 can read pairing 3's date.
    const before = await clientC1.from('relationship_dates').select('id').eq('id', dateP3Id);
    expect(before.error).toBeNull();
    expect((before.data ?? []).map((r) => r.id as string)).toContain(dateP3Id);

    // Dissolve pairing 3 (clears both members' pairing_id).
    await dissolvePairing(admin, pairing3, [c1.id, c2.id]);

    // After dissolution: current_pairing(c1) is NULL, so the row is unreachable.
    const after = await clientC1.from('relationship_dates').select('id').eq('id', dateP3Id);
    expect(after.error).toBeNull();
    expect(after.data ?? []).toHaveLength(0);

    // Individual data is retained: the account row itself still exists (Req 4.4).
    const self = await clientC1.from('accounts').select('id, pairing_id').eq('id', c1.id).single();
    expect(self.error).toBeNull();
    expect(self.data?.id).toBe(c1.id);
    expect(self.data?.pairing_id).toBeNull();
  });

  // Req 8.4 — self-answers are withheld from the partner during the self-answer
  // phase and become selectable once the session advances past it.
  it('withholds partner self-answers during self-answer phase, reveals them afterward', async () => {
    // Ensure the session is in the self-answer phase for this assertion.
    const reset = await admin
      .from('quiz_sessions')
      .update({ phase: 'self_answer' })
      .eq('id', quizSessionId);
    expect(reset.error).toBeNull();

    // a2 (partner) cannot see a1's self-answer during the self-answer phase,
    // but does see their own row.
    const withheld = await clientA2
      .from('quiz_self_answers')
      .select('account_id')
      .eq('session_id', quizSessionId);
    expect(withheld.error).toBeNull();
    const withheldOwners = (withheld.data ?? []).map((r) => r.account_id as string);
    expect(withheldOwners).not.toContain(a1.id);
    expect(withheldOwners).toContain(a2.id);

    // Advance the session past the self-answer phase.
    const advance = await admin
      .from('quiz_sessions')
      .update({ phase: 'guessing' })
      .eq('id', quizSessionId);
    expect(advance.error).toBeNull();

    // Now a2 can see a1's self-answer.
    const revealed = await clientA2
      .from('quiz_self_answers')
      .select('account_id')
      .eq('session_id', quizSessionId);
    expect(revealed.error).toBeNull();
    const revealedOwners = (revealed.data ?? []).map((r) => r.account_id as string);
    expect(revealedOwners).toContain(a1.id);
    expect(revealedOwners).toContain(a2.id);
  });

  // Storage RLS — cross-pairing access to a private drawing image is blocked
  // while the owning pairing's member can read it.
  it('Storage blocks cross-pairing access to drawing images', async () => {
    // Owner (pairing 1) can download the image.
    const owner = await clientA1.storage.from('drawings').download(drawingPath());
    expect(owner.error).toBeNull();
    expect(owner.data).not.toBeNull();

    // Outsider (pairing 2) is denied.
    const outsider = await clientB1.storage.from('drawings').download(drawingPath());
    expect(outsider.data).toBeNull();
    expect(outsider.error).not.toBeNull();

    // Listing the owning pairing's folder returns nothing for the outsider.
    const listing = await clientB1.storage.from('drawings').list(pairing1);
    expect(listing.data ?? []).toHaveLength(0);
  });
});
