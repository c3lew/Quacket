/**
 * The real `ProcessRunner` — the one production implementation behind the
 * `src/core/runner.ts` seam. Core modules take that interface by injection and
 * are driven in tests by `FakeRunner`; this is the module that has to make the
 * interface's promises true against a real `claude` / `codex` / `gh`.
 *
 * ── Why this talks to our own Rust and not tauri-plugin-shell ────────────────
 *
 * The seam promises two things the plugin cannot deliver:
 *
 *   1. "Stdin is written and then CLOSED — always, even when there is none."
 *      plugin-shell 2.3.5 has five IPC commands (`execute`, `spawn`,
 *      `stdin_write`, `kill`, `open`) and no `stdin_close`. `execute()` closes
 *      stdin but accepts none; `spawn()` writes stdin but can never send EOF.
 *      Measured on this machine: `gh api graphql --input -` without EOF returns
 *      HTTP 400 after 10.3 s (0.6 s and correct with EOF), and
 *      `claude -p --input-format stream-json` without EOF emits its complete
 *      result at 2.8 s and then never exits. Those are wrong answers, not slow
 *      ones — which is why this module used to throw `STDIN_UNSUPPORTED` rather
 *      than launch a process that would lie.
 *
 *   2. "A timeout kills the child." `execute()` returns no pid, so the old
 *      `run` resolved `timedOut: true` while the CLI kept running. Neither CLI
 *      has a built-in timeout (docs/research/headless-cli-invocation-contract.md:
 *      "Adapter must enforce (kill process)"), so that was an orphan per
 *      timeout in a tray app whose pitch is a 40–80 MB idle footprint.
 *
 * Both are the same missing thing — nobody owned the child — and both dissolve
 * in `src-tauri/src/proc.rs`, which owns it. Rust stays thin: it spawns, moves
 * bytes, kills, and enforces the allowlist. Every decision is still here or in
 * core.
 *
 * This file is now a translator, and that is the whole idea: `ProcSpec` in,
 * `quacket_run` / `quacket_spawn` out, with the timeout and the stdin close
 * enforced where a process actually exists.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import type { ProcResult, ProcSession, ProcSpec, ProcessRunner } from '../core/runner.ts';

/**
 * The Rust side's `Spec`. Nulls are explicit rather than omitted so the payload
 * shape never depends on serde's treatment of a missing field.
 *
 * `program` is not a suggestion: `proc.rs` matches it against a three-name
 * allowlist and spawns a compile-time literal, so nothing assembled here can
 * widen what Quacket is able to run. Note there is no `codex.cmd` special case
 * left — resolving codex's npm shim is Rust's job now, where `cfg!(windows)` is
 * the truth instead of a `navigator.userAgent` sniff.
 */
const specOf = (spec: ProcSpec, timeoutMs: number | null) => ({
  program: spec.cmd,
  args: spec.args,
  stdin: spec.stdin ?? null,
  cwd: spec.cwd ?? null,
  env: spec.env ?? null,
  timeoutMs,
});

/** What `proc.rs` streams over the session channel. */
type Event =
  | { event: 'stdout'; data: string }
  | { event: 'stderr'; data: string }
  | { event: 'terminated'; data: { code: number | null } };

/**
 * The timeout is Rust's, not a `Promise.race` here: only the side holding the
 * child can turn "too slow" into a dead process rather than an ignored one.
 */
const run = (spec: ProcSpec): Promise<ProcResult> =>
  invoke<ProcResult>('quacket_run', { spec: specOf(spec, spec.timeoutMs ?? null) });

const session = (spec: Omit<ProcSpec, 'stdin'>): ProcSession => {
  // stdout arrives one line per event — Rust splits it — so `lines()` is a
  // queue drain, not a parser. The control protocols are newline-delimited
  // JSON, and a half-arrived line would be a parse error, not a partial read.
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  let stderr = '';
  let exitCode: number | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let settle!: (r: ProcResult) => void;
  const done = new Promise<ProcResult>((resolve) => {
    settle = resolve;
  });

  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    nudge();
    settle({ exitCode, stdout: '', stderr, timedOut });
  };

  const channel = new Channel<Event>();
  channel.onmessage = (message) => {
    if (message.event === 'stdout') {
      queue.push(message.data);
      nudge();
      return;
    }
    if (message.event === 'stderr') {
      stderr += message.data;
      return;
    }
    exitCode = message.data.code;
    finish();
  };

  // `timeoutMs: null` on purpose — a session's timeout is a kill, not a
  // deadline Rust could own. The caller keeps the lines it already read and
  // needs `done` to say `timedOut`, so the timer lives here and only the kill
  // crosses to Rust. (`run` is the opposite: nothing survives its timeout, so
  // the deadline belongs next to the child.)
  const spawned = invoke<number>('quacket_spawn', {
    spec: specOf(spec, null),
    onEvent: channel,
  });
  // A spawn that never starts — program off the allowlist, PATH miss — must not
  // leave `lines()` and `done` hanging forever.
  spawned.catch((e: unknown) => {
    stderr += String(e);
    finish();
  });

  const kill = () => {
    void spawned.then((id) => invoke('quacket_kill', { id })).catch(() => {});
  };

  if (spec.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
  }

  // Writes are chained so they reach stdin in call order: each is an async IPC
  // round-trip, and the control protocols depend on request ordering.
  let tail: Promise<unknown> = spawned;

  return {
    write: (line: string) => {
      const buffer = line.endsWith('\n') ? line : `${line}\n`;
      tail = tail
        .then(() => spawned)
        .then((id) => invoke('quacket_stdin_write', { id, buffer }))
        .catch((e: unknown) => {
          stderr += String(e);
        });
    },
    lines: async function* () {
      for (;;) {
        const line = queue.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    kill,
    done,
  };
};

/** The one production `ProcessRunner`. */
export const tauriRunner: ProcessRunner = { run, session };
