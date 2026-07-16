import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessRunner, ProcSession, ProcSpec } from '../runner.ts';
import { FakeRunner, type Response } from '../testing/fake-runner.ts';
import { nodeFiles } from '../testing/node-files.ts';
import { ProviderError } from '../types.ts';
import { classifyClaudeProbe } from './claude.ts';
import { CACHE_TTL_MS, cachePath, discover } from './discovery.ts';

/**
 * FakeRunner records `run` stdin on its `calls`, but a session's writes and its
 * kill live inside the session object the module under test owns — unreachable
 * from here. This thin pass-through records both. It observes only external
 * behavior: the bytes handed to the child's stdin, and whether it was killed.
 */
class SpyRunner implements ProcessRunner {
  readonly sessions: Array<{
    spec: ProcSpec;
    written: string[];
    killed: boolean;
  }> = [];
  constructor(private readonly inner: FakeRunner) {}
  get calls(): ProcSpec[] {
    return this.inner.calls;
  }
  run(spec: ProcSpec): ReturnType<ProcessRunner['run']> {
    return this.inner.run(spec);
  }
  session(spec: Omit<ProcSpec, 'stdin'>): ProcSession {
    const inner = this.inner.session(spec);
    const rec = {
      spec: spec as ProcSpec,
      written: [] as string[],
      killed: false,
    };
    this.sessions.push(rec);
    return {
      ...inner,
      write: (line: string) => {
        rec.written.push(line);
        inner.write(line);
      },
      kill: () => {
        rec.killed = true;
        inner.kill();
      },
    };
  }
}

// ── Fixtures: captured verbatim from the live CLIs on 2026-07-16 ─────────────
// claude 2.1.210, codex-cli 0.144.4. Shapes were re-verified by spawning both
// CLIs, not transcribed from the research doc's abridged excerpts.

const FIVE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** SessionStart hooks really do stream ahead of the control_response. */
const CLAUDE_HOOK_LINES = [
  JSON.stringify({
    type: 'system',
    subtype: 'hook_started',
    hook_name: 'SessionStart:startup',
    session_id: 'dfbf649f-347b-4670-891a-b35d0d68de48',
  }),
  JSON.stringify({
    type: 'system',
    subtype: 'hook_response',
    hook_name: 'SessionStart:startup',
    exit_code: 0,
    outcome: 'success',
  }),
];

const CLAUDE_ACCOUNT = {
  email: 'eva8isverygood@gmail.com',
  organization: "eva8isverygood@gmail.com's Organization",
  subscriptionType: 'Claude Max',
  apiProvider: 'firstParty',
};

const CLAUDE_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: FIVE_LEVELS,
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Opus',
    supportsEffort: true,
    supportedEffortLevels: FIVE_LEVELS,
  },
  {
    value: 'claude-fable-5[1m]',
    resolvedModel: 'claude-fable-5',
    displayName: 'Fable',
    supportsEffort: true,
    supportedEffortLevels: FIVE_LEVELS,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: FIVE_LEVELS,
  },
  // No supportsEffort, no supportedEffortLevels — this is why effort is per-model.
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

const claudeInitLine = (over: { models?: unknown; account?: unknown } = {}): string =>
  JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'quacket-init',
      response: {
        commands: [{ name: 'ask-matt', description: 'A router.', argumentHint: '' }],
        agents: [],
        output_style: 'default',
        models: 'models' in over ? over.models : CLAUDE_MODELS,
        account: 'account' in over ? over.account : CLAUDE_ACCOUNT,
        pid: 47012,
      },
    },
  });

const efforts = (...levels: string[]) => levels.map((reasoningEffort) => ({ reasoningEffort }));

const CODEX_MODELS = [
  {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'),
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'),
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max'),
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh'),
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh'),
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh'),
  },
  {
    id: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3-Codex-Spark',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh'),
  },
];

