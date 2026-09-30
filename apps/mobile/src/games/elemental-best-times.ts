import {
  elementalCatalogFingerprint,
  elementalLevelFingerprint,
  type ElementalLevel,
} from '@ldr/core';

import type { StringStore } from '../session/string-store';

const STORAGE_VERSION = 1;

export type ElementalBestTimes = Record<string, { fingerprint: string; ticks: number }>;

type StoredRecords = {
  version: number;
  catalogFingerprint: string;
  bestByLevel: ElementalBestTimes;
};

function storageKey(pairingId: string): string {
  return `ember-tide-best-times:${pairingId}`;
}

function emptyRecords(): StoredRecords {
  return {
    version: STORAGE_VERSION,
    catalogFingerprint: elementalCatalogFingerprint(),
    bestByLevel: {},
  };
}

async function readRecords(kv: StringStore, pairingId: string): Promise<StoredRecords> {
  const raw = await kv.getItem(storageKey(pairingId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredRecords;
      if (
        parsed.version === STORAGE_VERSION &&
        parsed.catalogFingerprint === elementalCatalogFingerprint() &&
        parsed.bestByLevel &&
        typeof parsed.bestByLevel === 'object'
      ) {
        return parsed;
      }
    } catch {
      // Damaged local records are discarded below.
    }
  }
  const fresh = emptyRecords();
  if (raw) await kv.setItem(storageKey(pairingId), JSON.stringify(fresh));
  return fresh;
}

/** Stored for the current pairing; editing any authored level clears every older record. */
export async function loadElementalBestTimes(
  kv: StringStore,
  pairingId: string,
): Promise<ElementalBestTimes> {
  return (await readRecords(kv, pairingId)).bestByLevel;
}

/** Lower server tick counts are faster. Returns the latest records for display. */
export async function recordElementalBestTime(
  kv: StringStore,
  pairingId: string,
  level: ElementalLevel,
  elapsedTicks: number,
): Promise<ElementalBestTimes> {
  const records = await readRecords(kv, pairingId);
  const fingerprint = elementalLevelFingerprint(level);
  const old = records.bestByLevel[level.id];
  if (
    !Number.isSafeInteger(elapsedTicks) ||
    elapsedTicks <= 0 ||
    (old?.fingerprint === fingerprint &&
      Number.isSafeInteger(old.ticks) &&
      old.ticks > 0 &&
      old.ticks <= elapsedTicks)
  ) {
    return records.bestByLevel;
  }
  records.bestByLevel[level.id] = { fingerprint, ticks: elapsedTicks };
  await kv.setItem(storageKey(pairingId), JSON.stringify(records));
  return records.bestByLevel;
}

export function bestTicksForLevel(
  records: ElementalBestTimes,
  level: ElementalLevel,
): number | null {
  const record = records[level.id];
  return record?.fingerprint === elementalLevelFingerprint(level) &&
    Number.isSafeInteger(record.ticks) &&
    record.ticks > 0
    ? record.ticks
    : null;
}
