import type { FileStore } from '../files.ts';
import type { ProcessRunner } from '../runner.ts';
import type { ImageAttachment, ProviderId } from '../types.ts';

/**
 * One interface, two very different transports.
 *
 * Claude is a single spawn with everything inline (base64 images on stdin, schema
 * as a flag). Codex is spawn-per-call against a scratch directory, because three
 * of its inputs — the system prompt, the schema, and every image — exist only as
 * files. Both differences are the CLIs', not ours; see
 * `docs/research/headless-cli-invocation-contract.md`.
 *
 * The adapter owns transport and error mapping and nothing else. It hands back
 * the RAW structured object the provider produced; turning that into a
 * `RefinedDraft` is the refine-contract module's job.
 */

export interface RefineInput {
  /** The user's raw report. Passed to the model verbatim. */
  text: string;
  images: ImageAttachment[];
  schema: object;
  systemPrompt: string;
  /** null → let the CLI pick. Always pinned in practice; defaults drift. */
  model: string | null;
  /** null → omit the flag entirely (the model may not take one). */
  effort: string | null;
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** null for Codex: subscription runs report no cost at all, ever. */
  costUsd: number | null;
}

/**
 * A resume handle for the follow-up turn.
 *
 * Serializable, so a draft can carry it across a restart. It holds `dir` because
 * both providers bind a session to one: Claude's `--resume` lookup is cwd-scoped,
 * and Codex's scratch files (schema, images) must still be there on turn 2. It
 * holds schema/model/effort because those are per-call flags, not session state —
 * turn 2 has to re-send them.
 */
export interface Thread {
  provider: ProviderId;
  /** Claude `session_id` / Codex `thread_id`. */
  id: string;
  dir: string;
  schema: object;
  model: string | null;
  effort: string | null;
}

export interface RefineResult {
  /** Raw, provider-shaped. Parsing is refine-contract's job, not ours. */
  draft: unknown;
  thread: Thread;
  usage: Usage;
}

export interface LlmAdapter {
  refine(input: RefineInput): Promise<RefineResult>;
  followUp(thread: Thread, answers: string[]): Promise<{ draft: unknown }>;
}

export interface AdapterDeps {
  runner: ProcessRunner;
  /**
   * The filesystem, injected like `runner` — see `core/files.ts`. Required even
   * though only the Codex adapter writes: `createAdapter` is provider-agnostic
   * by design, so the caller cannot know whether this call needs a disk.
   */
  files: FileStore;
  /**
   * Scratch root. Injected, never resolved here — the same seam `drafts/store.ts`
   * uses. Claude runs both turns with this as cwd; Codex gets a subdir per draft.
   */
  tempDirBase: string;
  timeoutMs?: number;
}

/** Neither CLI has a timeout flag. Sized for Codex's high-effort tail (14–48 s). */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The second-turn prompt.
 *
 * Numbers survive skipped answers so they still line up with the questions the
 * model asked on turn 1 — which are already in the resumed session, so we never
 * re-send them.
 */
export const followUpPrompt = (answers: string[]): string => {
  const given = answers
    .map((answer, i) => ({ n: i + 1, answer: answer.trim() }))
    .filter(({ answer }) => answer !== '');

  if (given.length === 0) {
    return 'I have no more information to add. Produce the final draft using only what you already have. Do not invent anything.';
  }
  return (
    'Answers to your follow-up questions, numbered as you asked them. ' +
    'Any number missing below was skipped — treat it as unknown and do not invent it.\n' +
    given.map(({ n, answer }) => `${n}. ${answer}`).join('\n')
  );
};