const CODEX_ACCOUNT = {
  type: 'chatgpt',
  email: 'eva8isverygood@gmail.com',
  planType: 'pro',
};

/**
 * Exactly the wire order observed: initialize's reply, then an unsolicited
 * notification, then account/read (id 3) BEFORE model/list (id 2). Note the
 * replies carry no `jsonrpc` field — the real server omits it.
 */
const codexLines = (over: { models?: unknown; account?: unknown } = {}): string[] => [
  JSON.stringify({
    id: 1,
    result: {
      userAgent: 'quacket/0.144.4 (Windows 10.0.26200; x86_64) xterm-256color (quacket; 0.1.0)',
      codexHome: 'C:\\Users\\user\\.codex',
      platformFamily: 'windows',
      platformOs: 'windows',
    },
  }),
  JSON.stringify({
    method: 'remoteControl/status/changed',
    params: {
      status: 'disabled',
      serverName: 'LAPTOP-I3R603I7',
      environmentId: null,
    },
  }),
  JSON.stringify({
    id: 3,
    result: {
      account: 'account' in over ? over.account : CODEX_ACCOUNT,
      requiresOpenaiAuth: true,
    },
  }),
  JSON.stringify({
    id: 2,
    result: {
      data: 'models' in over ? over.models : CODEX_MODELS,
      nextCursor: null,
    },
  }),
];

// ── Runner builders ─────────────────────────────────────────────────────────

const claudeRunner = (opts: { version?: string; lines?: string[] } = {}) =>
  new FakeRunner()
    .on(
      { cmd: 'claude', argsContain: ['--version'] },
      {
        stdout: `${opts.version ?? '2.1.210'} (Claude Code)\n`,
      },
    )
    .on(
      { cmd: 'claude', argsContain: ['--input-format'] },
      {
        lines: opts.lines ?? [...CLAUDE_HOOK_LINES, claudeInitLine()],
      },
    );

const codexRunner = (opts: { version?: string; lines?: string[] } = {}) =>
  new FakeRunner()
    .on(
      { cmd: 'codex', argsContain: ['--version'] },
      {
        stdout: `codex-cli ${opts.version ?? '0.144.4'}\n`,
      },
    )
    .on({ cmd: 'codex', argsContain: ['app-server'] }, { lines: opts.lines ?? codexLines() });

// ── Probe fixtures: captured verbatim from claude 2.1.210 on 2026-07-16 ──────
// Every shape below was produced by really running the probe argv. See the
// `--- observed` comment on each for the exact invocation.

/** `claude -p ok --model haiku --output-format json ...` -> exit 0. */
const probeOk = (): Response => ({
  exitCode: 0,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'fc079cb9-bbd1-43c2-a551-51beea61ed53',
    total_cost_usd: 0.0014498,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 6598 },
  }),
});

/**
 * `--model no-such-model-xyz` -> exit 1. Note `subtype: 'success'` and the
 * message on STDOUT with stderr empty: only `api_error_status` identifies this.
 */
const probe404 = (model: string): Response => ({
  exitCode: 1,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 404,
    num_turns: 1,
    result: `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`,
    total_cost_usd: 0,
  }),
  stderr: '',
});

/** `--max-budget-usd 0.0001` -> exit 1. The failure the cap used to cause. */
const probeBudgetExceeded = (): Response => ({
  exitCode: 1,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0.0014229,
  }),
  stderr: '',
});

/** Every curated alias probe succeeds unless `failing` marks it 404. */
const withProbes = (f: FakeRunner, failing: string[] = []) => {
  f.on({ cmd: 'claude', argsContain: ['-p', 'ok'] }, probeOk());
  for (const id of failing) {
    f.on({ cmd: 'claude', argsContain: ['-p', 'ok', id] }, probe404(id));
  }
  return f;
};

/** Probe spawns only — never the `--version` check or the enumerate session. */
const probeCalls = (r: SpyRunner) =>
  r.calls.filter((c) => c.args.includes('-p') && c.args.includes('ok'));

