import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinPath } from '../files.ts';
import { FakeRunner } from '../testing/fake-runner.ts';
import { nodeFiles } from '../testing/node-files.ts';
import { ProviderError } from '../types.ts';
import type { ImageAttachment } from '../types.ts';
import { createCodexAdapter } from './codex.ts';
import type { RefineInput } from './adapter.ts';

const SCHEMA = { type: 'object', properties: { title: { type: 'string' } } };

/**
 * Codex is genuinely file-backed — the system prompt, the schema and every image
 * exist only as files on disk — so these run against a real scratch dir. The
 * injected base is the seam; nothing escapes it.
 */
let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'quacket-codex-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const stream = (over: { message?: string; extra?: string[] } = {}): string =>
  [
    '{"type":"thread.started","thread_id":"019f66a7-dead-beef"}',
    '{"type":"turn.started"}',
    ...(over.extra ?? []),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: over.message ?? '{"title":"Login button does nothing"}' },
    }),
    '{"type":"turn.completed","usage":{"input_tokens":23498,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n');

const png = (id: string, bytes: number[]): ImageAttachment => ({
  id,
  bytes: new Uint8Array(bytes),
  mediaType: 'image/png',
  annotated: false,
});

const input = (over: Partial<RefineInput> = {}): RefineInput => ({
  text: 'the login button does nothing',
  images: [],
  schema: SCHEMA,
  systemPrompt: 'You are Quacket’s ticket refiner.',
  model: 'gpt-5.6-sol',
  effort: 'low',
  ...over,
});

const adapter = (runner: FakeRunner, timeoutMs?: number) =>
  createCodexAdapter({
    runner,
    files: nodeFiles,
    tempDirBase: base,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const ok = () => new FakeRunner().on({ cmd: 'codex' }, { stdout: stream() });

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const rejection = async (call: Promise<unknown>): Promise<ProviderError> => {
  const error: unknown = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
};

describe('refine argv', () => {
  it('runs exec with the pinned hermetic flags', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const { cmd, args } = runner.calls[0]!;
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--json');
    // Never --ephemeral: it makes the thread unresumable, and turn 2 needs resume.
    expect(args).not.toContain('--ephemeral');
  });

  it('always pins the sandbox to read-only rather than inheriting user config', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    // The user's config on the reference machine was danger-full-access.
    expect(valueOf(runner.calls[0]!.args, '-s')).toBe('read-only');
  });

  /**
   * Spec #16 pins `--ignore-user-config`; without it `~/.codex/config.toml` steers
   * a Quacket refine. Measured live on the reference machine, where that file set
   * `model`, `model_reasoning_effort = "high"`, `personality`, `service_tier` and
   * a `notify` hook — so every refine ALSO spawned the user's notifier binary on
   * turn-ended, and each call carried ~5.8 k tokens of their config (26 226 ->
   * 20 418 input tokens with the flag). Codex's counterpart to Claude's HERMETIC.
   * Auth is unaffected: `--ignore-user-config` still reads CODEX_HOME (verified).
   */
  it('ignores the user config on both turns, so a personal config cannot steer a refine', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['Firefox 141']);

    expect(runner.calls[0]!.args).toContain('--ignore-user-config');
    expect(runner.calls[1]!.args).toContain('--ignore-user-config');
  });

  it('passes model and effort unquoted, since there is no shell to strip quotes', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const { args } = runner.calls[0]!;
    expect(valueOf(args, '-m')).toBe('gpt-5.6-sol');
    expect(args).toContain('model_reasoning_effort=low');
    expect(args).not.toContain('model_reasoning_effort="low"');
  });

  it('omits the effort config entirely when the model takes none', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ effort: null, model: null }));

    const { args } = runner.calls[0]!;
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
    expect(args).not.toContain('-m');
  });

  it('delivers the prompt on stdin, marked by the `-` sentinel after --', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ images: [png('img_1', [1]), png('img_2', [2])] }));

    const { args, stdin } = runner.calls[0]!;
    // The report reaches codex, and it reaches it via stdin.
    expect(stdin).toBe('the login button does nothing');
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('-');
    // Every -i must land before the separator, or variadic -i eats the sentinel.
    expect(args.lastIndexOf('-i')).toBeLessThan(args.indexOf('--'));
  });

  /**
   * THE ROOT-CAUSE GUARD. Written from the OS's rule, not from the code.
   *
   * On Windows codex is an npm `.cmd` batch shim (`proc.rs::shim()`), and Rust's
   * std REFUSES to spawn a batch file when ANY argument contains a newline:
   *   Command::new("codex.cmd").args(["--","a\nb"]).spawn()
   *     => Err(InvalidInput, "batch file arguments are invalid")
   * That is a hard spawn error, so a multi-line argv here is not "ugly" — it is a
   * Codex refine that can never run on Quacket's primary platform. The real user
   * prompt is ALWAYS multi-line (`<raw_report>\n…`).
   *
   * Verified live against codex-cli 0.144.4 + rustc 1.95.0 — see
   * docs/research/live-verification-round4.md.
   */
  it('never puts a newline in argv — Windows cannot spawn the .cmd shim with one', async () => {
    const runner = ok();
    const realistic = '<raw_report>\n匯出按鈕點了沒反應\nclicked export 3 times\n</raw_report>';
    await adapter(runner).refine(input({ text: realistic, images: [png('img_1', [1])] }));

    const { args, stdin } = runner.calls[0]!;
    expect(args.filter((a) => a.includes('\n'))).toEqual([]);
    // …and the multi-line text still got there, intact, by the only route that can carry it.
    expect(stdin).toBe(realistic);
  });

  it('runs in a per-draft scratch dir under the injected base', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const { args, cwd } = runner.calls[0]!;
    const dir = valueOf(args, '-C')!;
    expect(dir.startsWith(base)).toBe(true);
    expect(cwd).toBe(dir);
  });

  it('gives concurrent drafts their own scratch dirs', async () => {
    const runner = ok();
    const a = await adapter(runner).refine(input());
    const b = await adapter(runner).refine(input());

    expect(a.thread.dir).not.toBe(b.thread.dir);
  });

  it('enforces a timeout, since the CLI has none', async () => {
    const runner = ok();
    await adapter(runner, 45_000).refine(input());

    expect(runner.calls[0]!.timeoutMs).toBe(45_000);
  });
});

