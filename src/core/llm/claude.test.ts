import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { joinPath } from '../files.ts';
import { nodeFiles } from '../testing/node-files.ts';
import { FakeRunner } from '../testing/fake-runner.ts';
import { ProviderError } from '../types.ts';
import type { ImageAttachment } from '../types.ts';
import { createClaudeAdapter } from './claude.ts';
import type { RefineInput } from './adapter.ts';

// A real path: refine now mkdirps its cwd for real (see 'creates its cwd').
const TEMP = joinPath(tmpdir().replaceAll('\\', '/'), 'quacket-claude-test');
const SCHEMA = { type: 'object', properties: { title: { type: 'string' } } };

const resultEvent = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: '{"title":"Login button does nothing"}',
    structured_output: { title: 'Login button does nothing' },
    session_id: 'sess-abc-123',
    total_cost_usd: 0.0037,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 6500,
      cache_read_input_tokens: 20993,
      output_tokens: 157,
    },
    terminal_reason: 'completed',
    ...over,
  });

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
  model: 'haiku',
  effort: null,
  ...over,
});

const adapter = (runner: FakeRunner, timeoutMs?: number) =>
  createClaudeAdapter({
    runner,
    files: nodeFiles,
    tempDirBase: TEMP,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const ok = () => new FakeRunner().on({ cmd: 'claude' }, { stdout: resultEvent() });

/** argv is a flat list; assert flag→value adjacency rather than absolute indices. */
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
  it('sends a text-only report as a plain json call with the schema inline', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const { cmd, args, stdin, cwd } = runner.calls[0]!;
    expect(cmd).toBe('claude');
    expect(valueOf(args, '-p')).toBe('the login button does nothing');
    expect(valueOf(args, '--output-format')).toBe('json');
    expect(valueOf(args, '--system-prompt')).toBe('You are Quacket’s ticket refiner.');
    expect(valueOf(args, '--json-schema')).toBe(JSON.stringify(SCHEMA));
    expect(valueOf(args, '--model')).toBe('haiku');
    expect(cwd).toBe(TEMP);
    // No images → no stream-json machinery at all.
    expect(args).not.toContain('--input-format');
    expect(stdin).toBeUndefined();
  });

  it('passes the hermetic flag set and never --bare, which would break OAuth', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    const { args } = runner.calls[0]!;
    expect(valueOf(args, '--tools')).toBe('');
    expect(valueOf(args, '--setting-sources')).toBe('');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--bare');
  });

  it('omits --model and --effort entirely when they are null', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ model: null, effort: null }));

    const { args } = runner.calls[0]!;
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('passes --effort when the model takes one', async () => {
    const runner = ok();
    await adapter(runner).refine(input({ model: 'opus', effort: 'low' }));

    expect(valueOf(runner.calls[0]!.args, '--effort')).toBe('low');
  });

  it('enforces a timeout, since the CLI has none', async () => {
    const runner = ok();
    await adapter(runner, 45_000).refine(input());

    expect(runner.calls[0]!.timeoutMs).toBe(45_000);
  });

  /**
   * The default is hang detection, not a latency budget: the worst measured real
   * call was 90.7 s (live-verification-round4.md), and a default that killed it
   * would turn a success into a failure. Pinned so it cannot quietly shrink back
   * under the measured tail.
   */
  it('defaults the timeout to 2x the worst measured refine', async () => {
    const runner = ok();
    await adapter(runner).refine(input());

    expect(runner.calls[0]!.timeoutMs).toBe(180_000);
  });

  /**
   * Live QA (2026-07-16) found every text-only refine in the shipped app dying
   * instantly: the spawn's cwd ($TEMP/quacket) had never been created, and the
   * no-image path touches nothing else on the fs that would create it. Every
   * test had injected an mkdtemp'd base that already existed — the exact
   * "tested from the code instead of from reality" gap. So this one hands the
   * adapter a base that does NOT exist and asserts refine creates it for real.
   */
  it('creates its cwd before spawning, so a fresh machine can refine', async () => {
    const missing = joinPath(TEMP, 'never-created');
    await nodeFiles.remove(missing);
    expect(existsSync(missing)).toBe(false);

    await createClaudeAdapter({ runner: ok(), files: nodeFiles, tempDirBase: missing }).refine(
      input(),
    );

    expect(existsSync(missing)).toBe(true);
    await nodeFiles.remove(missing);
  });
});