let baseDir: string;
beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'quacket-disc-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const at = (t: number) => () => t;

// ── Claude: enumeration ─────────────────────────────────────────────────────

describe('claude enumeration', () => {
  it('parses the captured initialize payload into models and account', async () => {
    const runner = new SpyRunner(claudeRunner());
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });

    expect(caps.provider).toBe('claude');
    expect(caps.cliVersion).toBe('2.1.210');
    expect(caps.account).toBe('eva8isverygood@gmail.com/Claude Max');
    expect(caps.models.map((m) => m.id)).toEqual([
      'default',
      'opus[1m]',
      'claude-fable-5[1m]',
      'sonnet',
      'haiku',
    ]);
    expect(caps.models[0]?.label).toBe('Default (recommended)');
  });

  it('extracts effort levels per model, not per provider', async () => {
    const runner = new SpyRunner(claudeRunner());
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    const byId = Object.fromEntries(caps.models.map((m) => [m.id, m.efforts]));

    expect(byId['sonnet']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(byId['opus[1m]']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // haiku reports no effort support at all -> takes no --effort flag.
    expect(byId['haiku']).toEqual([]);
  });

  it('spawns the verified argv and writes one initialize control_request', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', { runner, files: nodeFiles, baseDir });

    const session = runner.sessions[0]!;
    expect(session.spec.cmd).toBe('claude');
    expect(session.spec.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(session.written).toHaveLength(1);
    expect(JSON.parse(session.written[0]!)).toEqual({
      type: 'control_request',
      request_id: 'quacket-init',
      request: { subtype: 'initialize' },
    });
  });

  it('ignores SessionStart hook events that stream before the response', async () => {
    // The hook lines are already in the default fixture; prove they are skipped
    // rather than mistaken for the payload.
    const runner = new SpyRunner(claudeRunner());
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    expect(caps.models).toHaveLength(5);
  });

  it('kills the child after reading the response', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', { runner, files: nodeFiles, baseDir });
    expect(runner.sessions[0]?.killed).toBe(true);
  });

  it('reports not_authenticated when initialize carries no account', async () => {
    const runner = new SpyRunner(claudeRunner({ lines: [claudeInitLine({ account: null })] }));
    await expect(discover('claude', { runner, files: nodeFiles, baseDir })).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'not_authenticated',
    });
    // Still killed on the failure path.
    expect(runner.sessions[0]?.killed).toBe(true);
  });
});

// ── Codex: enumeration ──────────────────────────────────────────────────────

