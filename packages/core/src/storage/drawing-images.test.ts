import { describe, expect, it } from 'vitest';

import { pairingId as toPairingId, sessionId as toSessionId } from '../domain/common.js';
import { isErr, isOk } from '../result.js';
import {
  ALLOWED_DRAWING_CONTENT_TYPES,
  buildDrawingObjectKey,
  drawingSessionPrefix,
  MAX_DRAWING_BYTES,
  parseDrawingObjectKey,
  validateDrawingImageRef,
  validateDrawingUpload,
} from './drawing-images.js';

// Unit tests for the drawing object-key rules (Req 7.3).
//
// These are security tests, not naming tests: Storage RLS authorizes on the FIRST
// path segment, so anything that lets a key escape `{pairingId}/` defeats the
// pairing scope.

const PAIRING = toPairingId('11111111-1111-4111-8111-111111111111');
const OTHER_PAIRING = toPairingId('22222222-2222-4222-8222-222222222222');
const SESSION = toSessionId('33333333-3333-4333-8333-333333333333');
const OTHER_SESSION = toSessionId('44444444-4444-4444-8444-444444444444');

describe('buildDrawingObjectKey', () => {
  it('puts the pairing id first, because Storage RLS authorizes on it', () => {
    const key = buildDrawingObjectKey({
      pairingId: PAIRING,
      sessionId: SESSION,
      imageId: 'abc123',
      contentType: 'image/png',
    });
    expect(isOk(key)).toBe(true);
    if (!isOk(key)) return;
    expect(key.value).toBe(`${PAIRING}/${SESSION}/abc123.png`);
    // The predicate is (storage.foldername(name))[1] = current_pairing(...).
    expect(key.value.split('/')[0]).toBe(PAIRING);
  });

  it('maps each accepted content type to an extension', () => {
    const extensions = ALLOWED_DRAWING_CONTENT_TYPES.map((contentType) => {
      const key = buildDrawingObjectKey({
        pairingId: PAIRING,
        sessionId: SESSION,
        imageId: 'img',
        contentType,
      });
      return isOk(key) ? key.value.split('.').pop() : null;
    });
    expect(extensions).toEqual(['png', 'jpg', 'webp']);
  });

  it('rejects a content type outside the allow-list', () => {
    // SVG is excluded deliberately: it would mean serving attacker-authored
    // markup from the app's own origin.
    for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf', '']) {
      const key = buildDrawingObjectKey({
        pairingId: PAIRING,
        sessionId: SESSION,
        imageId: 'img',
        contentType,
      });
      expect(isErr(key), contentType).toBe(true);
    }
  });

  it('refuses an image id that could climb out of the pairing folder', () => {
    for (const imageId of ['..', '.', 'a/b', '../../etc/passwd', '', 'has space', 'q?x']) {
      const key = buildDrawingObjectKey({
        pairingId: PAIRING,
        sessionId: SESSION,
        imageId,
        contentType: 'image/png',
      });
      expect(isErr(key), JSON.stringify(imageId)).toBe(true);
    }
  });
});

describe('parseDrawingObjectKey', () => {
  it('round-trips a built key', () => {
    const key = buildDrawingObjectKey({
      pairingId: PAIRING,
      sessionId: SESSION,
      imageId: 'abc',
      contentType: 'image/webp',
    });
    if (!isOk(key)) throw new Error('expected ok');

    const parsed = parseDrawingObjectKey(key.value);
    expect(parsed).toEqual({
      pairingId: PAIRING,
      sessionId: SESSION,
      fileName: 'abc.webp',
    });
  });

  it('rejects keys that do not match the layout', () => {
    const bad = [
      '', // empty
      'only-one-segment',
      `${PAIRING}/${SESSION}`, // missing file
      `${PAIRING}/${SESSION}/a/b.png`, // too deep
      `${PAIRING}/${SESSION}/noextension`,
      `/${PAIRING}/${SESSION}/a.png`, // leading slash shifts segment 1 to ''
      `../${SESSION}/a.png`,
    ];
    for (const key of bad) {
      expect(parseDrawingObjectKey(key), key).toBeNull();
    }
  });
});

describe('validateDrawingImageRef', () => {
  const ref = `${PAIRING}/${SESSION}/img.png`;

  it('accepts a reference inside the pairing and session', () => {
    expect(isOk(validateDrawingImageRef({ imageRef: ref, pairingId: PAIRING }))).toBe(true);
    expect(
      isOk(validateDrawingImageRef({ imageRef: ref, pairingId: PAIRING, sessionId: SESSION })),
    ).toBe(true);
  });

  it("rejects another pairing's reference", () => {
    // The point of this check: Storage RLS would already refuse to serve the
    // bytes, but without this the broken ref would be persisted into the gallery.
    const result = validateDrawingImageRef({ imageRef: ref, pairingId: OTHER_PAIRING });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVALID_TURN');
  });

  it("rejects another session's reference when a session is given", () => {
    const result = validateDrawingImageRef({
      imageRef: ref,
      pairingId: PAIRING,
      sessionId: OTHER_SESSION,
    });
    expect(isErr(result)).toBe(true);
  });

  it('rejects a traversal attempt that would land in another pairing', () => {
    const result = validateDrawingImageRef({
      imageRef: `${PAIRING}/../${OTHER_PAIRING}/img.png`,
      pairingId: PAIRING,
    });
    expect(isErr(result)).toBe(true);
  });
});

describe('validateDrawingUpload', () => {
  it('accepts an allowed type within the size cap', () => {
    expect(
      isOk(validateDrawingUpload({ contentType: 'image/png', byteLength: 1_024 })),
    ).toBe(true);
    // Exactly at the cap is allowed; one byte over is not.
    expect(
      isOk(validateDrawingUpload({ contentType: 'image/png', byteLength: MAX_DRAWING_BYTES })),
    ).toBe(true);
    expect(
      isErr(validateDrawingUpload({ contentType: 'image/png', byteLength: MAX_DRAWING_BYTES + 1 })),
    ).toBe(true);
  });

  it('rejects an empty upload and a disallowed type', () => {
    expect(isErr(validateDrawingUpload({ contentType: 'image/png', byteLength: 0 }))).toBe(true);
    expect(
      isErr(validateDrawingUpload({ contentType: 'image/gif', byteLength: 100 })),
    ).toBe(true);
  });
});

describe('drawingSessionPrefix', () => {
  it('is the pairing/session prefix a gallery listing uses', () => {
    expect(drawingSessionPrefix(PAIRING, SESSION)).toBe(`${PAIRING}/${SESSION}`);
  });
});
