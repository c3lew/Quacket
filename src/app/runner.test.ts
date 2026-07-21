/**
 * The runner is the one module with no ProcessRunner to fake — it IS the
 * ProcessRunner. So the fake goes all the way down to the real boundary:
 * `window.__TAURI_INTERNALS__`, the object Rust injects into the webview.
 * Everything above it runs for real (`invoke`, the real `Channel` class and its
 * callback registration), and what we assert is exactly the payload that would
 * cross to `src-tauri/src/proc.rs` and become argv/stdin for `claude` / `codex`
 * / `gh`.
 *
 * WHAT THIS FILE CANNOT PROVE, AND WHERE IT IS PROVEN INSTEAD. That stdin is
 * actually closed, and that a timeout actually kills the child, are facts about
 * a real process — a mocked `invoke` will happily agree with either answer.
 * That is exactly how the old runner shipped a dead submit pipeline behind
 * green tests. Those two live in `src-tauri/src/proc.rs`'s `#[cfg(test)]`
 * tests, which spawn a real process and check the pid against the OS
 * (`cargo test`). Here we pin only what belongs here: the payload, and the
 * decisions this module makes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriRunner } from './runner.ts';

interface Invocation {
  cmd: string;
  payload: Record<string, unknown>;
}
/** The real `Channel`; `id` is the callback because `transformCallback` is faked to identity. */
type Emitter = { onmessage: (message: unknown) => void };

let calls: Invocation[] = [];
let reply: (cmd: string, payload: Record<string, unknown>) => unknown;

const install = () => {
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, payload: Record<string, unknown>) => {
        calls.push({ cmd, payload });
        return reply(cmd, payload);
      },
      transformCallback: (cb: unknown) => cb,
      unregisterCallback: () => {},
    },
  });
};