describe('codex enumeration', () => {
  it('parses the captured model/list payload, out-of-order replies and all', async () => {
    const runner = new SpyRunner(codexRunner());
    const caps = await discover('codex', { runner, files: nodeFiles, baseDir });

    expect(caps.provider).toBe('codex');
    expect(caps.cliVersion).toBe('0.144.4');
    expect(caps.account).toBe('eva8isverygood@gmail.com/pro');
    expect(caps.models.map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
    expect(caps.models[0]?.label).toBe('GPT-5.6-Sol');
  });

  it('extracts effort levels per model, not per provider', async () => {
    const runner = new SpyRunner(codexRunner());
    const caps = await discover('codex', { runner, files: nodeFiles, baseDir });
    const byId = Object.fromEntries(caps.models.map((m) => [m.id, m.efforts]));

    // The whole reason enumeration exists: these two differ on the same machine.
    expect(byId['gpt-5.6-sol']).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(byId['gpt-5.5']).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(byId['gpt-5.6-luna']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('spawns a transient app-server and speaks initialize -> model/list + account/read', async () => {
    const runner = new SpyRunner(codexRunner());
    await discover('codex', { runner, files: nodeFiles, baseDir });

    const session = runner.sessions[0]!;
    expect(session.spec.cmd).toBe('codex');
    expect(session.spec.args).toEqual(['app-server']);

    const sent = session.written.map((l) => JSON.parse(l));
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'quacket', title: 'Quacket', version: '0.1.0' },
        },
      },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'model/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'account/read', params: {} },
    ]);
  });

  it('always kills the app-server: on success', async () => {
    const runner = new SpyRunner(codexRunner());
    await discover('codex', { runner, files: nodeFiles, baseDir });
    expect(runner.sessions[0]?.killed).toBe(true);
  });

  it('always kills the app-server: when it answers with an error', async () => {
    const runner = new SpyRunner(
      codexRunner({
        lines: [JSON.stringify({ id: 1, error: { message: 'boom' } })],
      }),
    );
    const caps = await discover('codex', { runner, files: nodeFiles, baseDir });
    expect(runner.sessions[0]?.killed).toBe(true);
    expect(caps.models).toEqual([]); // degraded, but nothing left running
  });

  it('always kills the app-server: when it is logged out', async () => {
    const runner = new SpyRunner(codexRunner({ lines: codexLines({ account: null }) }));
    await expect(discover('codex', { runner, files: nodeFiles, baseDir })).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
    expect(runner.sessions[0]?.killed).toBe(true);
  });

  it('hides models the server marks hidden', async () => {
    const runner = new SpyRunner(
      codexRunner({
        lines: codexLines({
          models: [...CODEX_MODELS, { id: 'gpt-internal', displayName: 'Internal', hidden: true }],
        }),
      }),
    );
    const caps = await discover('codex', { runner, files: nodeFiles, baseDir });
    expect(caps.models.map((m) => m.id)).not.toContain('gpt-internal');
  });
});

// ── Fallback chain ──────────────────────────────────────────────────────────

describe('fallback chain', () => {
  it('rung 2: a CLI older than the verified version skips enumeration and probes aliases', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });

    // Never even tried the control protocol.
    expect(runner.sessions).toHaveLength(0);
    expect(caps.cliVersion).toBe('2.0.9');
    expect(caps.account).toBeNull();
    expect(caps.models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });

  it('rung 2: probes each alias with a real invocation before offering it', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    await discover('claude', { runner, files: nodeFiles, baseDir });

    const probes = probeCalls(runner);
    expect(probes).toHaveLength(4);
    expect(probes[0]?.args).toEqual([
      '-p',
      'ok',
      '--model',
      'default',
      '--output-format',
      'json',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--disable-slash-commands',
    ]);
    // --bare would break subscription auth and make live models look dead.
    expect(probes.flatMap((p) => p.args)).not.toContain('--bare');
  });

  it('rung 2: never caps probe spend — the cap fires on healthy models', async () => {
    // Measured against claude 2.1.210: `-p ok` costs $0.0014 on a warm prompt
    // cache but $0.014 COLD — i.e. on the first run of a machine, which is
    // exactly when discovery runs. Any cap tight enough to bound the probe also
    // hides every working model.
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    await discover('claude', { runner, files: nodeFiles, baseDir });

    expect(probeCalls(runner).flatMap((p) => p.args)).not.toContain('--max-budget-usd');
  });

  it('rung 2: asks for json, the only format that distinguishes 404 from failure', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    await discover('claude', { runner, files: nodeFiles, baseDir });

    for (const p of probeCalls(runner)) {
      expect(p.args).toContain('--output-format');
      expect(p.args).toContain('json');
    }
  });

  it('rung 2: falls back when enumeration is supported but fails', async () => {
    const runner = new SpyRunner(
      withProbes(claudeRunner({ lines: ['not json at all', '{"type":"system"}'] })),
    );
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });

    expect(runner.sessions).toHaveLength(1); // tried rung 1 first
    expect(runner.sessions[0]?.killed).toBe(true);
    expect(caps.models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });

  it('rung 2: hides aliases whose probe fails, never greys them', async () => {
    const runner = new SpyRunner(
      withProbes(claudeRunner({ version: '2.0.9' }), ['opus', 'sonnet']),
    );
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    expect(caps.models.map((m) => m.id)).toEqual(['default', 'haiku']);
  });

  it('rung 2: fallback models carry no effort levels, so no effort flag is passed', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    expect(caps.models.every((m) => m.efforts.length === 0)).toBe(true);
  });

  it('rung 3: every probe failing leaves the CLI default, not a guess', async () => {
    const runner = new SpyRunner(
      withProbes(claudeRunner({ version: '2.0.9' }), ['default', 'opus', 'sonnet', 'haiku']),
    );
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    // models: [] means "pass no --model at all" — the CLI picks. Not an error.
    expect(caps.models).toEqual([]);
    expect(caps.account).toBeNull();
  });

  it('rung 3: codex enumeration failure degrades straight to the CLI default', async () => {
    const runner = new SpyRunner(codexRunner({ lines: ['garbage'] }));
    const caps = await discover('codex', { runner, files: nodeFiles, baseDir });

    expect(caps.models).toEqual([]);
    expect(caps.account).toBeNull();
    expect(caps.cliVersion).toBe('0.144.4');
    expect(runner.sessions[0]?.killed).toBe(true);
  });

  it('never swallows not_authenticated into a fallback', async () => {
    // "Using CLI default" would be a lie here: rung 3 needs an authenticated CLI.
    const runner = new SpyRunner(
      withProbes(claudeRunner({ lines: [claudeInitLine({ account: null })] })),
    );
    await expect(discover('claude', { runner, files: nodeFiles, baseDir })).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
    expect(probeCalls(runner)).toHaveLength(0);
  });

  it('reports provider_error when the CLI is not installed', async () => {
    const runner = new FakeRunner().on(
      { cmd: 'claude', argsContain: ['--version'] },
      { exitCode: 1, stderr: "'claude' is not recognized" },
    );
    await expect(discover('claude', { runner, files: nodeFiles, baseDir })).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });
});

