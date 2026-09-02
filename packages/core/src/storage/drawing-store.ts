/**
 * Upload and read drawing-game images in the private `drawings` bucket
 * (Requirement 7.3).
 *
 * Thin adapter over `supabase-js` Storage. Every authorization decision is made
 * by Storage RLS (migration 20260826062549), which authorizes on the first path
 * segment of the object key — so the KEY LAYOUT is the security mechanism and it
 * is owned by the pure `drawing-images.ts` module. This file only performs I/O
 * and maps failures onto the shared error vocabulary.
 *
 * Reads return a short-lived SIGNED URL rather than a public one: the bucket is
 * private precisely so that image bytes are reachable only by the two current
 * partners, and a signed URL keeps that true without proxying bytes through the
 * app. The URL is generated on demand and never persisted — `DrawingState`
 * stores the durable object key instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { PairingId, SessionId } from '../domain/common.js';
import { ERROR_CODES, type AsyncError } from '../errors.js';
import { err, isErr, ok, type Result } from '../result.js';
import {
  buildDrawingObjectKey,
  DRAWING_URL_TTL_SECONDS,
  DRAWINGS_BUCKET,
  drawingSessionPrefix,
  validateDrawingImageRef,
  validateDrawingUpload,
} from './drawing-images.js';

/** Bytes accepted for upload; both shells can produce one of these. */
export type DrawingBytes = ArrayBuffer | Uint8Array | Blob;

/** A stored drawing: the durable object key plus a URL to read it right now. */
export interface StoredDrawing {
  /** Durable object key — this is what goes into `DrawingState.imageRef`. */
  readonly imageRef: string;
  /** Short-lived signed URL for immediate display. */
  readonly url: string;
  /** When the signed URL stops working (epoch milliseconds). */
  readonly urlExpiresAt: number;
}

/** Client-side surface for drawing images. */
export interface DrawingImageStore {
  /**
   * Upload one drawing for a session and return the reference to persist in the
   * turn's `imageRef`.
   */
  upload(params: {
    readonly pairingId: PairingId;
    readonly sessionId: SessionId;
    readonly imageId: string;
    readonly contentType: string;
    readonly bytes: DrawingBytes;
  }): Promise<Result<StoredDrawing, AsyncError>>;

  /** Signed URL for an existing `imageRef`, validated against the pairing. */
  readUrl(params: {
    readonly imageRef: string;
    readonly pairingId: PairingId;
    readonly ttlSeconds?: number;
  }): Promise<Result<StoredDrawing, AsyncError>>;

  /** Signed URLs for every image in a session's gallery, in listing order. */
  listSession(params: {
    readonly pairingId: PairingId;
    readonly sessionId: SessionId;
  }): Promise<Result<readonly string[], AsyncError>>;
}

function storageError(message: string, details?: Record<string, unknown>): AsyncError {
  return details === undefined
    ? { code: ERROR_CODES.INVALID_TURN, message }
    : { code: ERROR_CODES.INVALID_TURN, message, details };
}

/** Byte length of any accepted upload shape, for the size check. */
function byteLengthOf(bytes: DrawingBytes): number {
  if (bytes instanceof Uint8Array) return bytes.byteLength;
  if (typeof Blob !== 'undefined' && bytes instanceof Blob) return bytes.size;
  return (bytes as ArrayBuffer).byteLength;
}

/**
 * Build a {@link DrawingImageStore} over an authenticated Supabase client.
 *
 * `client` must carry the partner's session: Storage RLS derives the pairing from
 * `auth.uid()`, so an anonymous or service-role client would either be denied or
 * (worse) bypass the pairing scope entirely.
 */
export function createDrawingImageStore(client: SupabaseClient): DrawingImageStore {
  const bucket = () => client.storage.from(DRAWINGS_BUCKET);

  async function sign(
    imageRef: string,
    ttlSeconds: number,
  ): Promise<Result<StoredDrawing, AsyncError>> {
    const { data, error } = await bucket().createSignedUrl(imageRef, ttlSeconds);
    if (error || !data?.signedUrl) {
      // A denial and a missing object are indistinguishable here by design:
      // Storage RLS must not reveal that another pairing's object exists.
      return err(
        storageError('The drawing could not be read.', { imageRef }),
      );
    }
    return ok({
      imageRef,
      url: data.signedUrl,
      urlExpiresAt: Date.now() + ttlSeconds * 1_000,
    });
  }

  return {
    async upload(params): Promise<Result<StoredDrawing, AsyncError>> {
      const size = validateDrawingUpload({
        contentType: params.contentType,
        byteLength: byteLengthOf(params.bytes),
      });
      if (isErr(size)) return size;

      const key = buildDrawingObjectKey({
        pairingId: params.pairingId,
        sessionId: params.sessionId,
        imageId: params.imageId,
        contentType: params.contentType,
      });
      if (isErr(key)) return key;

      const { error } = await bucket().upload(key.value, params.bytes as never, {
        contentType: params.contentType,
        // Never overwrite: object keys carry an opaque id, so a collision means a
        // bug or a replayed request, not an intentional replacement.
        upsert: false,
      });
      if (error) {
        return err(
          storageError('The drawing could not be stored.', { imageRef: key.value }),
        );
      }

      return await sign(key.value, DRAWING_URL_TTL_SECONDS);
    },

    async readUrl(params): Promise<Result<StoredDrawing, AsyncError>> {
      // Validate the reference belongs to this pairing BEFORE asking Storage, so
      // a malformed or foreign ref fails with a precise error rather than an
      // opaque Storage denial.
      const valid = validateDrawingImageRef({
        imageRef: params.imageRef,
        pairingId: params.pairingId,
      });
      if (isErr(valid)) return valid;

      return await sign(params.imageRef, params.ttlSeconds ?? DRAWING_URL_TTL_SECONDS);
    },

    async listSession(params): Promise<Result<readonly string[], AsyncError>> {
      const prefix = drawingSessionPrefix(params.pairingId, params.sessionId);
      const { data, error } = await bucket().list(prefix);
      if (error) {
        return err(storageError('The session gallery could not be listed.', { prefix }));
      }
      return ok((data ?? []).map((entry) => `${prefix}/${entry.name}`));
    },
  };
}