describe('refine with images', () => {
  const withImage = () =>
    input({ images: [png('img_1', [137, 80, 78, 71])], text: 'button is dead, see shot' });

  it('switches to stream-json in and out, with --verbose, and moves the prompt to stdin', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { stdout: `{"type":"system"}\n${resultEvent()}` });
    await adapter(runner).refine(withImage());

    const { args } = runner.calls[0]!;
    expect(valueOf(args, '--input-format')).toBe('stream-json');
    // stream-json input is rejected unless output is stream-json too.
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    // The prompt rides stdin now, so it must not also be a positional arg.
    expect(args).not.toContain('button is dead, see shot');
  });

  it('writes one Anthropic-format user message line with a base64 image block', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { stdout: resultEvent() });
    await adapter(runner).refine(withImage());

    const stdin = runner.calls[0]!.stdin!;
    expect(stdin).not.toContain('\n'); // exactly one NDJSON line
    expect(JSON.parse(stdin)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'button is dead, see shot' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: btoa('\x89PNG') },
          },
        ],
      },
    });
  });

  it('sends every image as its own block, in order', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { stdout: resultEvent() });
    await adapter(runner).refine(
      input({ images: [png('img_1', [1]), { ...png('img_2', [2]), mediaType: 'image/jpeg' }] }),
    );

    const content = JSON.parse(runner.calls[0]!.stdin!).message.content;
    expect(content.map((c: { type: string }) => c.type)).toEqual(['text', 'image', 'image']);
    expect(content[1].source.media_type).toBe('image/png');
    expect(content[2].source.media_type).toBe('image/jpeg');
  });
});

describe('refine outcome', () => {
  it('returns the parsed structured_output, the session handle and usage', async () => {
    const runner = ok();
    const result = await adapter(runner).refine(input());

    expect(result.draft).toEqual({ title: 'Login button does nothing' });
    expect(result.thread).toEqual({
      provider: 'claude',
      id: 'sess-abc-123',
      dir: TEMP,
      schema: SCHEMA,
      model: 'haiku',
      effort: null,
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 20993,
      outputTokens: 157,
      costUsd: 0.0037,
    });
  });

  it('reads the result event from the last line of a stream-json run', async () => {
    const runner = new FakeRunner().on(
      { cmd: 'claude' },
      {
        stdout: [
          '{"type":"system","subtype":"init"}',
          '{"type":"assistant","message":{}}',
          resultEvent(),
        ].join('\n'),
      },
    );
    const result = await adapter(runner).refine(input({ images: [png('img_1', [1])] }));

    expect(result.draft).toEqual({ title: 'Login button does nothing' });
  });

  it('fails when the run succeeded but carried no structured_output', async () => {
    const runner = new FakeRunner().on(
      { cmd: 'claude' },
      { stdout: resultEvent({ structured_output: undefined }) },
    );

    await expect(adapter(runner).refine(input())).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });
});

