/**
 * Object-key rules for drawing-game images in the private `drawings` Storage
 * bucket (Requirement 7.3).
 *
 * This module is PURE: it builds, parses and validates object keys. No Storage
 * calls, no clock, no randomness beyond an injected id. That matters because the
 * key layout is a SECURITY boundary, not a naming convenience — the Storage RLS
 * policies from migration 20260826062549 authorize on the first path segment:
 *
 *     (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
 *
 * So an object stored at `{pairingId}/...` is readable and writable by exactly
 * the two CURRENT partners of that pairing, and by nobody else. On dissolution
 * `current_pairing()` becomes NULL and former partners immediately lose access
 * to the image bytes (Req 4.4). Getting the first segment wrong does not produce
 * a broken filename — it produces an object nobody can read, or worse, an
 * attempt to write into another pairing's namespace.
 *
 * `DrawingState.imageRef` (see `domain/async-drawing.ts`) holds one of these
 * object keys, deliberately NOT a URL: the bucket is private, so reads go
 * through short-lived signed URLs that would be stale the moment they were
 * persisted into game state.
 */
import { ERROR_CODES, type AsyncError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { PairingId, SessionId } from '../domain/common.js';

/** The private bucket holding drawing-game images. */
export const DRAWINGS_BUCKET = 'drawings';

/**
 * Content types accepted for a drawing. Restricted to still raster images: the
 * bucket is served to both shells, and allowing SVG would mean serving
 * attacker-authored markup from the app's own origin.
 */
export const ALLOWED_DRAWING_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** File extension used for each accepted content type. */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Largest drawing accepted, in bytes. A drawing is a hand-made sketch, not a
 * photo library; capping it keeps one partner from filling the pairing's storage.
 */
export const MAX_DRAWING_BYTES = 5 * 1024 * 1024;

/** The parts of a parsed drawing object key. */
export interface DrawingObjectKey {
  readonly pairingId: string;
  readonly sessionId: string;
  readonly fileName: string;
}

/** Signed-URL lifetime for reading a drawing (seconds). */
export const DRAWING_URL_TTL_SECONDS = 60 * 60;

function asyncError(code: AsyncError['code'], message: string, details?: Record<string, unknown>): AsyncError {
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Build the object key for a new drawing.
 *
 * Layout is `{pairingId}/{sessionId}/{imageId}.{ext}`:
 *   - `pairingId` FIRST, because that is the segment Storage RLS authorizes on.
 *   - `sessionId` next, so a session's gallery can be listed with one prefix and
 *     removed as a unit when the session is cleaned up.
 *   - an opaque `imageId` last, so file names never encode user content and two
 *     uploads can never collide.
 *
 * `imageId` is injected rather than generated here to keep the function pure and
 * its output assertable.
 */
export function buildDrawingObjectKey(params: {
  readonly pairingId: PairingId;
  readonly sessionId: SessionId;
  readonly imageId: string;
  readonly contentType: string;
}): Result<string, AsyncError> {
  const extension = EXTENSION_BY_CONTENT_TYPE[params.contentType];
  if (extension === undefined) {
    return err(
      asyncError(
        ERROR_CODES.INVALID_TURN,
        `Unsupported drawing content type "${params.contentType}".`,
        { allowed: ALLOWED_DRAWING_CONTENT_TYPES },
      ),
    );
  }
  if (!isSafeSegment(params.imageId)) {
    return err(
      asyncError(ERROR_CODES.INVALID_TURN, 'The image id contains unsupported characters.'),
    );
  }
  return ok(`${params.pairingId}/${params.sessionId}/${params.imageId}.${extension}`);
}

/**
 * A path segment safe to embed in an object key: no separators, no traversal, no
 * empty string. Rejecting `.` and `..` and any `/` is what stops a crafted id
 * from climbing out of the pairing folder and defeating the RLS predicate.
 */
function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 128) return false;
  if (segment === '.' || segment === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}

/**
 * Parse an object key back into its parts, or `null` when it does not match the
 * expected layout. Used to validate an `imageRef` supplied by a client before it
 * is trusted.
 */
export function parseDrawingObjectKey(key: string): DrawingObjectKey | null {
  const segments = key.split('/');
  if (segments.length !== 3) return null;
  const [pairingId, sessionId, fileName] = segments as [string, string, string];
  if (![pairingId, sessionId].every(isSafeSegment)) return null;
  // The file name additionally carries an extension, which isSafeSegment allows.
  if (!isSafeSegment(fileName)) return null;
  if (!fileName.includes('.')) return null;
  return { pairingId, sessionId, fileName };
}

/**
 * Validate that an `imageRef` from a client refers to an image inside the given
 * pairing (and, when supplied, the given session).
 *
 * Storage RLS already prevents READING another pairing's object, so a foreign
 * reference could not leak bytes. This check exists for a different reason: it
 * stops a foreign or malformed reference from being PERSISTED into
 * `DrawingState.imageRef`, where it would become a permanently broken image in
 * the gallery that no partner can ever load.
 */
export function validateDrawingImageRef(params: {
  readonly imageRef: string;
  readonly pairingId: PairingId;
  readonly sessionId?: SessionId;
}): Result<DrawingObjectKey, AsyncError> {
  const parsed = parseDrawingObjectKey(params.imageRef);
  if (parsed === null) {
    return err(
      asyncError(ERROR_CODES.INVALID_TURN, 'The image reference is not a valid drawing object key.', {
        imageRef: params.imageRef,
      }),
    );
  }
  if (parsed.pairingId !== params.pairingId) {
    return err(
      asyncError(
        ERROR_CODES.INVALID_TURN,
        'The image reference belongs to a different pairing.',
      ),
    );
  }
  if (params.sessionId !== undefined && parsed.sessionId !== params.sessionId) {
    return err(
      asyncError(
        ERROR_CODES.INVALID_TURN,
        'The image reference belongs to a different session.',
      ),
    );
  }
  return ok(parsed);
}

/** Validate an upload's declared content type and byte length. */
export function validateDrawingUpload(params: {
  readonly contentType: string;
  readonly byteLength: number;
}): Result<void, AsyncError> {
  if (!ALLOWED_DRAWING_CONTENT_TYPES.includes(params.contentType)) {
    return err(
      asyncError(ERROR_CODES.INVALID_TURN, `Unsupported drawing content type "${params.contentType}".`, {
        allowed: ALLOWED_DRAWING_CONTENT_TYPES,
      }),
    );
  }
  if (params.byteLength <= 0) {
    return err(asyncError(ERROR_CODES.INVALID_TURN, 'The drawing is empty.'));
  }
  if (params.byteLength > MAX_DRAWING_BYTES) {
    return err(
      asyncError(ERROR_CODES.INVALID_TURN, 'The drawing exceeds the maximum allowed size.', {
        maxBytes: MAX_DRAWING_BYTES,
        byteLength: params.byteLength,
      }),
    );
  }
  return ok(undefined);
}

/** The storage prefix holding every image contributed to one session. */
export function drawingSessionPrefix(pairingId: PairingId, sessionId: SessionId): string {
  return `${pairingId}/${sessionId}`;
}
