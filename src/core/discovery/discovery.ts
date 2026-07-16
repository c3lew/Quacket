/**
 * Model & effort discovery.
 *
 * Enumerate, never hardcode. Both CLIs expose a real machine-readable catalog,
 * so the happy path asks them. Everything below that is degradation, and every
 * rung of it obeys one rule: never offer a model we have not verified exists.
 *
 *   1. Enumerate            control protocol / app-server. Version-gated.
 *   2. Curated + probed     aliases only, each proved by a real invocation.
 *   3. CLI default          models: [] — pass no model flag at all. Always works.
 *
 * Effort levels come out of rung 1 only, and are PER-MODEL. Rungs 2 and 3 leave
 * `efforts: []`, which means "omit --effort, hide the picker" — not "no effort".
 */

import type { FileStore } from '../files.ts';
import type { ProcessRunner } from '../runner.ts';
import { ProviderError, type ProviderCapabilities, type ProviderId } from '../types.ts';
import { readCache, writeCache } from './cache.ts';
import { CLAUDE_MIN_VERSION, enumerateClaude, probeCuratedClaudeModels } from './claude.ts';
import { CODEX_MIN_VERSION, enumerateCodex } from './codex.ts';

export { CACHE_TTL_MS, cachePath } from './cache.ts';

export interface DiscoverOptions {
  runner: ProcessRunner;
  /** The filesystem, injected for the same reason `runner` is — see `files.ts`. */
  files: FileStore;
  /** Directory the discovery cache file lives in. Never settings.json's job. */
  baseDir: string;
  /**
   * Skip the cache and re-enumerate. The caller fires this for the triggers only
   * it can observe: app start, an auth change, and a refine invocation that
   * failed on a model/effort error. Version drift and TTL expiry are detected
   * here and need no flag.
   */
  force?: boolean;
  /** Injected clock, so cache expiry is testable without waiting a day. */
  now?: () => number;
}

const LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };
const MIN_VERSION: Record<ProviderId, string> = {
  claude: CLAUDE_MIN_VERSION,
  codex: CODEX_MIN_VERSION,
};

/** `2.1.210 (Claude Code)` / `codex-cli 0.144.4` both yield the dotted triple. */
const parseVersion = (stdout: string): string | undefined => /\d+\.\d+\.\d+/.exec(stdout)?.[0];

const gte = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
};

async function cliVersion(provider: ProviderId, runner: ProcessRunner): Promise<string> {
  const r = await runner.run({ cmd: provider, args: ['--version'], timeoutMs: 10_000 });
  if (r.timedOut) {
    throw new ProviderError('timeout', `${LABEL[provider]} didn't respond.`);
  }
  const version = r.exitCode === 0 ? parseVersion(r.stdout) : undefined;
  if (!version) {
    throw new ProviderError(
      'provider_error',
      `${LABEL[provider]} isn't installed, or didn't report a version.`,
      r.stderr || r.stdout,
    );
  }
  return version;
}

/**
 * `cacheable` is false when the offering is what we fell back to under a broken
 * probe rather than what we actually learned. Both are `models: []` and both are
 * a working rung 3, but caching the second would let one transient failure hide
 * every model for the full 24h TTL.
 */
interface Discovered {
  capabilities: ProviderCapabilities;
  cacheable: boolean;
}

async function enumerateOrFallback(
  provider: ProviderId,
  runner: ProcessRunner,
  version: string,
): Promise<Discovered> {
  // Version-gate: below the version enumeration was verified against, degrade
  // explicitly rather than trust a surface that may not exist yet.
  if (gte(version, MIN_VERSION[provider])) {
    try {
      const capabilities =
        provider === 'claude'
          ? await enumerateClaude(runner, version)
          : await enumerateCodex(runner, version);
      return { capabilities, cacheable: true };
    } catch (err) {
      // Logged out is an ANSWER, not an enumeration failure. Falling back would
      // tell the user "using CLI default" when the truthful fix is "log in" —
      // and rung 3 only works on an authenticated CLI anyway.
      if (err instanceof ProviderError && err.kind === 'not_authenticated') throw err;
    }
  }

  // Codex has no curated rung: its only stable alias IS the CLI's own configured
  // default, which rung 3 already delivers by passing no -m at all.
  if (provider !== 'claude') {
    return {
      capabilities: { provider, cliVersion: version, account: null, models: [] },
      cacheable: true,
    };
  }

  try {
    const models = await probeCuratedClaudeModels(runner);
    return {
      capabilities: { provider, cliVersion: version, account: null, models },
      cacheable: true,
    };
  } catch (err) {
    // Same rule as rung 1: logged out is an answer, not a failure to degrade past.
    if (err instanceof ProviderError && err.kind === 'not_authenticated') throw err;
    // The probe proved nothing, so we know of no model we may offer. Rung 3 (let
    // the CLI pick) is still true and still works — but don't cache a conclusion
    // we never actually reached.
    return {
      capabilities: { provider, cliVersion: version, account: null, models: [] },
      cacheable: false,
    };
  }
}

/**
 * The offering for `provider` right now: which models this account can actually
 * reach, and which effort levels each of those models takes.
 *
 * `models: []` is a real, working answer, not an error — it means "pass no model
 * flag and let the CLI pick". Only `not_authenticated` and a dead CLI throw.
 */
export async function discover(
  provider: ProviderId,
  opts: DiscoverOptions,
): Promise<ProviderCapabilities> {
  const now = (opts.now ?? Date.now)();

  // Cheap (<0.5s) and load-bearing twice over: it version-gates enumeration, and
  // it is the cache key component we can check without spending a spawn on the
  // catalog itself.
  const version = await cliVersion(provider, opts.runner);

  if (!opts.force) {
    const cached = await readCache(opts.files, opts.baseDir, provider, now);
    if (cached && cached.cliVersion === version) return cached;
  }

  const { capabilities, cacheable } = await enumerateOrFallback(provider, opts.runner, version);
  if (cacheable) await writeCache(opts.files, opts.baseDir, provider, capabilities, now);
  return capabilities;
}
