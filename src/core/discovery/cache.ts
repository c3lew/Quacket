/**
 * The discovery cache: what the provider is CURRENTLY OFFERING.
 *
 * Deliberately its own file, never settings.json. settings.json stores the
 * user's CHOICE (provider/model/effort) and must survive a CLI upgrade, a
 * re-login, or a model being retired. This file stores the offering those
 * choices are picked from, and is disposable by design — every read is allowed
 * to miss, and a corrupt file is simply a miss.
 *
 * One file per provider, so discovering `claude` and `codex` concurrently on app
 * start cannot lose one another's write (a single shared file would be a
 * read-modify-write race).
 */

import { joinPath, type FileStore } from '../files.ts';
import type { ProviderCapabilities, ProviderId } from '../types.ts';

/** TTL backstop, matching the daily refresh codex performs on its own catalog. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SCHEMA = 1;

interface CacheEntry {
  schema: number;
  /** Part of the cache key lives inside `capabilities` (cliVersion, account). */
  fetchedAt: number;
  capabilities: ProviderCapabilities;
}

export const cachePath = (baseDir: string, provider: ProviderId): string =>
  joinPath(baseDir, `discovery-cache.${provider}.json`);

/**
 * null on every failure mode there is: no file, unreadable, corrupt, written by
 * a future schema, or older than the TTL. Discovery re-enumerates on null, so a
 * miss is always safe and never worth throwing over.
 */
export async function readCache(
  files: FileStore,
  baseDir: string,
  provider: ProviderId,
  now: number,
): Promise<ProviderCapabilities | null> {
  let entry: CacheEntry;
  try {
    const text = await files.readText(cachePath(baseDir, provider));
    if (text === null) return null;
    entry = JSON.parse(text) as CacheEntry;
  } catch {
    // Unlike everywhere else, an IO error here is still just a miss: the cache
    // is disposable and re-enumerating is always correct.
    return null;
  }
  if (entry?.schema !== SCHEMA) return null;
  if (typeof entry.fetchedAt !== 'number') return null;
  if (!entry.capabilities || entry.capabilities.provider !== provider) return null;
  if (now - entry.fetchedAt >= CACHE_TTL_MS) return null;
  return entry.capabilities;
}

export async function writeCache(
  files: FileStore,
  baseDir: string,
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  now: number,
): Promise<void> {
  await files.mkdirp(baseDir);
  const entry: CacheEntry = { schema: SCHEMA, fetchedAt: now, capabilities };
  await files.writeText(cachePath(baseDir, provider), JSON.stringify(entry, null, 2));
}
