/**
 * The entry point: build the platform, wire it to the app-layer services, mount.
 *
 * `src/app/services.ts` owns constructing the core modules and the real runner.
 * This file owns the things only a window can do — the tray hotkey, hiding,
 * notifications, the clipboard, drag-drop — and hands the pair to `App`, which
 * knows about neither.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

import { createServices } from '../app/services.ts';
import { tauriRunner } from '../app/runner.ts';
import { DEFAULT_SETTINGS, type ImageAttachment } from '../core/types.ts';
import { App } from './App.tsx';
import { createNotifier } from './components/notify.ts';
import { createUiServices, type Platform } from './components/services.ts';
import './styles.css';

const mediaTypeOf = (path: string): ImageAttachment['mediaType'] =>
  /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';

/**
 * What counts as an image, in exactly one place.
 *
 * This list is half of a cross-language contract: `src-tauri/src/dnd.rs` mirrors
 * it to decide which dropped paths earn a runtime fs grant, and pins the pair with
 * a test that reads this very line. A file the drop grants but this never reads is
 * a scope widened for nothing; a file this reads but the drop never grants throws
 * on `readFile` in the shipped app, where no test can see it.
 *
 * So `isImage` derives from the list rather than restating it as a regex. It used
 * to be both — the list fed the file dialog, an independent `/\.(png|jpe?g)$/i`
 * gated the reads — which left dnd.rs's test guarding the constant that was NOT
 * the gate. Widening the regex alone kept all 27 Rust tests green while the
 * frontend read a format Rust had never granted. One list, one gate, one test.
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'];

const isImage = (path: string): boolean =>
  IMAGE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`));

async function readImages(paths: string[]): Promise<Array<Omit<ImageAttachment, 'id' | 'annotated'>>> {
  const images: Array<Omit<ImageAttachment, 'id' | 'annotated'>> = [];
  for (const path of paths) {
    if (!isImage(path)) continue;
    images.push({ bytes: await readFile(path), mediaType: mediaTypeOf(path) });
  }
  return images;
}

function createPlatform(): Platform {
  const window = getCurrentWindow();

  /** What the OS currently holds for us, so a rebind can release it first. */
  let bound: string | null = null;

  /** The update the last check found; `installUpdate` installs exactly this one. */
  let pendingUpdate: Update | null = null;

  /** Show + focus, i.e. what the hotkey does. A summon is a summon. */
  const summon = async (): Promise<void> => {
    await window.show();
    await window.setFocus();
  };

  const notifier = createNotifier({
    isPermissionGranted,
    requestPermission,
    send: sendNotification,
    onAction: (handler) => onAction(() => handler()),
    summon,
  });

  return {
    hotkeyConflict: () => invoke<{ hotkey: string; reason: string } | null>('hotkey_conflict'),

    /**
     * Rebinding releases the old shortcut first: registering a second one leaves
     * both live, and the stale one keeps firing forever.
     */
    async applyHotkey(hotkey) {
      try {
        if (bound !== null) await unregister(bound);
        await register(hotkey, (event) => {
          if (event.state === 'Pressed') void summon();
        });
        bound = hotkey;
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'That shortcut could not be registered.';
      }
    },

    notify: (message) => notifier.notify(message),

    hide: () => window.hide(),

    async setWidth(width) {
      const scale = await window.scaleFactor();
      const size = (await window.innerSize()).toLogical(scale);
      await window.setSize(new LogicalSize(width, size.height));
    },

    openUrl: (url) => openUrl(url),
    copy: (text) => navigator.clipboard.writeText(text),

    readImages,

    async pickImages() {
      const picked = await open({
        multiple: true,
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
      });
      if (picked === null) return [];
      return readImages(Array.isArray(picked) ? picked : [picked]);
    },

    onSummon(handler) {
      // Rust owns showing the window; the webview only needs to know it happened,
      // so a hidden-then-summoned palette re-renders as visible.
      const unlisten = window.onFocusChanged(({ payload }) => {
        if (payload) handler();
      });
      return () => void unlisten.then((off) => off());
    },

    onDropFiles(handler) {
      // Native drag-drop hands over PATHS — the webview never sees the file.
      const unlisten = window.onDragDropEvent((event) => {
        if (event.payload.type === 'drop') handler(event.payload.paths);
      });
      return () => void unlisten.then((off) => off());
    },

    async checkForUpdate() {
      try {
        pendingUpdate = await check();
        return pendingUpdate === null ? null : { version: pendingUpdate.version };
      } catch {
        // Offline, rate-limited, or the release feed 404s (it does while the
        // repo is private). The Platform contract makes all of it "no update".
        pendingUpdate = null;
        return null;
      }
    },

    async installUpdate() {
      if (pendingUpdate === null) return;
      // NSIS runs in passive mode (tauri.conf.json) and replaces the app on
      // disk; the relaunch is what brings the new version back to the tray.
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    },
  };
}

async function main(): Promise<void> {
  const platform = createPlatform();
  const core = await createServices();
  const services = createUiServices({ core, platform, runner: tauriRunner });

  // Rust registered the default hotkey at startup so the app is summonable before
  // the webview boots. Take over only when the user's stored one differs.
  const stored = core.settings.get().hotkey;
  if (stored !== DEFAULT_SETTINGS.hotkey) void platform.applyHotkey(stored);

  const root = document.getElementById('root');
  if (root === null) throw new Error('#root is missing from index.html');

  createRoot(root).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}

void main();
