/**
 * The palette's whole outside world, as one injected port.
 *
 * `App` takes a `UiServices` and imports no Tauri API, no process code and no
 * core module that touches a disk. That keeps the component tree a dumb renderer
 * over the reducer and puts every real dependency in one place.
 *
 * This sits ON TOP of `src/app/services.ts`, which owns constructing the core
 * modules and the real runner. The split is: that layer answers "what are the
 * core modules, wired to the real machine"; this one answers "what does the
 * palette actually need". The compositions here — refine (prompt + adapter +
 * parse) and submit (store + github) — exist because no core module owns a
 * pipeline that spans two of them, and this is the first place both are in scope.
 */

import type { Services as AppServices } from '../../app/services.ts';
import { parseRefined } from '../../core/refine/parse.ts';
import { buildSystemPrompt, buildUserPrompt, prefilterCandidates } from '../../core/refine/prompt.ts';
import { REFINE_SCHEMA } from '../../core/refine/schema.ts';
import type { Thread } from '../../core/llm/index.ts';
import type { ProcessRunner } from '../../core/runner.ts';
import {
  ProviderError,
  type Draft,
  type ImageAttachment,
  type OpenIssue,
  type ProviderCapabilities,
  type ProviderId,
  type RefinedDraft,
  type Repo,
  type Settings,
  type SubmitResult,
} from '../../core/types.ts';
import type { DetectedState, GhState } from '../../core/ui/onboarding.ts';
import { dropInventedIssues } from './session.ts';

export interface RefineRequest {
  raw: string;
  images: ImageAttachment[];
  repo: string;
  settings: Settings;
}

export interface RefineOutcome {
  draft: RefinedDraft;
  /** The resume handle for the follow-up turn. Not expressible in `UiState`. */
  thread: Thread;
  /** What the model was shown, so a later turn can be cleaned against it too. */
  candidates: OpenIssue[];
}

/** The window and OS affordances the app layer does not cover. Built in main.tsx. */
export interface Platform {
  hotkeyConflict(): Promise<{ hotkey: string; reason: string } | null>;
  applyHotkey(hotkey: string): Promise<string | null>;
  notify(message: string): Promise<void>;
  hide(): Promise<void>;
  setWidth(width: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  readImages(paths: string[]): Promise<Array<Omit<ImageAttachment, 'id' | 'annotated'>>>;
  /** Opens the OS file picker. Returns [] when the user cancels. */
  pickImages(): Promise<Array<Omit<ImageAttachment, 'id' | 'annotated'>>>;
  onSummon(handler: () => void): () => void;
  onDropFiles(handler: (paths: string[]) => void): () => void;
  /**
   * Null means "nothing to do" — up to date, endpoint unreachable, check failed.
   * A tray app that lives for weeks must never nag about a network blip, so the
   * failure modes collapse into silence by contract, like `detect`.
   */
  checkForUpdate(): Promise<{ version: string } | null>;
  /** Downloads and installs what the last check found, then restarts the app. */
  installUpdate(): Promise<void>;
}

export interface UiServices {
  detect(force?: boolean): Promise<DetectedState>;
  hotkeyConflict(): Promise<{ hotkey: string; reason: string } | null>;

  listRepos(): Promise<Repo[]>;
  listIssues(repo: string): Promise<OpenIssue[]>;

  refine(request: RefineRequest): Promise<RefineOutcome>;
  followUp(thread: Thread, answers: string[], candidates: OpenIssue[]): Promise<RefinedDraft>;
  /** MUTATES `draft.images`, setting `uploadedUrl` on whatever landed. */
  submit(draft: Draft, repo: Repo): Promise<SubmitResult>;

  loadDraft(): Promise<Draft | null>;
  saveDraft(draft: Draft): Promise<void>;
  attachImage(draft: Draft, image: ImageAttachment): Promise<void>;
  discardDraft(): Promise<void>;

  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  setAutostart(on: boolean): Promise<void>;
  applyHotkey(hotkey: string): Promise<string | null>;

  notify(message: string): Promise<void>;
  hide(): Promise<void>;
  setWidth(width: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  readImages(paths: string[]): Promise<Array<Omit<ImageAttachment, 'id' | 'annotated'>>>;
  /** Opens the OS file picker. Returns [] when the user cancels. */
  pickImages(): Promise<Array<Omit<ImageAttachment, 'id' | 'annotated'>>>;
  onSummon(handler: () => void): () => void;
  onDropFiles(handler: (paths: string[]) => void): () => void;
  checkForUpdate(): Promise<{ version: string } | null>;
  installUpdate(): Promise<void>;
}

export interface UiServiceDeps {
  core: AppServices;
  platform: Platform;
  /** Only for the `gh --version` probe — see `ghState`. */
  runner: ProcessRunner;
}

const PROVIDERS: ProviderId[] = ['claude', 'codex'];

export function createUiServices({ core, platform, runner }: UiServiceDeps): UiServices {
  /**
   * A provider ABSENT from this list is not installed; one with `account: null`
   * is installed but logged out. Those two produce different onboarding cards
   * with different fix commands, so they must not collapse into one.
   */
  const capabilitiesOf = async (
    provider: ProviderId,
    force: boolean,
  ): Promise<ProviderCapabilities[]> => {
    try {
      return [await core.discover(provider, force)];
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_authenticated') {
        return [{ provider, cliVersion: '', account: null, models: [] }];
      }
      return [];
    }
  };