describe('refine scratch files', () => {
  it('writes the system prompt as AGENTS.md, because no flag carries it', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());

    expect(await readFile(join(thread.dir, 'AGENTS.md'), 'utf8')).toBe('You are Quacket’s ticket refiner.');
  });

  it('passes --output-schema as a real file path holding the schema', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const path = valueOf(runner.calls[0]!.args, '--output-schema')!;
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(SCHEMA);
  });

  it('writes each image to disk and passes it with its own -i', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ images: [png('img_1', [137, 80]), png('img_2', [1, 2, 3])] }));

    const { args } = runner.calls[0]!;
    const paths = args.filter((_, i) => args[i - 1] === '-i');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('img_1.png');
    expect(paths[1]).toContain('img_2.png');
    expect([...(await readFile(paths[0]!))]).toEqual([137, 80]);
    expect([...(await readFile(paths[1]!))]).toEqual([1, 2, 3]);
  });

  it('gives a jpeg the right extension', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ images: [{ ...png('img_1', [1]), mediaType: 'image/jpeg' }] }));

    expect(valueOf(runner.calls[0]!.args, '-i')).toContain('img_1.jpg');
  });
});

describe('refine outcome', () => {
  it('parses the agent message itself, since codex pre-parses nothing', async () => {
    const runner = ok();
    const result = await adapter(runner).refine(input());

    expect(result.draft).toEqual({ title: 'Login button does nothing' });
    expect(result.thread.id).toBe('019f66a7-dead-beef');
    expect(result.thread.provider).toBe('codex');
  });

  it('reports token usage and no cost, which codex never provides', async () => {
    const runner = ok();
    const { usage } = await adapter(runner).refine(input());

    expect(usage).toEqual({
      inputTokens: 23498,
      cachedInputTokens: 9984,
      outputTokens: 5,
      costUsd: null,
    });
  });

  it('ignores non-fatal error items, which appear in every run', async () => {
    // A skills-context-budget warning shows up even in hermetic runs; the turn succeeds.
    const runner = new FakeRunner().on(
      { cmd: 'codex' },
      {
        exitCode: 0,
        stdout: stream({
          extra: [
            '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"skills context budget exceeded"}}',
          ],
        }),
      },
    );

    const result = await adapter(runner).refine(input());
    expect(result.draft).toEqual({ title: 'Login button does nothing' });
  });

  it('fails when the agent message is not the JSON the schema promised', async () => {
    const runner = new FakeRunner().on({ cmd: 'codex' }, { stdout: stream({ message: 'I could not do that.' }) });

    await expect(adapter(runner).refine(input())).rejects.toMatchObject({ kind: 'provider_error' });
  });
});

