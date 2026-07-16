import type { ProcResult, ProcSpec } from '../runner.ts';
import type { ImageAttachment } from '../types.ts';
import { DEFAULT_TIMEOUT_MS, followUpPrompt } from './adapter.ts';
import type { AdapterDeps, LlmAdapter, RefineInput, RefineResult, Thread, Usage } from './adapter.ts';
import { claudeError, noDraftError, timeoutError } from './errors.ts';

/**
 * Claude transport: one spawn, everything inline.
 *
 * No scratch files at all — images ride stdin as base64 blocks and the schema is
 * an inline flag — but the cwd still matters, because `--resume` lookup is scoped
 * to it. Both turns therefore run in `tempDirBase`.
 */

/**
 * Hermetic, and deliberately NOT via `--bare`.
 *
 * `--bare` reads only ANTHROPIC_API_KEY/apiKeyHelper and silently breaks
 * subscription OAuth (verified: "Not logged in"). The docs recommend it for
 * scripting and it may become the `-p` default, so the flag set that gives the
 * same hermeticity while keeping OAuth is pinned here explicitly.
 */
const HERMETIC = ['--tools', '', '--setting-sources', '', '--disable-slash-commands'];

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Chunked so a multi-MB screenshot doesn't blow the argument limit. */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/** One line of newline-delimited JSON in Anthropic Messages format. */
const userMessageLine = (text: string, images: ImageAttachment[]): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: toBase64(image.bytes) },
        })),
      ],
    },
  });

const modelFlags = (model: string | null, effort: string | null): string[] => [
  ...(model === null ? [] : ['--model', model]),
  ...(effort === null ? [] : ['--effort', effort]),
];

/**
 * `--output-format json` emits one object; stream-json emits a JSONL stream whose
 * result event is last. Scanning from the end for `type:"result"` covers both
 * without the caller having to say which mode it asked for.
 */
const resultEvent = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = rec(JSON.parse(lines[i]!));
      if (parsed.type === 'result') return parsed;
    } catch {
      /* not JSON; keep scanning */
    }
  }
  // Non-streaming mode pretty-prints, so the object spans lines.
  try {
    const parsed = rec(JSON.parse(stdout));
    return parsed.type === 'result' ? parsed : null;
  } catch {
    return null;
  }
};

/** Last `system`/`api_retry` category — the most specific failure signal Claude emits. */
const retryCategory = (stdout: string): string | null => {
  let category: string | null = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = rec(JSON.parse(line.trim()));
      if (event.type === 'system' && event.subtype === 'api_retry') {
        // Documented as "an `error` category"; accept either shape it might take.
        category = str(event.error) ?? str(rec(event.error).category) ?? category;
      }
    } catch {
      /* not JSON; skip */
    }
  }
  return category;
};

const usageOf = (result: Record<string, unknown>): Usage => {
  const u = rec(result.usage);
  return {
    inputTokens: num(u.input_tokens),
    cachedInputTokens: num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
  };
};

const failure = (res: ProcResult, result: Record<string, unknown> | null, model: string | null) => {
  const r = result ?? {};
  return claudeError({
    category: retryCategory(res.stdout),
    status: typeof r.api_error_status === 'number' ? r.api_error_status : null,
    text: str(r.result) ?? res.stderr,
    terminalReason: str(r.terminal_reason),
    model,
  });
};

export const createClaudeAdapter = (deps: AdapterDeps): LlmAdapter => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Spawn, then reduce (exit, is_error, events) to either a draft or a ProviderError. */
  const call = async (
    args: string[],
    stdin: string | undefined,
    model: string | null,
  ): Promise<{ draft: unknown; result: Record<string, unknown> }> => {
    const spec: ProcSpec = {
      cmd: 'claude',
      args,
      cwd: deps.tempDirBase,
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
    };
    const res = await deps.runner.run(spec);
    if (res.timedOut) throw timeoutError('Claude', timeoutMs);

    const result = resultEvent(res.stdout);
    // `subtype` stays "success" even on errors — branch on is_error/exit, never it.
    if (result === null || result.is_error === true || res.exitCode !== 0) {
      throw failure(res, result, model);
    }
    if (result.structured_output === undefined) {
      throw noDraftError('Claude', res.stdout.slice(0, 2000));
    }
    return { draft: result.structured_output, result };
  };

  return {
    async refine(input: RefineInput): Promise<RefineResult> {
      const streaming = input.images.length > 0;
      // With images the prompt moves to stdin as a content-block message, and
      // stream-json input REQUIRES stream-json output (+ --verbose) — plain json
      // is rejected outright. Without images, none of that applies.
      const transport = streaming
        ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
        : ['-p', input.text, '--output-format', 'json'];

      const args = [
        ...transport,
        ...HERMETIC,
        '--system-prompt',
        input.systemPrompt,
        '--json-schema',
        JSON.stringify(input.schema),
        ...modelFlags(input.model, input.effort),
      ];
      const stdin = streaming ? userMessageLine(input.text, input.images) : undefined;

      const { draft, result } = await call(args, stdin, input.model);
      const id = str(result.session_id);
      if (id === null) throw noDraftError('Claude', 'result event carried no session_id');

      return {
        draft,
        thread: {
          provider: 'claude',
          id,
          dir: deps.tempDirBase,
          schema: input.schema,
          model: input.model,
          effort: input.effort,
        },
        usage: usageOf(result),
      };
    },

    async followUp(thread: Thread, answers: string[]): Promise<{ draft: unknown }> {
      // Same cwd as turn 1 (set in `call`) — resume lookup is cwd-scoped. The system
      // prompt is already in the session; the schema is per-call, so it is re-sent.
      const args = [
        '-p',
        followUpPrompt(answers),
        '--output-format',
        'json',
        '--resume',
        thread.id,
        ...HERMETIC,
        '--json-schema',
        JSON.stringify(thread.schema),
        ...modelFlags(thread.model, thread.effort),
      ];
      const { draft } = await call(args, undefined, thread.model);
      return { draft };
    },
  };
};