// ── Cache ───────────────────────────────────────────────────────────────────

const sessionCount = (r: SpyRunner) => r.sessions.length;

describe('cache', () => {
  it('serves a fresh cache without re-enumerating', async () => {
    const runner = new SpyRunner(claudeRunner());
    const first = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });
    const second = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(2000),
    });

    expect(second).toEqual(first);
    expect(sessionCount(runner)).toBe(1);
  });

  it('lives in its own file, not settings.json', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', { runner, files: nodeFiles, baseDir });

    const path = cachePath(baseDir, 'claude');
    expect(path.endsWith('discovery-cache.claude.json')).toBe(true);
    const entry = JSON.parse(await readFile(path, 'utf8'));
    expect(entry.capabilities.models).toHaveLength(5);
    await expect(readFile(join(baseDir, 'settings.json'), 'utf8')).rejects.toThrow();
  });

  it('invalidates on a CLI version change', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });

    const upgraded = new SpyRunner(claudeRunner({ version: '2.2.0' }));
    const caps = await discover('claude', {
      runner: upgraded,
      files: nodeFiles,
      baseDir,
      now: at(2000),
    });

    expect(sessionCount(upgraded)).toBe(1);
    expect(caps.cliVersion).toBe('2.2.0');
  });

  it('invalidates after the 24h TTL', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });

    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000 + CACHE_TTL_MS - 1),
    });
    expect(sessionCount(runner)).toBe(1); // still fresh

    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000 + CACHE_TTL_MS),
    });
    expect(sessionCount(runner)).toBe(2); // expired
  });

  it('re-enumerates when forced (app start / invocation failure)', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
      force: true,
    });
    expect(sessionCount(runner)).toBe(2);
  });

  it('replaces the cached offering when the account changes', async () => {
    const runner = new SpyRunner(claudeRunner());
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });

    // Same CLI version, different login: fewer models on the new plan.
    const switched = new SpyRunner(
      claudeRunner({
        lines: [
          claudeInitLine({
            account: {
              email: 'other@example.com',
              subscriptionType: 'Claude Pro',
            },
            models: [CLAUDE_MODELS[4]],
          }),
        ],
      }),
    );
    const caps = await discover('claude', {
      runner: switched,
      files: nodeFiles,
      baseDir,
      now: at(2000),
      force: true,
    });
    expect(caps.account).toBe('other@example.com/Claude Pro');
    expect(caps.models.map((m) => m.id)).toEqual(['haiku']);

    // The previous account's offering must not resurface on the next cache hit.
    const after = new SpyRunner(claudeRunner());
    const cached = await discover('claude', {
      runner: after,
      files: nodeFiles,
      baseDir,
      now: at(3000),
    });
    expect(cached.account).toBe('other@example.com/Claude Pro');
    expect(sessionCount(after)).toBe(0);
  });

  it('treats a corrupt cache file as a miss rather than throwing', async () => {
    await writeFile(cachePath(baseDir, 'claude'), '{ not json', 'utf8');
    const runner = new SpyRunner(claudeRunner());
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });
    expect(caps.models).toHaveLength(5);
  });

  it('keeps providers in separate files so a concurrent discovery cannot clobber', async () => {
    const claude = new SpyRunner(claudeRunner());
    const codex = new SpyRunner(codexRunner());
    await Promise.all([
      discover('claude', {
        runner: claude,
        files: nodeFiles,
        baseDir,
        now: at(1000),
      }),
      discover('codex', {
        runner: codex,
        files: nodeFiles,
        baseDir,
        now: at(1000),
      }),
    ]);

    const again = {
      claude: new SpyRunner(claudeRunner()),
      codex: new SpyRunner(codexRunner()),
    };
    const [c1, c2] = await Promise.all([
      discover('claude', {
        runner: again.claude,
        files: nodeFiles,
        baseDir,
        now: at(1500),
      }),
      discover('codex', {
        runner: again.codex,
        files: nodeFiles,
        baseDir,
        now: at(1500),
      }),
    ]);

    expect(c1.models).toHaveLength(5);
    expect(c2.models).toHaveLength(7);
    expect(sessionCount(again.claude)).toBe(0);
    expect(sessionCount(again.codex)).toBe(0);
  });

  it('caches a degraded offering too, so probes do not re-run every call', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' })));
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });
    const probesFirst = probeCalls(runner).length;

    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(2000),
    });
    const probesSecond = probeCalls(runner).length;

    expect(probesFirst).toBe(4);
    expect(probesSecond).toBe(4);
  });

  it('does NOT cache an offering a broken probe never actually proved', async () => {
    // A cached [] from a broken probe would hide every model for the full 24h
    // TTL off one transient failure. An empty offering we DID prove is cached
    // (the test above); one we merely fell back to is not.
    const runner = new SpyRunner(
      claudeRunner({ version: '2.0.9' }).on(
        { cmd: 'claude', argsContain: ['-p', 'ok'] },
        {
          exitCode: 1,
          stdout: JSON.stringify({
            type: 'result',
            is_error: true,
            api_error_status: 429,
          }),
        },
      ),
    );
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(1000),
    });
    expect(caps.models).toEqual([]); // rung 3 still works

    await expect(readFile(cachePath(baseDir, 'claude'), 'utf8')).rejects.toThrow();

    // ...so the next call re-probes instead of serving the poisoned empty list.
    await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
      now: at(2000),
    });
    expect(probeCalls(runner).length).toBe(2);
  });
});