describe('error taxonomy', () => {
  const failing = (over: Record<string, unknown>, extraLines: string[] = []) =>
    new FakeRunner().on(
      { cmd: 'claude' },
      {
        exitCode: 1,
        stdout: [...extraLines, resultEvent({ is_error: true, terminal_reason: 'api_error', ...over })].join('\n'),
      },
    );

  // Driven through the streaming path, the only one that emits api_retry events.
  const kindOf = (runner: FakeRunner) => rejection(adapter(runner).refine(input({ images: [png('img_1', [1])] })));

  it('maps a not-logged-in run to not_authenticated from its text alone', async () => {
    // Verified shape: no api_error_status at all, only the result text.
    const error = await kindOf(failing({ result: 'Not logged in · Please run /login' }));

    expect(error.kind).toBe('not_authenticated');
    expect(error.message).toMatch(/isn’t signed in/);
  });

  it('maps an unavailable model to model_unavailable and names the model', async () => {
    const error = await kindOf(failing({ api_error_status: 404, result: 'model not found' }));

    expect(error.kind).toBe('model_unavailable');
    expect(error.message).toContain('haiku');
  });

  /**
   * Every member of claude 2.1.211's OWN enum, in its own order — read out of the
   * binary's embedded Zod schema, not remembered. See
   * `docs/research/live-verification-round4.md`.
   *
   * The table is the enum, so a category that is not mapped is a test that is not
   * written. `oauth_org_not_allowed` was the one nobody noticed was missing.
   */
  const CATEGORIES = [
    ['authentication_failed', 'not_authenticated'],
    ['oauth_org_not_allowed', 'provider_error'],
    ['billing_error', 'provider_error'],
    ['rate_limit', 'rate_limited'],
    ['overloaded', 'provider_error'],
    ['invalid_request', 'provider_error'],
    ['model_not_found', 'model_unavailable'],
    ['server_error', 'provider_error'],
    ['unknown', 'provider_error'],
    ['max_output_tokens', 'provider_error'],
  ] as const;

  it.each(CATEGORIES)('maps the api_retry category %s to %s', async (category, kind) => {
    const error = await kindOf(
      failing({ result: 'failed' }, [JSON.stringify({ type: 'system', subtype: 'api_retry', error: category })]),
    );

    expect(error.kind).toBe(kind);
  });

  it('recognises every category the CLI can emit — none falls through to guessing', async () => {
    /*
     * The guard the nine-member list needed, and it has to key on the RIGHT tell.
     *
     * An unmapped category does not error: it silently degrades to the status/text
     * heuristics, and `failing({})` emits no status, so the only thing left is the
     * last-resort passthrough `Claude failed: <raw result text>` — the CLI's own
     * words, handed to the user because we did not recognise the category. No
     * mapped category can produce that prefix (`unknown`'s message is the closest
     * and it carries no colon), so the prefix IS the fall-through, exactly.
     *
     * Keying on "failed without saying why" instead looks equivalent and is not:
     * `failing({})` carries default result text, so that branch never runs and the
     * guard passes while the category is unmapped. It did. This assertion is the
     * one that catches `oauth_org_not_allowed` going missing again.
     */
    for (const [category] of CATEGORIES) {
      const error = await kindOf(
        failing({}, [JSON.stringify({ type: 'system', subtype: 'api_retry', error: category })]),
      );
      expect(error.message, `${category} is not mapped — it fell through to the text heuristics`).not.toMatch(
        /^Claude failed: /,
      );
    }
  });

  it('does not tell a signed-in user to sign in when their ORG is the problem', async () => {
    /*
     * `oauth_org_not_allowed` is an auth failure, so `not_authenticated` is the
     * obvious mapping — and it would make the app state something false: that
     * message is "Claude isn't signed in… run `claude`, sign in there", and this
     * user is signed in. The sign-in would succeed and fix nothing.
     */
    const error = await kindOf(
      failing({}, [JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'oauth_org_not_allowed' })]),
    );

    expect(error.message).not.toMatch(/isn’t signed in|sign in there/);
    expect(error.message).toContain('organization');
  });

  /**
   * The REAL api_retry event, every field, as claude 2.1.211 defines it. Lifted
   * from the CLI's own embedded Zod schema rather than from prose:
   *
   *   {type:"system", subtype:"api_retry", attempt:number, max_retries:number,
   *    retry_delay_ms:number, error_status:number|null, error:<enum>,
   *    uuid:string, session_id:string}
   *
   * `error` is a BARE ENUM STRING — not an object carrying `.category`. Note the
   * event says `error_status`, while the result event says `api_error_status`:
   * two different names for the HTTP status, on two different events. The other
   * fixtures here abbreviate the event; this one keeps it whole, so a reader can
   * see what actually arrives. See docs/research/live-verification-round4.md.
   */
  it('reads the category out of the real, complete api_retry event', async () => {
    const error = await kindOf(
      failing({ result: 'overloaded', api_error_status: 529 }, [
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 1000,
          error_status: 429,
          error: 'rate_limit',
          uuid: '1b68557c-5d81-46f8-9ab2-127b6c25b7e5',
          session_id: 'd5047c63-e5b9-4ea9-aefb-9dfef3762727',
        }),
      ]),
    );

    // Read from `.error` on the api_retry event — not from either status code.
    expect(error.kind).toBe('rate_limited');
  });

  it('prefers the api_retry category over the status code', async () => {
    // Status says 404/model-unavailable; the category says rate limit and wins.
    const error = await kindOf(
      failing({ api_error_status: 404 }, [
        JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }),
      ]),
    );

    expect(error.kind).toBe('rate_limited');
  });

  it('gives each provider_error category its own actionable message', async () => {
    const billing = await kindOf(
      failing({}, [JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'billing_error' })]),
    );
    const overloaded = await kindOf(
      failing({}, [JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'overloaded' })]),
    );

    expect(billing.message).toMatch(/billing/i);
    expect(overloaded.message).toMatch(/overloaded/i);
    expect(billing.message).not.toBe(overloaded.message);
  });

  it('never branches on subtype, which stays "success" even on failures', async () => {
    const error = await kindOf(failing({ subtype: 'success', result: 'Not logged in · Please run /login' }));

    expect(error.kind).toBe('not_authenticated');
  });

  it('fails on a non-zero exit even when the JSON says is_error false', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { exitCode: 1, stdout: resultEvent() });

    await expect(adapter(runner).refine(input())).rejects.toBeInstanceOf(ProviderError);
  });

  it('reports unparseable output as a provider error rather than crashing', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { exitCode: 1, stdout: 'Segmentation fault', stderr: 'boom' });

    await expect(adapter(runner).refine(input())).rejects.toMatchObject({ kind: 'provider_error' });
  });

  it('maps a killed run to timeout, distinctly from a provider error', async () => {
    const runner = new FakeRunner().on({ cmd: 'claude' }, { hangs: true });

    const error = await rejection(adapter(runner, 30_000).refine(input()));

    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/30 seconds/);
  });
});

