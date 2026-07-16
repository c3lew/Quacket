/**
 * The real `FileStore`: `@tauri-apps/plugin-fs`, the only filesystem the shipped
 * app has. Sits beside `runner.ts` for the same reason — this is the layer that
 * is allowed to know it is running inside Tauri, so core never has to.
 *
 * Every method here is a separate ACL grant. plugin-fs permissions are strictly
 * PER-COMMAND — `fs:allow-read-file` buys `read_file` and nothing else — which
 * is why `capabilities/default.json` lists all nine commands this file touches
 * (the eight `FileStore` methods plus `exists`, which `orNull` needs). The
 * shipped app once granted only the first of them, and no test in `src/**`
 * could see it: vitest fakes the IPC boundary, so the ACL is always wide open
 * under test. `src-tauri/src/capabilities.rs` reads the import statement below
 * and fails if any name in it is ungranted.
 *
 * Scope: `$APPDATA` + `$TEMP/quacket` (the two dirs `services.ts` injects) for
 * everything. The single exception is `readFile`, which `src/ui/main.tsx` also
 * calls on whatever path a drag-and-drop hands it.
 */

import { exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { FileStore } from '../core/files.ts';

/**
 * plugin-fs raises an opaque error rather than an errno, so "missing" cannot be
 * read off the failure itself. Asking whether the path exists is the honest
 * discrimination: absent means the miss the port promises, present means a real
 * IO error that must not be swallowed into a silent `null`.
 */
const orNull = async <T>(path: string, read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (e) {
    if (await exists(path)) throw e;
    return null;
  }
};

export const tauriFiles: FileStore = {
  mkdirp: (dir) => mkdir(dir, { recursive: true }),
  readText: (path) => orNull(path, () => readTextFile(path)),
  readBytes: (path) => orNull(path, () => readFile(path)),
  writeText: (path, text) => writeTextFile(path, text),
  writeBytes: (path, bytes) => writeFile(path, bytes),
  list: (dir) => orNull(dir, async () => (await readDir(dir)).map((entry) => entry.name)),
  rename: (from, to) => rename(from, to),
  // `remove` rejects on a missing path, which the port defines as a no-op.
  remove: async (path) => {
    if (await exists(path)) await remove(path, { recursive: true });
  },
};
