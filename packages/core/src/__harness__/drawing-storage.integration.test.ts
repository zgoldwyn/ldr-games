import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { pairingId as toPairingId, sessionId as toSessionId } from '../domain/common.js';
import { isErr, isOk } from '../result.js';
import { createDrawingImageStore } from '../storage/drawing-store.js';
import { DRAWINGS_BUCKET } from '../storage/drawing-images.js';
import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  type FunctionErrorBody,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for drawing-image Storage wiring (task 16.2, Req 7.3).
//
// The bucket and its RLS policies shipped with task 2.3; this suite proves the
// wiring on top of them actually works, and — more importantly — that the pairing
// scope is real: an object stored under `{pairingId}/...` must be unreachable by
// anyone outside that pairing, and must become unreachable to a FORMER partner
// once the pairing dissolves (Req 4.4).
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** A minimal valid PNG (1x1, transparent). */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe.skipIf(cfg === null)('Drawing image Storage (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  async function member(): Promise<{
    account: TestAccount;
    id: string;
    token: string;
    client: SupabaseClient;
  }> {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, id: account.id, token, client };
  }

  async function pair(aToken: string, bToken: string): Promise<string> {
    const inv = await callFunction<{ invitation: { code: string } }>(
      config,
      'create-invitation',
      {},
      aToken,
    );
    expect(inv.status).toBe(201);
    const accepted = await callFunction<{ pairing: { id: string } }>(
      config,
      'accept-invitation',
      { code: inv.body.invitation.code },
      bToken,
    );
    expect(accepted.status).toBe(201);
    return accepted.body.pairing.id;
  }

  beforeAll(async () => {
    admin = createServiceClient(config);
    if (!(await functionsRuntimeReachable(config))) {
      throw new Error(
        'Stack is configured but the Edge Functions runtime is unreachable. ' +
          'Start it with `npm run supabase:functions`.',
      );
    }
    // The bucket is created by migration 20260826062549; fail loudly rather than
    // mysteriously if that ever regresses.
    const { data } = await admin.storage.listBuckets();
    const bucket = (data ?? []).find((b) => b.name === DRAWINGS_BUCKET);
    expect(bucket, `bucket "${DRAWINGS_BUCKET}" is missing`).toBeDefined();
    expect(bucket?.public, 'the drawings bucket must be private').toBe(false);
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  it('uploads a drawing and lets both partners read it (Req 7.3)', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const session = toSessionId(randomUUID());

    const storeA = createDrawingImageStore(a.client);
    const uploaded = await storeA.upload({
      pairingId: toPairingId(pairing),
      sessionId: session,
      imageId: randomUUID(),
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(isOk(uploaded), JSON.stringify(isErr(uploaded) ? uploaded.error : '')).toBe(true);
    if (!isOk(uploaded)) return;

    // The durable reference is an object KEY, not a URL: the bucket is private, so
    // a persisted URL would be stale almost immediately.
    expect(uploaded.value.imageRef.startsWith(`${pairing}/`)).toBe(true);
    expect(uploaded.value.url).toContain('token=');

    // The signed URL actually serves the bytes.
    const fetched = await fetch(uploaded.value.url);
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBe(PNG_BYTES.byteLength);

    // The PARTNER can read it too — it is shared content, scoped to the pairing.
    const storeB = createDrawingImageStore(b.client);
    const partnerRead = await storeB.readUrl({
      imageRef: uploaded.value.imageRef,
      pairingId: toPairingId(pairing),
    });
    expect(isOk(partnerRead)).toBe(true);
    if (isOk(partnerRead)) {
      const partnerFetch = await fetch(partnerRead.value.url);
      expect(partnerFetch.status).toBe(200);
    }

    // And the gallery lists it under the session prefix.
    const listed = await storeB.listSession({
      pairingId: toPairingId(pairing),
      sessionId: session,
    });
    expect(isOk(listed)).toBe(true);
    if (isOk(listed)) expect(listed.value).toContain(uploaded.value.imageRef);
  });

  it('blocks an outside pairing from reading or writing the folder (Req 7.3, 4.4)', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const session = toSessionId(randomUUID());

    const uploaded = await createDrawingImageStore(a.client).upload({
      pairingId: toPairingId(pairing),
      sessionId: session,
      imageId: randomUUID(),
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    if (!isOk(uploaded)) throw new Error('upload failed');

    // A member of a DIFFERENT pairing.
    const outsiderA = await member();
    const outsiderB = await member();
    const outsiderPairing = await pair(outsiderA.token, outsiderB.token);

    // Reading the other pairing's object is refused. Note the outsider has to lie
    // about the pairing id to even get past the client-side check, which is why
    // the server-side RLS assertion below is the one that matters.
    const stolen = await createDrawingImageStore(outsiderA.client)
      .readUrl({ imageRef: uploaded.value.imageRef, pairingId: toPairingId(pairing) });
    expect(isErr(stolen)).toBe(true);

    // Writing INTO the other pairing's folder is refused by Storage RLS, which is
    // the check that cannot be bypassed by a hostile client.
    const forged = await outsiderA.client.storage
      .from(DRAWINGS_BUCKET)
      .upload(`${pairing}/${session}/forged.png`, PNG_BYTES, { contentType: 'image/png' });
    expect(forged.error).not.toBeNull();

    // The outsider can still use their OWN folder, so the policy scopes rather
    // than blanket-denies.
    const own = await createDrawingImageStore(outsiderA.client).upload({
      pairingId: toPairingId(outsiderPairing),
      sessionId: toSessionId(randomUUID()),
      imageId: randomUUID(),
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(isOk(own)).toBe(true);
  });

  it('revokes a former partner after dissolution (Req 4.4)', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const session = toSessionId(randomUUID());

    const uploaded = await createDrawingImageStore(a.client).upload({
      pairingId: toPairingId(pairing),
      sessionId: session,
      imageId: randomUUID(),
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    if (!isOk(uploaded)) throw new Error('upload failed');

    // Readable while paired.
    const before = await createDrawingImageStore(b.client).readUrl({
      imageRef: uploaded.value.imageRef,
      pairingId: toPairingId(pairing),
    });
    expect(isOk(before)).toBe(true);

    const unlinked = await callFunction(config, 'unlink', {}, a.token);
    expect(unlinked.status).toBe(200);

    // After dissolution `current_pairing()` is NULL, so the RLS predicate can no
    // longer match and the image bytes are unreachable to the former partner.
    const after = await createDrawingImageStore(b.client).readUrl({
      imageRef: uploaded.value.imageRef,
      pairingId: toPairingId(pairing),
    });
    expect(isErr(after)).toBe(true);
  });

  it('refuses to persist a foreign image reference in a turn (Req 7.3)', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);

    // Start a real drawing session so there is a turn to take.
    const started = await callFunction<{
      session: { id: string; activeTurnHolder: string };
    }>(config, 'async-start', { gameId: 'drawing-game' }, a.token);
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;
    const holder = started.body.session.activeTurnHolder === a.id ? a : b;

    // An imageRef pointing at somebody else's pairing folder must be rejected
    // BEFORE it lands in the gallery, where it would be permanently unloadable.
    // Uses the CORRECT action shape (`kind: 'drawing.submit'`) so the rejection
    // is attributable to the image reference rather than to a malformed action.
    const foreign = `${randomUUID()}/${sessionId}/sneaky.png`;
    const rejected = await callFunction<FunctionErrorBody>(
      config,
      'async-take-turn',
      { sessionId, action: { kind: 'drawing.submit', imageRef: foreign } },
      holder.token,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe('INVALID_TURN');

    // State unchanged: no turn was recorded.
    const { data } = await admin
      .from('async_sessions')
      .select('game_state, active_turn_holder')
      .eq('id', sessionId)
      .single();
    const turns = (data?.game_state as { turns?: unknown[] })?.turns ?? [];
    expect(turns).toHaveLength(0);
    expect(data?.active_turn_holder).toBe(holder.id);

    // A well-formed reference inside this pairing and session is accepted.
    const uploaded = await createDrawingImageStore(holder.client).upload({
      pairingId: toPairingId(pairing),
      sessionId: toSessionId(sessionId),
      imageId: randomUUID(),
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    if (!isOk(uploaded)) throw new Error('upload failed');

    const accepted = await callFunction<{ session: { activeTurnHolder: string } }>(
      config,
      'async-take-turn',
      {
        sessionId,
        action: { kind: 'drawing.submit', imageRef: uploaded.value.imageRef },
      },
      holder.token,
    );
    expect(accepted.status).toBe(200);
    // The turn transferred, so the reference really was accepted (Req 7.5).
    expect(accepted.body.session.activeTurnHolder).not.toBe(holder.id);
  });
});