describe('error taxonomy', () => {
  const failing = (message: string) =>
    new FakeRunner().on(
      { cmd: 'codex' },
      {
        exitCode: 1,
        stdout: [
          '{"type":"thread.started","thread_id":"t1"}',
          JSON.stringify({ type: 'turn.failed', error: { message } }),
        ].join('\n'),
      },
    );

  const kindOf = (runner: FakeRunner) => rejection(adapter(runner).refine(input()));

  it('maps an unsupported model to model_unavailable and names it', async () => {
    // Verified: reported as a plain 400, so the text is the only signal.
    const error = await kindOf(
      failing(
        JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      ),
    );

    expect(error.kind).toBe('model_unavailable');
    expect(error.message).toContain('gpt-5.6-sol');
  });

  it('maps a 401 to not_authenticated', async () => {
    const error = await kindOf(
      failing(JSON.stringify({ type: 'error', status: 401, error: { type: 'authentication_error', message: 'no' } })),
    );

    expect(error.kind).toBe('not_authenticated');
    expect(error.message).toMatch(/codex login/);
  });

  it('maps a 429 to rate_limited', async () => {
    const error = await kindOf(
      failing(JSON.stringify({ type: 'error', status: 429, error: { type: 'rate_limit_error', message: 'slow down' } })),
    );

    expect(error.kind).toBe('rate_limited');
  });

  it('maps a 5xx to a retryable provider error', async () => {
    const error = await kindOf(
      failing(JSON.stringify({ type: 'error', status: 503, error: { type: 'server_error', message: 'oops' } })),
    );

    expect(error.kind).toBe('provider_error');
    expect(error.message).toMatch(/server error/i);
  });

  it('surfaces the upstream message when the error is an unclassified 400', async () => {
    const error = await kindOf(
      failing(
        JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'bad schema' } }),
      ),
    );

    expect(error.kind).toBe('provider_error');
    expect(error.message).toContain('bad schema');
  });

  it('reports the real failure, not a non-fatal error item that arrives after it', async () => {
    // The discrimination only bites on a failing run: on exit 0 the exit code
    // already saves us. Here the noisy error *item* is last, so anything scanning
    // for "an error event" rather than turn.failed picks up the wrong one.
    const runner = new FakeRunner().on(
      { cmd: 'codex' },
      {
        exitCode: 1,
        stdout: [
          '{"type":"thread.started","thread_id":"t1"}',
          JSON.stringify({
            type: 'turn.failed',
            error: {
              message: JSON.stringify({
                type: 'error',
                status: 429,
                error: { type: 'rate_limit_error', message: 'slow down' },
              }),
            },
          }),
          '{"type":"item.completed","item":{"id":"item_9","type":"error","message":"skills context budget exceeded"}}',
        ].join('\n'),
      },
    );

    const error = await kindOf(runner);
    expect(error.kind).toBe('rate_limited');
    expect(error.message).not.toContain('skills context budget');
  });

  it('handles a turn.failed message that is not JSON at all', async () => {
    const error = await kindOf(failing('something went sideways'));

    expect(error.kind).toBe('provider_error');
    expect(error.message).toContain('something went sideways');
  });

  it('falls back to stderr when a failure produced no JSONL', async () => {
    // The arg-parse trap: prompt swallowed as an image path.
    const runner = new FakeRunner().on(
      { cmd: 'codex' },
      { exitCode: 1, stdout: '', stderr: 'No prompt provided via stdin.' },
    );

    const error = await kindOf(runner);
    expect(error.kind).toBe('provider_error');
    expect(error.message).toContain('No prompt provided via stdin.');
  });

  it('maps a killed run to timeout, distinctly from a provider error', async () => {
    const runner = new FakeRunner().on({ cmd: 'codex' }, { hangs: true });

    const error = await rejection(adapter(runner, 60_000).refine(input()));

    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/60 seconds/);
  });
});

describe('followUp', () => {
  it('resumes the thread with the sandbox pinned via -c, since resume takes no -s', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['it happens on Firefox only']);

    const { args } = runner.calls[1]!;
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '019f66a7-dead-beef']);
    expect(args).toContain('sandbox_mode=read-only');
    expect(args).not.toContain('-s');
    expect(args).not.toContain('-C');
  });

  it('runs resume in the same scratch dir, which resume cannot be told about', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['on Firefox']);

    expect(runner.calls[1]!.cwd).toBe(thread.dir);
    const schemaArg = valueOf(runner.calls[1]!.args, '--output-schema')!;
    expect(schemaArg).toBe(joinPath(thread.dir, 'schema.json'));
    // Not just the right shape — resume must point at the schema refine wrote,
    // or turn 2 comes back unstructured.
    expect(JSON.parse(await readFile(schemaArg, 'utf8'))).toEqual(SCHEMA);
  });

  it('passes the resume sentinel positionally, with the answers on stdin', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['Firefox 141']);

    const { args, stdin } = runner.calls[1]!;
    expect(args).not.toContain('--');
    expect(args.at(-1)).toBe('-');
    // The answer the user actually typed has to reach the model.
    expect(stdin).toContain('1. Firefox 141');
  });

  /**
   * Same OS rule as refine's guard: `followUpPrompt` is multi-line as soon as the
   * user answers anything, so an argv-carried resume prompt is an unspawnable
   * process, not a cosmetic issue.
   */
  it('never puts a newline in resume argv', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['Firefox 141', 'Only on Windows 11']);

    const { args, stdin } = runner.calls[1]!;
    expect(args.filter((a) => a.includes('\n'))).toEqual([]);
    expect(stdin).toContain('1. Firefox 141');
    expect(stdin).toContain('2. Only on Windows 11');
  });

  it('returns the second-turn draft', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    runner.on({ cmd: 'codex' }, { stdout: stream({ message: '{"title":"Firefox: login button dead"}' }) });

    const { draft } = await adapter(runner).followUp(thread, ['Firefox']);
    expect(draft).toEqual({ title: 'Firefox: login button dead' });
  });
});