// ── Probe classification ────────────────────────────────────────────────────
// The one decision that can silently hide every model. Every fixture here is
// real output from claude 2.1.210, captured 2026-07-16.

describe('probe classification', () => {
  const res = (r: Response) => ({
    exitCode: r.exitCode ?? 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.timedOut ?? false,
  });

  it('exit 0 with is_error false proves the model is available', () => {
    expect(classifyClaudeProbe(res(probeOk()))).toEqual({ kind: 'available' });
  });

  it('only api_error_status 404 proves a model is unavailable', () => {
    expect(classifyClaudeProbe(res(probe404('opus')))).toEqual({
      kind: 'unavailable',
    });
  });

  it('a budget failure is NOT evidence the model is missing', () => {
    // The defect this whole fix exists for: exit 1 for "budget" and exit 1 for
    // "404" are byte-identical to an exitCode===0 gate.
    const v = classifyClaudeProbe(res(probeBudgetExceeded()));
    expect(v.kind).toBe('broken');
    expect(v.kind === 'broken' && v.error.kind).toBe('provider_error');
  });

  it('a rate limit is reported as a rate limit, not as four dead models', () => {
    const v = classifyClaudeProbe(
      res({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, api_error_status: 429 }),
      }),
    );
    expect(v.kind === 'broken' && v.error.kind).toBe('rate_limited');
  });

  it('a 401 surfaces as not_authenticated, never as a missing model', () => {
    const v = classifyClaudeProbe(
      res({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, api_error_status: 401 }),
      }),
    );
    expect(v.kind === 'broken' && v.error.kind).toBe('not_authenticated');
  });

  it('a timeout is broken, not unavailable', () => {
    const v = classifyClaudeProbe(res({ exitCode: null as unknown as number, timedOut: true }));
    expect(v.kind === 'broken' && v.error.kind).toBe('timeout');
  });

  it('a crash with no parsable json proves nothing about the model', () => {
    const v = classifyClaudeProbe(res({ exitCode: 1, stdout: '', stderr: 'segfault' }));
    expect(v.kind).toBe('broken');
  });
});

