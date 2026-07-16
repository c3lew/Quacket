/**
 * Claude Code enumeration, over the stream-json control protocol.
 *
 * There is no `claude list-models`. The machine-readable surface is the control
 * protocol the Agent SDK's `supportedModels()` uses: spawn, write one
 * `initialize` control_request, read the control_response, kill. No prompt is
 * ever sent, so no tokens are spent.
 *
 * The response carries `account` alongside `models`, so this single spawn IS the
 * auth check — there is no separate `claude auth status` probe.
 */

import type { ProcResult, ProcessRunner } from '../runner.ts';
import { ProviderError, type ModelInfo, type ProviderCapabilities } from '../types.ts';

/**
 * The oldest version the control protocol has actually been verified against
 * (docs/research/model-effort-discovery.md, 2026-07-16). Below this we do not
 * trust enumeration and degrade explicitly rather than guess.
 */
export const CLAUDE_MIN_VERSION = '2.1.210';

const REQUEST_ID = 'quacket-init';

/** Verified argv. `--verbose` is required for stream-json output to be emitted. */
const INITIALIZE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];

interface RawModel {
  value?: string;
  displayName?: string;
  /** Absent entirely on models that take no effort flag (e.g. haiku). */
  supportedEffortLevels?: string[];
}

interface RawAccount {
  email?: string;
  subscriptionType?: string;
}

interface ControlLine {
  type?: string;
  response?: {
    subtype?: string;
    request_id?: string;
    response?: { models?: RawModel[]; account?: RawAccount };
  };
}

const parse = <T>(line: string): T | null => {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
};

/**
 * Models available depend on the plan, so plan is part of the identity — a Max
 * user dropping to Pro must invalidate the cache exactly like a re-login does.
 */
export const claudeAccountId = (a: RawAccount | undefined): string | null =>
  a?.email ? `${a.email}/${a.subscriptionType ?? 'unknown'}` : null;

const toModelInfo = (m: RawModel): ModelInfo => ({
  id: m.value as string,
  label: m.displayName ?? (m.value as string),
  // Per-model, never per-provider: haiku reports no levels at all.
  efforts: m.supportedEffortLevels ?? [],
});

export async function enumerateClaude(
  runner: ProcessRunner,
  cliVersion: string,
): Promise<ProviderCapabilities> {
  const session = runner.session({ cmd: 'claude', args: INITIALIZE_ARGS, timeoutMs: 30_000 });

  let payload: { models?: RawModel[]; account?: RawAccount } | undefined;
  try {
    session.write(
      JSON.stringify({
        type: 'control_request',
        request_id: REQUEST_ID,
        request: { subtype: 'initialize' },
      }),
    );

    for await (const line of session.lines()) {
      const msg = parse<ControlLine>(line);
      // SessionStart hooks stream `system` events ahead of the response; skip them.
      if (msg?.type !== 'control_response') continue;
      if (msg.response?.request_id !== REQUEST_ID) continue;
      if (msg.response.subtype !== 'success' || !msg.response.response) {
        throw new ProviderError(
          'provider_error',
          'Claude Code rejected the initialize request.',
          line,
        );
      }
      payload = msg.response.response;
      break;
    }
  } finally {
    // Always: the child holds a session open until it is killed.
    session.kill();
  }

  if (!payload) {
    throw new ProviderError('provider_error', "Claude Code didn't answer the initialize request.");
  }

  const account = claudeAccountId(payload.account);
  if (!account) {
    throw new ProviderError(
      'not_authenticated',
      'Claude Code is not logged in. Log in to the Claude CLI, then try again.',
    );
  }

  return {
    provider: 'claude',
    cliVersion,
    account,
    models: (payload.models ?? []).filter((m) => typeof m?.value === 'string').map(toModelInfo),
  };
}

/**
 * Fallback rung 2: curated aliases, each VERIFIED BY PROBE before it is offered.
 * Aliases only — never a concrete model id, which would be a guess about what
 * the account can reach. An alias that fails its probe is hidden, not greyed:
 * the locked decision is "never show a model you have not verified exists".
 */
const CURATED: ReadonlyArray<ModelInfo> = [
  { id: 'default', label: 'Default (recommended)', efforts: [] },
  { id: 'opus', label: 'Opus', efforts: [] },
  { id: 'sonnet', label: 'Sonnet', efforts: [] },
  { id: 'haiku', label: 'Haiku', efforts: [] },
];

