/**
 * A real `FileStore` backed by `node:fs`, for tests.
 *
 * This is not a fake — it hits a real disk. Tests that persist a draft, "crash",
 * and reload it are only honest if the bytes actually made a round trip through
 * a filesystem, so nothing here is stubbed. It lives under `testing/` purely
 * because Quacket ships as a WebView2 renderer, where Node does not exist: the
 * app's real implementation is `src/app/files.ts`. Nothing in production imports
 * this file, which is what keeps `node:fs` out of the Vite bundle.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FileStore } from '../files.ts';

/** Node reports "not there" as ENOENT; the port reports it as `null`. */
const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

export const nodeFiles: FileStore = {
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  readText: (path) => orNull(() => readFile(path, 'utf8')),
  readBytes: async (path) => {
    const buf = await orNull(() => readFile(path));
    // Buffer is a Uint8Array view over a pooled ArrayBuffer; copying keeps a
    // caller's `bytes` from aliasing Node's read buffer.
    return buf === null ? null : new Uint8Array(buf);
  },
  writeText: (path, text) => writeFile(path, text, 'utf8'),
  writeBytes: (path, bytes) => writeFile(path, bytes),
  list: (dir) => orNull(() => readdir(dir)),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
};