describe('probe failure vs missing model', () => {
  it('a broken probe degrades to rung 3 instead of hiding every model as dead', async () => {
    // Exactly the reported defect: with the old --max-budget-usd 0.01 cap every
    // curated probe exited 1, and the exitCode===0 gate read that as "none of
    // these models exist" — rung 2 dying without a sound.
    const runner = new SpyRunner(
      claudeRunner({ version: '2.0.9' }).on(
        { cmd: 'claude', argsContain: ['-p', 'ok'] },
        probeBudgetExceeded(),
      ),
    );
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });

    expect(caps.models).toEqual([]); // rung 3: pass no --model. Still works.
    // ...and it gave up after the first failure instead of burning money on
    // three more probes that were always going to fail the same way.
    expect(probeCalls(runner)).toHaveLength(1);
  });

  it('a genuine 404 still hides just that model and keeps probing the rest', async () => {
    const runner = new SpyRunner(withProbes(claudeRunner({ version: '2.0.9' }), ['opus']));
    const caps = await discover('claude', {
      runner,
      files: nodeFiles,
      baseDir,
    });

    expect(caps.models.map((m) => m.id)).toEqual(['default', 'sonnet', 'haiku']);
    expect(probeCalls(runner)).toHaveLength(4);
  });

  it('a logged-out probe surfaces not_authenticated rather than a silent rung 3', async () => {
    // Reachable for real: a sub-2.1.210 CLI skips rung 1 entirely, so the probe
    // is the first thing that ever touches auth.
    const runner = new SpyRunner(
      claudeRunner({ version: '2.0.9' }).on(
        { cmd: 'claude', argsContain: ['-p', 'ok'] },
        {
          exitCode: 1,
          stdout: JSON.stringify({ is_error: true, api_error_status: 401 }),
        },
      ),
    );
    await expect(discover('claude', { runner, files: nodeFiles, baseDir })).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
  });
});

describe('ProviderError', () => {
  it('is the only error shape that escapes', async () => {
    const runner = new FakeRunner().on(
      { cmd: 'codex', argsContain: ['--version'] },
      { exitCode: 1 },
    );
    const err = await discover('codex', {
      runner,
      files: nodeFiles,
      baseDir,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
  });
});
