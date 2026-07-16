import type { ProcessRunner, ProcResult, ProcSession, ProcSpec } from '../runner.ts';

/**
 * The scripted fake behind the seam. Tests drive core modules through their real
 * public API with this in place and assert on external behavior only: the exact
 * argv/stdin handed to `claude`/`codex`/`gh`, and the outcome. Never internals.
 */

export interface Match {
  cmd?: string;
  /** Every string must appear in argv (order-independent — argv order is internals). */
  argsContain?: string[];
}

export interface Response {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /** For `session`: stdout lines, emitted in order. */
  lines?: string[];
  /** Resolve after this many ms of fake time — lets timeout paths be tested. */
  hangs?: boolean;
}

const matches = (m: Match, spec: ProcSpec): boolean => {
  if (m.cmd !== undefined && m.cmd !== spec.cmd) return false;
  return (m.argsContain ?? []).every((a) => spec.args.includes(a));
};

export class FakeRunner implements ProcessRunner {
  /** Every spawn, in order. Assert argv/stdin against this. */
  readonly calls: ProcSpec[] = [];
  private script: Array<{ match: Match; response: Response }> = [];

  /** Later registrations win, so a test can override a shared default. */
  on(match: Match, response: Response): this {
    this.script.unshift({ match, response });
    return this;
  }

  private lookup(spec: ProcSpec): Response {
    const hit = this.script.find((s) => matches(s.match, spec));
    if (!hit) {
      throw new Error(
        `FakeRunner: unscripted spawn ${spec.cmd} ${spec.args.join(' ')}\n` +
          `Script a response with .on({cmd:'${spec.cmd}'}, {...}).`,
      );
    }
    return hit.response;
  }

  async run(spec: ProcSpec): Promise<ProcResult> {
    this.calls.push(spec);
    const r = this.lookup(spec);
    if (r.hangs) {
      // The runner under test owns the timeout; model the kill it performs.
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    }
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
    };
  }

  session(spec: Omit<ProcSpec, 'stdin'>): ProcSession {
    this.calls.push(spec);
    const r = this.lookup(spec as ProcSpec);
    const written: string[] = [];
    let killed = false;
    const result: ProcResult = {
      exitCode: r.exitCode ?? 0,
      stdout: (r.lines ?? []).join('\n'),
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
    };
    return {
      written,
      write: (line: string) => void written.push(line),
      lines: async function* () {
        for (const l of r.lines ?? []) {
          if (killed) return;
          yield l;
        }
      },
      kill: () => void (killed = true),
      done: Promise.resolve(result),
    } as ProcSession & { written: string[] };
  }
}
