/**
 * The composition root: the one place that resolves real directories and hands
 * every core module the real `ProcessRunner` and the real `FileStore`. Core
 * modules stay injectable — and therefore testable — precisely because nothing
 * below this file ever reaches for a path, a process, or a disk on its own.
 *
 * Both seams are supplied here and only here: `./runner.ts` (Quacket's own Rust
 * spawn command) and `./files.ts` (tauri-plugin-fs). They are the only two
 * files in the repo that are allowed to know Tauri exists.
 */

import { appDataDir, tempDir } from '@tauri-apps/api/path';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { load, type Store } from '@tauri-apps/plugin-store';

import { discover } from '../core/discovery/discovery.ts';
import { DraftStore } from '../core/drafts/store.ts';
import { joinPath } from '../core/files.ts';
import { createFiling, type Filing } from '../core/filing/filing.ts';
import { createGitHub, type GitHub } from '../core/github/github.ts';
import { createAdapter, type LlmAdapter } from '../core/llm/index.ts';
import {
  DEFAULT_SETTINGS,
  type ProviderCapabilities,
  type ProviderId,
  type Settings,
} from '../core/types.ts';
import { tauriFiles } from './files.ts';
import { tauriRunner } from './runner.ts';

/** Lives in the app data dir; the discovery cache deliberately does not share it. */
const SETTINGS_FILE = 'settings.json';

/**
 * Codex's per-draft scratch dirs go in a folder of Quacket's own rather than
 * loose in `$TEMP`, so `capabilities/default.json` can grant the fs plugin
 * `$TEMP/quacket/**` instead of all of `$TEMP` — which belongs to every other
 * app on the machine. The name is load-bearing: it has to match the capability.
 */
const SCRATCH_DIR = 'quacket';

export interface SettingsService {
  /** Synchronous because the UI reads settings on every render. */
  get(): Settings;
  set(patch: Partial<Settings>): Promise<Settings>;
}

/**
 * Autostart is NOT a setting: the HKCU Run key is the single source of truth and
 * is read live, so a user who removes the entry outside Quacket sees the truth
 * rather than our stale copy of it.
 */
export interface AutostartService {
  isEnabled(): Promise<boolean>;
  set(on: boolean): Promise<void>;
}

export interface Services {
  settings: SettingsService;
  drafts: DraftStore;
  /** Reads only. Every GitHub WRITE goes through `filing`. */
  github: GitHub;
  filing: Filing;
  autostart: AutostartService;
  /** Built per call: provider/model/effort change under the user at any time. */
  adapter(settings: Settings): LlmAdapter;
  discover(provider: ProviderId, force?: boolean): Promise<ProviderCapabilities>;
  /** The app-start `gh auth status` probe, already resolved. */
  ghAuth: { ok: boolean; message?: string };
}

const readSetting = async <K extends keyof Settings>(
  store: Store,
  key: K,
): Promise<Settings[K]> => {
  const stored = await store.get<Settings[K]>(key);
  // `??` would be wrong: null is a legitimate stored value for model / effort /
  // lastRepo, and coercing it back to the default would resurrect a cleared one.
  return stored === undefined ? DEFAULT_SETTINGS[key] : stored;
};

const loadSettings = async (store: Store): Promise<Settings> => ({
  provider: await readSetting(store, 'provider'),
  model: await readSetting(store, 'model'),
  effort: await readSetting(store, 'effort'),
  hotkey: await readSetting(store, 'hotkey'),
  lastRepo: await readSetting(store, 'lastRepo'),
});

const createSettingsService = async (): Promise<SettingsService> => {
  // `defaults` is required by StoreOptions but deliberately empty: `readSetting`
  // above distinguishes "never stored" (undefined) from "stored as null", and
  // seeding defaults into the store would erase that distinction.
  const store = await load(SETTINGS_FILE, { autoSave: false, defaults: {} });
  let current = await loadSettings(store);

  return {
    get: () => current,
    set: async (patch) => {
      current = { ...current, ...patch };
      for (const [key, value] of Object.entries(patch)) {
        await store.set(key, value);
      }
      // autoSave is off: settings changes are deliberate user acts, not
      // keystrokes, so one explicit write beats a debounce racing app exit.
      await store.save();
      return current;
    },
  };
};

export const createServices = async (): Promise<Services> => {
  const [dataDir, temp] = await Promise.all([appDataDir(), tempDir()]);
  const scratchDir = joinPath(temp, SCRATCH_DIR);

  const github = createGitHub(tauriRunner);
  const [settings, ghAuth] = await Promise.all([
    createSettingsService(),
    // Probed once at start so onboarding can show the gh card without every
    // caller re-shelling out to `gh auth status`.
    github.checkAuth(),
  ]);

  const drafts = new DraftStore(dataDir, tauriFiles);

  return {
    settings,
    github,
    ghAuth,
    drafts,
    // Same app data volume as the drafts folder, which is what makes the
    // draft-to-Filing handoff a rename rather than a copy.
    filing: createFiling({ runner: tauriRunner, files: tauriFiles, drafts, baseDir: dataDir }),
    autostart: {
      isEnabled,
      set: async (on) => (on ? enable() : disable()),
    },
    adapter: (s) =>
      createAdapter(s.provider, {
        runner: tauriRunner,
        files: tauriFiles,
        tempDirBase: scratchDir,
      }),
    discover: (provider, force = false) =>
      discover(provider, { runner: tauriRunner, files: tauriFiles, baseDir: dataDir, force }),
  };
};
