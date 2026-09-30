import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ELEMENTAL_AUTHORED_LEVELS } from '@ldr/core';

import { PLATFORMER_CATALOG_FINGERPRINT } from './constants.js';

const PROGRESS_VERSION = 1;
const progressFile = fileURLToPath(new URL('../../data/platformer-progress.json', import.meta.url));

interface ProgressFile {
  readonly version: number;
  readonly catalogFingerprint: string;
  readonly byPairingHash: Record<string, { readonly level: number; readonly updatedAt: string }>;
}

let writeQueue = Promise.resolve();

function pairingHash(pairingId: string): string {
  return createHash('sha256').update(pairingId, 'utf8').digest('hex');
}

function emptyProgress(): ProgressFile {
  return {
    version: PROGRESS_VERSION,
    catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
    byPairingHash: {},
  };
}

async function readProgress(): Promise<ProgressFile> {
  try {
    const parsed = JSON.parse(await readFile(progressFile, 'utf8')) as ProgressFile;
    if (
      parsed.version === PROGRESS_VERSION &&
      parsed.catalogFingerprint === PLATFORMER_CATALOG_FINGERPRINT &&
      parsed.byPairingHash &&
      typeof parsed.byPairingHash === 'object'
    )
      return parsed;
  } catch {
    // Missing, malformed, or stale progress starts at the first current level.
  }
  return emptyProgress();
}

function validLevel(level: number): number {
  return Number.isInteger(level) && level >= 1 && level <= ELEMENTAL_AUTHORED_LEVELS.length
    ? level
    : 1;
}

export async function loadPairingProgress(pairingId: string): Promise<number> {
  const progress = await readProgress();
  return validLevel(progress.byPairingHash[pairingHash(pairingId)]?.level ?? 1);
}

/** Server-authoritative, monotonic progress. Raw pairing identifiers are never written to disk. */
export function savePairingProgress(pairingId: string, requestedLevel: number): Promise<void> {
  const level = validLevel(requestedLevel);
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const progress = await readProgress();
      const key = pairingHash(pairingId);
      const current = validLevel(progress.byPairingHash[key]?.level ?? 1);
      if (level <= current) return;
      const next: ProgressFile = {
        ...progress,
        byPairingHash: {
          ...progress.byPairingHash,
          [key]: { level, updatedAt: new Date().toISOString() },
        },
      };
      await mkdir(dirname(progressFile), { recursive: true, mode: 0o700 });
      const temporary = `${progressFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, progressFile);
      await chmod(progressFile, 0o600);
    });
  return writeQueue;
}