/**
 * Verified probe argv (claude 2.1.210, measured 2026-07-16).
 *
 * `--output-format json` is load-bearing, not cosmetic: the plaintext format
 * reports EVERY failure as a bare exit 1, so "this model does not exist" and
 * "the probe itself broke" are indistinguishable. The json result object carries
 * `api_error_status`, which is the only positive proof of a 404 there is.
 *
 * There is deliberately NO `--max-budget-usd`. Measured against the real CLI, a
 * cap tight enough to bound this probe also fires on healthy models — the cost
 * of `-p ok` swings from $0.0014 (haiku, warm prompt cache) to $0.014 (haiku,
 * COLD cache, i.e. the first run on a machine, which is exactly when discovery
 * runs) and opus straddles $0.002-$0.011 run to run. A cap set high enough never
 * to bite bounds nothing; a cap that bites hides every working model. The probe
 * has no runaway to guard against anyway: a fixed 2-character prompt, `--tools ''`
 * so there is no tool loop to spiral, and `timeoutMs` already bounds the spawn.
 *
 * NOT `--bare` — that reads only ANTHROPIC_API_KEY and would fail a subscription
 * login, making a good model look dead.
 */
const probeArgs = (model: string): string[] => [
  '-p',
  'ok',
  '--model',
  model,
  '--output-format',
  'json',
  '--tools',
  '',
  '--setting-sources',
  '',
  '--disable-slash-commands',
];

/** The `type: 'result'` object `--output-format json` prints on stdout. */
interface ProbeResult {
  is_error?: boolean;
  /** Present only on an API-level failure. 404 == this model is not reachable. */
  api_error_status?: number;
  subtype?: string;
  result?: string;
}

/**
 * What a single probe actually proved.
 *
 * `unavailable` requires POSITIVE evidence (a 404). Everything we cannot explain
 * is `broken`: the probe proved nothing about the model, so hiding it would be a
 * fabricated conclusion — the exact failure the exit-code gate used to make.
 */
export type ProbeVerdict =
  | { kind: 'available' }
  | { kind: 'unavailable' }
  | { kind: 'broken'; error: ProviderError };

const broken = (
  kind: 'timeout' | 'rate_limited' | 'not_authenticated' | 'provider_error',
  message: string,
  detail?: string,
): ProbeVerdict => ({ kind: 'broken', error: new ProviderError(kind, message, detail) });

/**
 * Pure, so the one decision that can silently hide every model is directly
 * testable against captured CLI output instead of only through a live spawn.
 */
export function classifyClaudeProbe(r: ProcResult): ProbeVerdict {
  if (r.timedOut) return broken('timeout', "Claude Code didn't respond while checking models.");

  // The CLI prints exactly one result object; be tolerant of leading noise.
  let payload: ProbeResult | undefined;
  for (const line of r.stdout.split('\n')) {
    const parsed = parse<ProbeResult>(line.trim());
    if (parsed && typeof parsed === 'object') payload = parsed;
  }

  if (!payload) {
    // No parsable result at all: the CLI died before it could answer. Says
    // nothing about the model.
    return r.exitCode === 0
      ? { kind: 'available' }
      : broken(
          'provider_error',
          'Claude Code failed while checking which models are available.',
          r.stderr || r.stdout || `exit ${String(r.exitCode)}`,
        );
  }

  if (r.exitCode === 0 && payload.is_error !== true) return { kind: 'available' };

  // Verified 2026-07-16: an unreachable model exits 1 with subtype 'success',
  // is_error true and api_error_status 404. The status — not the exit code — is
  // the proof.
  switch (payload.api_error_status) {
    case 404:
      return { kind: 'unavailable' };
    case 401:
    case 403:
      return broken(
        'not_authenticated',
        'Claude Code is not logged in. Log in to the Claude CLI, then try again.',
        payload.result,
      );
    case 429:
      return broken('rate_limited', 'Claude Code is rate limited right now. Try again shortly.');
  }

  return broken(
    'provider_error',
    'Claude Code failed while checking which models are available.',
    payload.result ?? payload.subtype ?? r.stdout,
  );
}

/**
 * Throws rather than returning a short list when the probe machinery itself is
 * broken. If it broke for one alias it is broken for all of them, so continuing
 * would spend real money to learn nothing and then report the silence as "these
 * models do not exist". The caller degrades to rung 3 on this — see discovery.ts.
 */
export async function probeCuratedClaudeModels(runner: ProcessRunner): Promise<ModelInfo[]> {
  const verified: ModelInfo[] = [];
  for (const model of CURATED) {
    const verdict = classifyClaudeProbe(
      await runner.run({ cmd: 'claude', args: probeArgs(model.id), timeoutMs: 60_000 }),
    );
    if (verdict.kind === 'broken') throw verdict.error;
    if (verdict.kind === 'available') verified.push(model);
    // 'unavailable': hidden, never greyed — and only ever on a real 404.
  }
  // efforts stay [] on this path: unenumerated means omit --effort, hide the picker.
  return verified;
}
