/**
 * The `gh` spawn itself — the one place a GitHub call becomes a process.
 *
 * Split out of `github.ts` when Filing took ownership of every WRITE (issue and
 * comment creation, asset upload, body rendering, error mapping) and `github.ts`
 * kept only authentication and read-oriented discovery. Both halves still shell
 * out through the same ProcessRunner seam with the same timeouts and the same
 * user-facing error type, and that agreement is worth one shared file rather
 * than two copies that drift.
 *
 * No process API is imported and no token is ever handled: `gh` owns the
 * credential.
 */

import type { ProcessRunner, ProcResult, ProcSpec } from '../runner.ts';

/** Subset of Draft.lastError['kind'] that a GitHub call can produce. */
export type GitHubErrorKind = 'not_authenticated' | 'upload_failed' | 'create_failed';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    /** Plain language; the UI shows this as-is. */
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const READ_TIMEOUT_MS = 30_000;
/** Uploads carry megabytes of base64, so they get a longer leash. */
const WRITE_TIMEOUT_MS = 120_000;

/**
 * Belt and braces, and the braces are the real ones.
 *
 * This used to claim `gh <cmd> --json` prints empty stdout rather than `[]` on an
 * empty listing, "verified against gh 2.90.0". That was checked against live gh
 * 2.90.0 in round 4 and is FALSE: an empty listing prints `[]\n`, which parses to
 * `[]` and never reaches the fallback. The claim was wrong; the code is not, so
 * nothing here changed but the sentence.
 *
 * The guard stays because it is cheap and the honest reason is a better one than
 * the invented one: stdout we did not get to see (a killed child, a gh that
 * writes nothing on some path we have not hit) must not become a `JSON.parse('')`
 * throw miles from the cause.
 */
export const parseJson = <T>(stdout: string, fallback: T): T => {
  const text = stdout.trim();
  return text === '' ? fallback : (JSON.parse(text) as T);
};

export const lastLine = (stdout: string): string =>
  stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop() ?? '';

export interface Gh {
  /** The raw spawn: the caller judges the exit code itself. */
  run(args: string[], stdin?: string): Promise<ProcResult>;
  /** Runs `gh`, throwing a user-facing error unless it exited 0. */
  ok(kind: GitHubErrorKind, message: string, args: string[], stdin?: string): Promise<ProcResult>;
}

export const createGh = (runner: ProcessRunner): Gh => {
  const run = async (args: string[], stdin?: string): Promise<ProcResult> => {
    const spec: ProcSpec = {
      cmd: 'gh',
      args,
      timeoutMs: stdin === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    };
    if (stdin !== undefined) spec.stdin = stdin;
    return runner.run(spec);
  };

  return {
    run,
    ok: async (kind, message, args, stdin) => {
      const result = await run(args, stdin);
      if (result.timedOut) {
        throw new GitHubError(kind, `${message} GitHub took too long to respond.`);
      }
      if (result.exitCode !== 0) throw new GitHubError(kind, message, result.stderr.trim());
      return result;
    },
  };
};