describe('followUp', () => {
  it('resumes the session from the same cwd, since resume lookup is cwd-scoped', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['it happens on Firefox only']);

    const first = runner.calls[0]!;
    const second = runner.calls[1]!;
    expect(valueOf(second.args, '--resume')).toBe('sess-abc-123');
    expect(second.cwd).toBe(first.cwd);
  });

  it('re-sends the schema, which is per-call rather than session state', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['on Firefox']);

    expect(valueOf(runner.calls[1]!.args, '--json-schema')).toBe(JSON.stringify(SCHEMA));
  });

  it('numbers answers so skipped ones still line up with the questions asked', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['Firefox 141', '', 'every time']);

    const prompt = valueOf(runner.calls[1]!.args, '-p')!;
    expect(prompt).toContain('1. Firefox 141');
    expect(prompt).toContain('3. every time');
    expect(prompt).not.toContain('2.');
  });

  it('still asks for a final draft when every question was skipped', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    await adapter(runner).followUp(thread, ['', '']);

    const prompt = valueOf(runner.calls[1]!.args, '-p')!;
    expect(prompt).toMatch(/no more information/i);
  });

  it('returns the second-turn draft', async () => {
    const runner = ok();
    const { thread } = await adapter(runner).refine(input());
    runner.on({ cmd: 'claude' }, { stdout: resultEvent({ structured_output: { title: 'Firefox: login button dead' } }) });

    const { draft } = await adapter(runner).followUp(thread, ['Firefox']);
    expect(draft).toEqual({ title: 'Firefox: login button dead' });
  });
});
