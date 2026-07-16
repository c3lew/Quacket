import { joinPath } from '../files.ts';
import type { ProcSpec } from '../runner.ts';
import type { ImageAttachment } from '../types.ts';
import { DEFAULT_TIMEOUT_MS, followUpPrompt } from './adapter.ts';
import type { AdapterDeps, LlmAdapter, RefineInput, RefineResult, Thread, Usage } from './adapter.ts';
import { codexError, noDraftError, timeoutError } from './errors.ts';

/**
 * Codex transport: spawn-per-call against a per-draft scratch directory.
 *
 * The directory is not a convenience — three of Codex's inputs exist only as
 * files. There is no `--system-prompt` flag (an AGENTS.md in the `-C` dir is the
 * documented substitute), `--output-schema` takes a path rather than inline JSON,
 * and `-i` takes image paths with no base64 route. So the adapter writes them,
 * and turn 2 reuses the same directory.
 */

const AGENTS_MD = 'AGENTS.md';
const SCHEMA_JSON = 'schema.json';

/**
 * The prompt travels on STDIN, not in argv. `-` is codex's documented sentinel
 * for it (`codex exec --help`: "If not provided as an argument (or if `-` is
 * used), instructions are read from stdin"), and `exec resume` says the same.
 *
 * This is not a style choice — argv cannot carry the prompt at all on Windows,
 * Quacket's primary platform. npm ships codex as a `.cmd` batch shim, so
 * `proc.rs::shim()` spawns `codex.cmd`, and Rust's `std::process::Command`
 * REFUSES to launch a batch file with any argument containing a newline
 * (CVE-2024-24576 hardening) — not a mangled arg, a hard spawn error:
 *
 *   Command::new("codex.cmd").args(["--", "a\nb"]).spawn()
 *     => Err(InvalidInput, "batch file arguments are invalid")
 *
 * `buildUserPrompt()` is multi-line by construction (`<raw_report>\n…`), so
 * EVERY refine hit that, and every follow-up carrying answers did too. Verified
 * live against codex-cli 0.144.4 + rustc 1.95.0; see
 * docs/research/live-verification-round4.md.
 *
 * Stdin is the fix rather than a workaround: it is the route codex documents for
 * exactly this, and it also lifts the prompt out of the ~32 KB command-line
 * limit that a long report plus an open-issue list can reach.
 */
const PROMPT_FROM_STDIN = '-';

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const EXTENSION: Record<ImageAttachment['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * `-c` values are passed unquoted on purpose. The research doc writes
 * `-c model_reasoning_effort="low"` because that is *shell* syntax — the shell
 * strips the quotes before codex sees them. We spawn without a shell, so quoting
 * here would make the value literally `"low"`.
 */
const config = (key: string, value: string): string[] => ['-c', `${key}=${value}`];

const effortFlags = (effort: string | null): string[] =>
  effort === null ? [] : config('model_reasoning_effort', effort);

const modelFlags = (model: string | null): string[] => (model === null ? [] : ['-m', model]);

const events = (stdout: string): Record<string, unknown>[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) => {
      try {
        return [rec(JSON.parse(line))];
      } catch {
        return [];
      }
    });

/**
 * The final agent message is the schema-conforming JSON string. `-o <file>` writes
 * the same bytes, but we already parse this stream for thread_id/usage/turn.failed,
 * so the file would be a second source of the same truth — and a filesystem read
 * we don't need.
 */
const agentMessage = (stream: Record<string, unknown>[]): string | null => {
  for (let i = stream.length - 1; i >= 0; i--) {
    const event = stream[i]!;
    if (event.type !== 'item.completed') continue;
    const item = rec(event.item);
    if (item.type === 'agent_message') return str(item.text);
  }
  return null;
};

/**
 * Only `turn.failed` and a top-level `error` event are fatal.
 *
 * An `item.type: "error"` is NOT — non-fatal error *items* show up in every run,
 * hermetic ones included, while the turn still succeeds. Matching on the
 * top-level `type` is what keeps the two apart.
 */