  /**
   * `gh auth status` alone cannot separate "not installed" from "not signed in" —
   * both are just a non-zero exit — and they need different cards, so the version
   * probe runs first.
   */
  const ghState = async (): Promise<GhState> => {
    try {
      const version = await runner.run({ cmd: 'gh', args: ['--version'], timeoutMs: 10_000 });
      if (version.exitCode !== 0) return { installed: false, authenticated: false };
    } catch {
      return { installed: false, authenticated: false };
    }
    try {
      return { installed: true, authenticated: (await core.github.checkAuth()).ok };
    } catch {
      return { installed: true, authenticated: false };
    }
  };

  /** The duplicate check is an enhancement: a repo we cannot list still refines. */
  const candidatesFor = async (repo: string, raw: string): Promise<OpenIssue[]> => {
    try {
      return prefilterCandidates(await core.github.listOpenIssues(repo), raw);
    } catch {
      return [];
    }
  };

  /**
   * The HKCU Run key is the single source of truth and is read live, so a failed
   * read means we do not know — and `false` is the honest answer to "is it on?"
   * when we cannot see. The toggle still works from there: enabling an already
   * enabled autostart is a no-op.
   */
  const autostartState = async (): Promise<boolean> => {
    try {
      return await core.autostart.isEnabled();
    } catch {
      return false;
    }
  };

  return {
    /**
     * NEVER REJECTS, and every input above degrades to a known state to keep it
     * that way — `ghState` to not-installed, `capabilitiesOf` to absent,
     * `autostartState` to off.
     *
     * That is a contract, not a courtesy: detection is the ONE thing standing
     * between the user and the capture box (see the boot effects in `App.tsx`),
     * so a `detect()` that rejects is a palette stuck on "Checking your setup…"
     * forever — no capture box, no error card, not even Discard. `autostart` was
     * the one input that did not know the rule and could brick boot on its own.
     *
     * `services.test.ts` pins this by rejecting each input in turn. Any input
     * added here must degrade too; the test is what makes that non-optional.
     */
    async detect(force = false): Promise<DetectedState> {
      const [gh, providerLists, autostart] = await Promise.all([
        ghState(),
        Promise.all(PROVIDERS.map((p) => capabilitiesOf(p, force))),
        autostartState(),
      ]);
      return { gh, providers: providerLists.flat(), settings: core.settings.get(), autostart };
    },

    hotkeyConflict: platform.hotkeyConflict,
    listRepos: () => core.github.listRepos(),
    listIssues: (repo) => core.github.listOpenIssues(repo),

    /**
     * Where the prompt, the adapter and the parser meet.
     *
     * `buildUserPrompt` — not the raw text — is what goes over the wire: it is
     * what tells the model which image id maps to which image, and the adapter
     * preserves the attachment order it assumes.
     */
    async refine({ raw, images, repo, settings }): Promise<RefineOutcome> {
      const candidates = await candidatesFor(repo, raw);
      const result = await core.adapter(settings).refine({
        text: buildUserPrompt(raw, images, candidates),
        images,
        schema: REFINE_SCHEMA,
        systemPrompt: buildSystemPrompt(),
        model: settings.model,
        effort: settings.effort,
      });
      return {
        draft: dropInventedIssues(parseRefined(result.draft), candidates),
        thread: result.thread,
        candidates,
      };
    },

    async followUp(thread, answers, candidates): Promise<RefinedDraft> {
      const settings = { ...core.settings.get(), provider: thread.provider };
      const result = await core.adapter(settings).followUp(thread, answers);
      return dropInventedIssues(parseRefined(result.draft), candidates);
    },

    /**
     * `beginSubmit`/`finishSubmit` bracket the call so a kill mid-flight restores
     * as a failed submit rather than a lost draft. The slot frees only on a
     * confirmed success — that rule lives in the store, not in this caller.
     */
    async submit(draft, repo): Promise<SubmitResult> {
      await core.drafts.beginSubmit(draft);
      try {
        const result = await core.github.submit(repo, draft, draft.target);
        await core.drafts.finishSubmit(draft, { ok: true });
        return result;
      } catch (error) {
        await core.drafts.finishSubmit(draft, {
          ok: false,
          error: {
            kind: draftErrorKind(error),
            message: error instanceof Error ? error.message : 'Submit failed.',
          },
        });
        throw error;
      }
    },

    loadDraft: () => core.drafts.load(),
    saveDraft: (draft) => core.drafts.save(draft),
    attachImage: async (draft, image) => {
      await core.drafts.attachImage(draft, image);
    },
    discardDraft: () => core.drafts.discard(),

    loadSettings: async () => core.settings.get(),
    saveSettings: async (settings) => {
      await core.settings.set(settings);
    },
    setAutostart: (on) => core.autostart.set(on),

    applyHotkey: platform.applyHotkey,
    notify: platform.notify,
    hide: platform.hide,
    setWidth: platform.setWidth,
    openUrl: platform.openUrl,
    copy: platform.copy,
    readImages: platform.readImages,
    pickImages: platform.pickImages,
    onSummon: platform.onSummon,
    onDropFiles: platform.onDropFiles,
    checkForUpdate: platform.checkForUpdate,
    installUpdate: platform.installUpdate,
  };
}

type DraftErrorKind = NonNullable<Draft['lastError']>['kind'];

const KINDS = new Set<string>([
  'not_authenticated',
  'model_unavailable',
  'rate_limited',
  'timeout',
  'provider_error',
  'upload_failed',
  'create_failed',
]);

/** A crash mid-submit cannot know which leg died; create_failed retries correctly for both. */
const draftErrorKind = (error: unknown): DraftErrorKind => {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && KINDS.has(kind) ? (kind as DraftErrorKind) : 'create_failed';
};
