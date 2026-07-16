/**
 * The second seam — the filesystem, injected exactly like `ProcessRunner`.
 *
 * `runner.ts` claims every external dependency crosses it "and nothing else".
 * That was true of *processes* and false of *files*: codex takes its system
 * prompt, schema and images only as real paths, drafts must survive a crash, and
 * the discovery cache is a file. Three modules each reached for `node:fs` and
 * each flagged the same doubt. This is the ruling.
 *
 * WHY A PORT AND NOT `@tauri-apps/plugin-fs` DIRECTLY: core is host-agnostic on
 * purpose. Quacket's core runs in a WebView2 renderer today, where `node:fs` does
 * not exist (Vite externalizes it and the build fails). But importing plugin-fs
 * into core would swap one hard host dependency for another and drag a Tauri IPC
 * mock into every test that currently does honest file I/O. Injecting it keeps
 * core truthful about what it needs, lets tests hit a real disk through
 * `nodeFiles`, and puts the one host-specific implementation in `src/app`.
 *
 * DELIBERATELY NOT A MIRROR OF `node:fs`. Two differences, both because every
 * caller wanted them anyway:
 *   - Reads return `null` for "not there" instead of throwing a host-specific
 *     errno. Core must never sniff `e.code === 'ENOENT'` — that is Node dialect,
 *     and plugin-fs does not speak it. A real IO error still throws.
 *   - `remove` is recursive and idempotent; removing nothing is not an error.
 */

/**
 * Pure, host-independent path joining.
 *
 * Always emits `/`. Windows accepts forward slashes at the syscall level (both
 * Node and Rust's `std::path` normalize them), so one separator works everywhere
 * and keeps joined paths comparable in tests. Interior and trailing separators
 * are collapsed, because an injected base dir may or may not carry one —
 * `tempDir()` does, `appDataDir()` does not.
 */
export const joinPath = (...parts: string[]): string => {
  const [head, ...rest] = parts.filter((part) => part !== '');
  if (head === undefined) return '';

  const tail = rest
    .map((part) => part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''))
    .filter((part) => part !== '');

  // A head that is nothing but separators is the filesystem root. Stripping it
  // to '' would silently turn an absolute path into a relative one.
  const base = head.replace(/[\\/]+$/, '');
  const root = base === '' ? '/' : base;

  if (tail.length === 0) return root;
  return root === '/' ? `/${tail.join('/')}` : `${root}/${tail.join('/')}`;
};

export interface FileStore {
  /** Creates the directory and every missing parent. Already existing is fine. */
  mkdirp(dir: string): Promise<void>;
  /** `null` iff the file does not exist. A real IO error throws. */
  readText(path: string): Promise<string | null>;
  /** `null` iff the file does not exist. A real IO error throws. */
  readBytes(path: string): Promise<Uint8Array | null>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Entry names, not paths. `null` iff the directory does not exist. */
  list(dir: string): Promise<string[] | null>;
  /** Atomic within a filesystem — what makes a torn write unobservable. */
  rename(from: string, to: string): Promise<void>;
  /** Recursive and idempotent: removing something absent is a no-op. */
  remove(path: string): Promise<void>;
}