/** Scripts the Rust replies; anything unscripted is a test bug, so it throws. */
const script = (handlers: Record<string, (p: Record<string, unknown>) => unknown>) => {
  reply = (cmd, payload) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unscripted IPC call: ${cmd}`);
    return handler(payload);
  };
};

const ran = (out: Partial<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> = {}) =>
  script({
    quacket_run: () => ({
      // `?? 0` here would swallow an explicitly scripted null exit code.
      exitCode: 'exitCode' in out ? out.exitCode : 0,
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? '',
      timedOut: out.timedOut ?? false,
    }),
  });

/** Scripts a spawn and captures the real Channel so a test can drive stdout. */
const spawned = () => {
  const channel: { current: Emitter | null } = { current: null };
  script({
    quacket_spawn: (p) => {
      channel.current = p['onEvent'] as Emitter;
      return 7;
    },
    quacket_stdin_write: () => undefined,
    quacket_kill: () => undefined,
  });
  return channel;
};

const emit = (c: { current: Emitter | null }, event: string, data: unknown) =>
  c.current?.onmessage({ event, data });

/** Lets queued promise callbacks run without leaning on real time. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const only = (cmd: string) => calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  calls = [];
  install();
});

describe('run', () => {
  it('hands the exact program and argv to the CLI', async () => {
    ran({ stdout: '[]' });

    await tauriRunner.run({
      cmd: 'gh',
      args: ['issue', 'list', '--repo', 'o/r', '--json', 'number'],
    });

    expect(only('quacket_run')).toHaveLength(1);
    expect(calls[0]?.payload['spec']).toMatchObject({
      program: 'gh',
      args: ['issue', 'list', '--repo', 'o/r', '--json', 'number'],
    });
  });

  it('delivers stdin to the CLI', async () => {
    ran({ stdout: '{"number":12}' });

    const r = await tauriRunner.run({
      cmd: 'gh',
      args: ['issue', 'create', '--body-file', '-'],
      stdin: 'the issue body',
    });

    // The submit pipeline's whole existence. This used to throw
    // STDIN_UNSUPPORTED because tauri-plugin-shell could not close a child's
    // stdin, and `gh` answers HTTP 400 on a stdin that never reaches EOF.
    expect(calls[0]?.payload['spec']).toMatchObject({ stdin: 'the issue body' });
    expect(r.stdout).toBe('{"number":12}');
  });

  it('sends an explicit null rather than omitting an absent stdin', async () => {
    ran();

    await tauriRunner.run({ cmd: 'claude', args: ['-p', 'hi'] });

    // Rust closes stdin either way, and it must: `claude` stalls 3s on a
    // piped-but-empty stdin and `codex` appends whatever it reads as a bogus
    // <stdin> block. An explicit null keeps the payload shape from depending on
    // serde's treatment of a missing field.
    expect(calls[0]?.payload['spec']).toMatchObject({ stdin: null });
  });

  it('reports exit code, stdout and stderr', async () => {
    ran({ exitCode: 1, stdout: 'out', stderr: 'boom' });

    const r = await tauriRunner.run({ cmd: 'gh', args: ['auth', 'status'] });

    expect(r).toEqual({ exitCode: 1, stdout: 'out', stderr: 'boom', timedOut: false });
  });

  it('passes a null exit code through rather than coercing it to a number', async () => {
    ran({ exitCode: null });

    const r = await tauriRunner.run({ cmd: 'gh', args: ['x'] });

    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('forwards cwd and nulls it when unset', async () => {
    ran();

    await tauriRunner.run({ cmd: 'claude', args: ['-p'], cwd: '/tmp/x' });
    expect(calls[0]?.payload['spec']).toMatchObject({ cwd: '/tmp/x' });
    expect(calls[0]?.payload['spec']).not.toHaveProperty('env');

    await tauriRunner.run({ cmd: 'claude', args: ['-p'] });
    expect(calls[1]?.payload['spec']).toMatchObject({ cwd: null });
    expect(calls[1]?.payload['spec']).not.toHaveProperty('env');
  });

  it('hands the timeout to the side that holds the child', async () => {
    ran();

    await tauriRunner.run({ cmd: 'codex', args: ['exec'], timeoutMs: 120_000 });

    // Load-bearing: a `Promise.race` here would resolve `timedOut` while the CLI
    // kept running, which is what the old `execute()`-based runner did. Only
    // the owner of the process can turn "too slow" into a dead process.
    expect(calls[0]?.payload['spec']).toMatchObject({ timeoutMs: 120_000 });
  });

  it('reports the timeout Rust enforced, and does not race one of its own', async () => {
    vi.useFakeTimers();
    try {
      ran({ exitCode: null, timedOut: true });

      const r = await tauriRunner.run({ cmd: 'codex', args: ['exec'], timeoutMs: 120_000 });

      // No timer of ours is pending: the answer came from the process, not a clock.
      expect(vi.getTimerCount()).toBe(0);
      expect(r).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no timeout when the caller set none', async () => {
    ran({ stdout: 'late' });

    const r = await tauriRunner.run({ cmd: 'gh', args: ['x'] });

    expect(calls[0]?.payload['spec']).toMatchObject({ timeoutMs: null });
    expect(r.stdout).toBe('late');
  });
});

describe('program names', () => {
  it('names the tool, never a platform-specific binary', async () => {
    ran();

    await tauriRunner.run({ cmd: 'codex', args: ['exec'] });
    await tauriRunner.run({ cmd: 'claude', args: ['-p'] });
    await tauriRunner.run({ cmd: 'gh', args: ['auth', 'status'] });

    // Resolving codex's npm `.cmd` shim is Rust's job (`proc::shim`), where
    // `cfg!(windows)` is the truth rather than a `navigator.userAgent` sniff,
    // and where the allowlist can stay exactly three names wide — the frontend
    // cannot even name `codex.cmd`.
    expect(calls.map((c) => (c.payload['spec'] as { program: string }).program)).toEqual([
      'codex',
      'claude',
      'gh',
    ]);
  });
});

describe('session', () => {
  it('hands the exact program and argv to the CLI', async () => {
    const c = spawned();

    tauriRunner.session({ cmd: 'codex', args: ['app-server'] });
    await settle();

    expect(only('quacket_spawn')).toHaveLength(1);
    expect(calls[0]?.payload['spec']).toMatchObject({ program: 'codex', args: ['app-server'] });
    expect(c.current).not.toBeNull();
  });

  it('yields stdout lines in arrival order and ends when the process exits', async () => {
    const c = spawned();
    const s = tauriRunner.session({ cmd: 'claude', args: ['--input-format', 'stream-json'] });

    const collected: string[] = [];
    const reading = (async () => {
      for await (const line of s.lines()) collected.push(line);
    })();

    await settle();
    emit(c, 'stdout', '{"id":1}');
    emit(c, 'stdout', '{"id":2}');
    await settle();
    emit(c, 'terminated', { code: 0 });
    await reading;

    expect(collected).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('delivers lines buffered before the reader started', async () => {
    const c = spawned();
    const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'] });

    await settle();
    emit(c, 'stdout', 'early');
    emit(c, 'terminated', { code: 0 });

    const collected: string[] = [];
    for await (const line of s.lines()) collected.push(line);

    // Replies can land before anything iterates; dropping them would lose the
    // control-protocol response the caller is waiting on.
    expect(collected).toEqual(['early']);
  });

  it('writes the exact stdin line to the CLI, adding the newline the protocol needs', async () => {
    spawned();
    const s = tauriRunner.session({ cmd: 'claude', args: ['-p'] });

    s.write('{"type":"control_request"}');
    await settle();

    expect(only('quacket_stdin_write')[0]?.payload).toEqual({
      id: 7,
      buffer: '{"type":"control_request"}\n',
    });
  });

  it('does not double up a newline the caller already wrote', async () => {
    spawned();
    const s = tauriRunner.session({ cmd: 'claude', args: ['-p'] });

    s.write('{"a":1}\n');
    await settle();

    expect(only('quacket_stdin_write')[0]?.payload['buffer']).toBe('{"a":1}\n');
  });

  it('writes in call order', async () => {
    spawned();
    const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'] });

    s.write('first');
    s.write('second');
    s.write('third');
    await settle();

    expect(only('quacket_stdin_write').map((c) => c.payload['buffer'])).toEqual([
      'first\n',
      'second\n',
      'third\n',
    ]);
  });

  it('keeps stdin open, unlike run', async () => {
    spawned();
    tauriRunner.session({ cmd: 'claude', args: ['-p'] });
    await settle();

    // The one thing that makes a session a different shape from a run: the
    // control protocols write a request and read a reply, so an EOF after the
    // first write would end the conversation.
    expect(calls[0]?.payload['spec']).toMatchObject({ stdin: null, timeoutMs: null });
  });

  it('kills the child on request', async () => {
    spawned();
    const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'] });

    s.kill();
    await settle();

    expect(only('quacket_kill')[0]?.payload).toMatchObject({ id: 7 });
  });

  it('resolves done with the exit code and stderr', async () => {
    const c = spawned();
    const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'] });

    await settle();
    emit(c, 'stderr', 'warning: ');
    emit(c, 'stderr', 'deprecated');
    emit(c, 'terminated', { code: 3 });

    expect(await s.done).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'warning: deprecated',
      timedOut: false,
    });
  });

  it('kills the child and reports timedOut when the protocol stalls', async () => {
    vi.useFakeTimers();
    try {
      const c = spawned();
      const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'], timeoutMs: 30_000 });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(only('quacket_kill')).toHaveLength(1);

      emit(c, 'terminated', { code: null });
      expect(await s.done).toMatchObject({ timedOut: true, exitCode: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not kill a session that answers inside its timeout', async () => {
    vi.useFakeTimers();
    try {
      const c = spawned();
      const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'], timeoutMs: 30_000 });

      await vi.advanceTimersByTimeAsync(10);
      emit(c, 'terminated', { code: 0 });
      await s.done;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(only('quacket_kill')).toHaveLength(0);
      expect((await s.done).timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends lines() and done when the process never starts', async () => {
    script({
      quacket_spawn: () => {
        throw new Error('program not allowed: nmap');
      },
    });
    const s = tauriRunner.session({ cmd: 'codex', args: ['app-server'] });

    const collected: string[] = [];
    for await (const line of s.lines()) collected.push(line);
    const r = await s.done;

    // A PATH miss or an allowlist rejection must surface, not hang the caller.
    expect(collected).toEqual([]);
    expect(r.stderr).toContain('program not allowed');
  });
});
