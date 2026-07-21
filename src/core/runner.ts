/**
 * The single test seam.
 *
 * Every external dependency Quacket has — `claude`, `codex`, `gh` — crosses this
 * boundary and nothing else. Core modules never import a process API directly;
 * they take a `ProcessRunner` and are driven in tests by a scripted fake.
 *
 * Two shapes, because the CLIs need two:
 *   - `run`     one-shot spawn (refine calls, every `gh` call). Most things.
 *   - `session` spawn → write → read → kill, for the request/response control
 *               protocols used by discovery (`claude` stream-json `initialize`,
 *               transient `codex app-server` JSON-RPC).
 */

export interface ProcSpec {
  cmd: string;
  args: string[];
  /**
   * Written to stdin, which is then closed. Stdin is ALWAYS closed, even when
   * this is undefined: `claude` stalls 3s on a piped-but-empty stdin and `codex`
   * appends whatever it reads as a bogus `<stdin>` block.
   */
  stdin?: string;
  cwd?: string;
  /** Neither CLI has a built-in timeout — enforcing it is entirely our job. */
  timeoutMs?: number;
}

export interface ProcResult {
  /** null when the process was killed rather than exiting on its own. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcSession {
  /** Appends a newline if the line lacks one. */
  write(line: string): void;
  /** stdout, newline-delimited, as it arrives. Ends when the process exits. */
  lines(): AsyncIterableIterator<string>;
  kill(): void;
  done: Promise<ProcResult>;
}

export interface ProcessRunner {
  run(spec: ProcSpec): Promise<ProcResult>;
  session(spec: Omit<ProcSpec, 'stdin'>): ProcSession;
}

// A timeout is reported as `ProcResult.timedOut`, never thrown: it is an outcome
// of the run, not an exception, and every caller already branches on the result.
// (An unused `ProcessTimeout` class used to live here promising the opposite.)