const failureMessage = (stream: Record<string, unknown>[]): string | null => {
  const failed = stream.findLast((e) => e.type === 'turn.failed');
  if (failed !== undefined) return str(rec(failed.error).message) ?? JSON.stringify(failed.error);

  const error = stream.findLast((e) => e.type === 'error');
  if (error !== undefined) return str(error.message) ?? JSON.stringify(error);

  return null;
};

const usageOf = (stream: Record<string, unknown>[]): Usage => {
  const u = rec(stream.findLast((e) => e.type === 'turn.completed')?.usage);
  return {
    inputTokens: num(u.input_tokens),
    cachedInputTokens: num(u.cached_input_tokens),
    outputTokens: num(u.output_tokens),
    costUsd: null, // Codex reports no cost at all on a subscription.
  };
};

export const createCodexAdapter = (deps: AdapterDeps): LlmAdapter => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async (args: string[], cwd: string, model: string | null, prompt: string) => {
    const spec: ProcSpec = { cmd: 'codex', args, cwd, timeoutMs, stdin: prompt };
    const res = await deps.runner.run(spec);
    if (res.timedOut) throw timeoutError('Codex', timeoutMs);

    const stream = events(res.stdout);
    const failed = failureMessage(stream);
    if (failed !== null && res.exitCode !== 0) throw codexError(failed, model);
    if (res.exitCode !== 0) throw codexError(res.stderr, model);

    const message = agentMessage(stream);
    if (message === null) throw noDraftError('Codex', res.stdout.slice(0, 2000));
    try {
      return { draft: JSON.parse(message) as unknown, stream };
    } catch {
      throw noDraftError('Codex', message.slice(0, 2000));
    }
  };

  return {
    async refine(input: RefineInput): Promise<RefineResult> {
      const dir = joinPath(deps.tempDirBase, `codex-${crypto.randomUUID()}`);
      await deps.files.mkdirp(dir);

      // No --system-prompt flag exists; AGENTS.md in the -C dir is the substitute.
      await deps.files.writeText(joinPath(dir, AGENTS_MD), input.systemPrompt);
      await deps.files.writeText(joinPath(dir, SCHEMA_JSON), JSON.stringify(input.schema));
      const imagePaths = await Promise.all(
        input.images.map(async (image) => {
          const path = joinPath(dir, `${image.id}.${EXTENSION[image.mediaType]}`);
          await deps.files.writeBytes(path, image.bytes);
          return path;
        }),
      );

      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--json',
        '-C',
        dir,
        // The user's config had danger-full-access; never inherit the sandbox.
        '-s',
        'read-only',
        ...effortFlags(input.effort),
        ...modelFlags(input.model),
        '--output-schema',
        joinPath(dir, SCHEMA_JSON),
        ...imagePaths.flatMap((path) => ['-i', path]),
        // `-i` is variadic, so without `--` the sentinel is swallowed as an image path.
        '--',
        PROMPT_FROM_STDIN,
      ];

      const { draft, stream } = await call(args, dir, input.model, input.text);
      const id = str(stream.find((e) => e.type === 'thread.started')?.thread_id);
      if (id === null) throw noDraftError('Codex', 'no thread.started event');

      return {
        draft,
        thread: {
          provider: 'codex',
          id,
          dir,
          schema: input.schema,
          model: input.model,
          effort: input.effort,
        },
        usage: usageOf(stream),
      };
    },

    async followUp(thread: Thread, answers: string[]): Promise<{ draft: unknown }> {
      // `exec resume` has no -C and no -s, so the sandbox goes through -c and the
      // working directory through the spawn itself. The prompt is positional here
      // (no `--`: nothing variadic precedes it), and --ephemeral was never passed
      // on turn 1 — it would have made this thread unresumable.
      const args = [
        'exec',
        'resume',
        thread.id,
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--json',
        ...config('sandbox_mode', 'read-only'),
        ...effortFlags(thread.effort),
        ...modelFlags(thread.model),
        '--output-schema',
        joinPath(thread.dir, SCHEMA_JSON),
        PROMPT_FROM_STDIN,
      ];
      const { draft } = await call(args, thread.dir, thread.model, followUpPrompt(answers));
      return { draft };
    },
  };
};
