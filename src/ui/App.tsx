/**
 * The palette.
 *
 * This component OWNS NO STAGE LOGIC. `src/core/ui/reducer.ts` decides what the
 * machine does; App renders the result, dispatches actions, and performs the
 * effects it is handed back as data. Anything here that looks like a decision is
 * either a view concern (which panel is on screen) or a composition concern
 * (which service call an effect maps to).
 *
 * Everything external arrives through the injected `Services` port, so this file
 * imports no Tauri API and no process or filesystem code.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  DEFAULT_SETTINGS,
  type Draft,
  type ImageAttachment,
  type OpenIssue,
  type RefinedDraft,
  type Repo,
  type Settings,
} from './../core/types.ts';
import {
  deriveOnboardingCards,
  deriveSetupWarnings,
  readyProviders,
  type DetectedState,
  type MachineState,
} from './../core/ui/onboarding.ts';
import {
  canDiscard,
  canStartNewReport,
  flattenedImage,
  isCommenting,
  similarCandidates,
  type Action,
  type Effect,
  type Recovery,
} from './../core/ui/reducer.ts';
import type { Thread } from './../core/llm/index.ts';
import { settingsNoticeText, toFailure } from './components/format.ts';
import { drain, hostReduce, initialHost } from './components/host.ts';
import { reconcileSettings, type SettingsNotice } from './components/settings.ts';
import { Icon, Spinner } from './components/icons.tsx';
import { IssueList } from './components/IssueList.tsx';
import { chordOf, keyToCommand, type View } from './components/keymap.ts';
import { Body, Footer, Header, Panel, Pickers, WarningSlot, type Warning } from './components/Palette.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { RepoSwitcher } from './components/RepoSwitcher.tsx';
import type { UiServices } from './components/services.ts';
import { SettingsView } from './components/SettingsView.tsx';
import {
  NO_REPO,
  pushRecent,
  restoreActions,
  sentEntry,
  shouldFoldAnswers,
  shouldSaveDraft,
  toDraft,
  uploadedFrom,
  type SentEntry,
} from './components/session.ts';
import { AnnotateEditor } from './annotate/AnnotateEditor.tsx';
import { Capture, Done, DraftView, ErrorCard, Refining } from './components/Stages.tsx';

const newDraftId = (): string => `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const mediaTypeOf = (mime: string): ImageAttachment['mediaType'] =>
  mime === 'image/jpeg' || mime === 'image/jpg' ? 'image/jpeg' : 'image/png';

/** Restored ids must not collide with new ones: continue the sequence, don't restart it. */
const seqFrom = (images: ImageAttachment[]): number =>
  images.reduce((max, image) => Math.max(max, Number(/\d+$/.exec(image.id)?.[0] ?? 0)), 0);

/**
 * Dropped paths, named the way the user knows them. The full path is the OS's
 * business — they dragged `shot.png`, so that is what a message about it says.
 */
const imageNames = (paths: string[]): string =>
  paths.map((path) => path.split(/[\\/]/).pop() ?? path).join(', ');

/** An image as the outside world hands it over: bytes and a type, no identity yet. */
type NewImage = Omit<ImageAttachment, 'id' | 'annotated'>;

/**
 * An image intake ROUTE, as a value: what the outside world was asked for, and
 * how to ask it again.
 *
 * Paste, drag-drop and the picker differ in exactly two ways — where the bytes
 * come from, and whether the user has a name for what they handed over.
 * Everything after the read is identical, which is what lets `addFrom` be the one
 * boundary all three cross instead of three hand-rolled ones that each guard a
 * different half.
 */
interface ImageSource {
  /**
   * The files as the USER names them, on a route where they named some. A drop of
   * three is one gesture, so "an image failed" would leave them guessing which.
   * Empty for paste and the picker: there is no name they would recognise — a
   * clipboard image has none, and a picker that failed never handed one back.
   */
  names: string[];
  /**
   * Re-runnable, because it IS the retry: a read either hands back every image or
   * throws, so nothing has been added yet and running it again cannot double up.
   */
  read: () => Promise<NewImage[]>;
}

export interface AppProps {
  services: UiServices;
}

export function App({ services }: AppProps) {
  /*
   * `hostReduce`, not `reduce`: effects are a QUEUE that gets drained, never a
   * value the next dispatch in the same React batch can render over. See
   * `components/host.ts` — the notification story 27 exists for was being lost
   * exactly there.
   */
  const [{ state, pending }, dispatch] = useReducer(hostReduce, undefined, initialHost);

  // ── View-level state: what is on screen, not what the machine is doing ────
  const [view, setView] = useState<View>('capture');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recording, setRecording] = useState(false);

  // ── Machine + account state ──────────────────────────────────────────────
  /**
   * MACHINE FACTS ONLY. The settings and the autostart flag that arrive with a
   * detection are deliberately dropped on the floor here and kept below instead
   * — `detected` recomposes them. Keeping the whole `DetectedState` is what gave
   * the app two answers to "is setup done, and with what?": onboarding derived
   * from this snapshot while every control wrote `settings`, so the cards could
   * not see the click that was supposed to dismiss them.
   */
  const [machine, setMachine] = useState<MachineState | null>(null);
  /** The one source of truth for the five settings. Nothing else stores them. */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /** Ditto for autostart, whose real home is the Run key (re-read on detect). */
  const [autostart, setAutostart] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState<{ hotkey: string; reason: string } | null>(null);
  /** A `gh` we could not LIST with, as opposed to one detection says is broken. */
  const [reposError, setReposError] = useState<string | null>(null);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  /** Story 38's one-time news: a stored provider/model/effort the CLIs dropped. */
  const [settingsNotice, setSettingsNotice] = useState<SettingsNotice | null>(null);
  /** An image we could not READ. Keeps the route, so Try again means it. */
  const [readError, setReadError] = useState<{ source: ImageSource; message: string } | null>(null);
  /** Images whose BYTES we could not save. Keeps them, so Try again means it. */
  const [attachError, setAttachError] = useState<{ images: NewImage[]; message: string } | null>(null);
  /** A flattened annotation we could not save. Keeps the bytes, so Try again means it. */
  const [annotateError, setAnnotateError] = useState<{ bytes: Uint8Array; message: string } | null>(
    null,
  );
  /** A saved draft the store refused to reopen. News: nothing can be done with it. */
  const [draftLost, setDraftLost] = useState(false);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [issues, setIssues] = useState<OpenIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  const [recent, setRecent] = useState<SentEntry[]>([]);
  const [lastSent, setLastSent] = useState<SentEntry | null>(null);
  const [submitPhase, setSubmitPhase] = useState('Sending…');
  const [now, setNow] = useState(() => Date.now());

  // Refs: read by async effect handlers, which must never close over stale state.
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const repoRef = useRef(repo);
  repoRef.current = repo;

  const draftId = useRef(newDraftId());
  const imageSeq = useRef(0);
  /** The resume handle for turn 2. `UiState` cannot carry it, so it lives here. */
  const thread = useRef<Thread | null>(null);
  /** What the model was shown, so a follow-up can be cleaned against it too. */
  const candidates = useRef<OpenIssue[]>([]);
  /** The draft exactly as the AI produced it — the baseline a hand-edit is measured against. */
  const pristine = useRef<RefinedDraft | null>(null);

  // ── Dispatch ─────────────────────────────────────────────────────────────

  /**
   * The one wrapper around dispatch: starting a fresh draft needs the per-draft
   * refs reset, and there is no reducer action that could do it — they are not
   * `UiState`.
   *
   * Both ways a draft ends have to reset them, and for the same reason: a stale
   * `thread` would resume the DISCARDED draft's conversation into the next
   * report, and a stale `imageSeq` would hand the next report's first screenshot
   * an id the old one already used.
   */
  const resetDraftRefs = useCallback(() => {
    draftId.current = newDraftId();
    imageSeq.current = 0;
    thread.current = null;
    candidates.current = [];
    pristine.current = null;
    setLastSent(null);
  }, []);

  const act = useCallback(
    (action: Action) => {
      if (action.type === 'new-report' && canStartNewReport(stateRef.current)) resetDraftRefs();
      if (action.type === 'discard' && canDiscard(stateRef.current)) resetDraftRefs();
      dispatch(action);
    },
    [resetDraftRefs],
  );

  // ── Effects the reducer hands back ───────────────────────────────────────

  const runRefine = useCallback(async () => {
    const target = repoRef.current;
    if (target === null) {
      act({ type: 'refine-failed', error: { kind: 'provider_error', message: 'Choose a repo first.' } });
      return;
    }
    const { raw, images } = stateRef.current;
    try {
      const outcome = await services.refine({
        raw,
        images,
        repo: target.nameWithOwner,
        settings: settingsRef.current,
      });
      thread.current = outcome.thread;
      candidates.current = outcome.candidates;
      pristine.current = outcome.draft;
      act({ type: 'refine-ok', draft: outcome.draft });
    } catch (error) {
      act({ type: 'refine-failed', error: toFailure(error) });
    }
  }, [act, services]);

  const runSubmit = useCallback(async () => {
    const current = stateRef.current;
    const target = repoRef.current;
    if (target === null || current.refined === null) {
      act({ type: 'submit-failed', error: { kind: 'create_failed', message: 'Nothing to submit.' } });
      return;
    }

    // Fold the follow-up answers in. Nothing else consumes them, so skipping this
    // would ask the user a question and quietly throw the reply away.
    let refined = current.refined;
    if (shouldFoldAnswers(current, pristine.current) && thread.current !== null) {
      setSubmitPhase('Adding your answers…');
      try {
        refined = await services.followUp(thread.current, current.answers, candidates.current);
      } catch {
        // The LLM is an enhancement, never a gatekeeper: a failed second turn
        // files the draft we already have rather than blocking the submit.
        refined = current.refined;
      }
    }
    setSubmitPhase('Sending…');

    const draft: Draft = toDraft({ ...current, refined }, draftId.current, target.nameWithOwner);
    try {
      const result = await services.submit(draft, target);
      const entry = sentEntry(result, { ...current, refined }, target.nameWithOwner);
      if (entry !== null) {
        setLastSent(entry);
        setRecent((list) => pushRecent(list, entry));
      }
      act({ type: 'submit-ok', result });
    } catch (error) {
      act({ type: 'submit-failed', error: toFailure(error) });
    } finally {
      // Whatever DID upload is recorded either way, so a retry reuses the blobs.
      act({ type: 'images-uploaded', uploaded: uploadedFrom(draft.images) });
    }
  }, [act, services]);

  const perform = useCallback(
    async (effect: Effect) => {
      switch (effect.type) {
        case 'hide':
          await services.hide();
          break;
        case 'notify':
          await services.notify(effect.message);
          break;
        case 'refine':
          await runRefine();
          break;
        case 'submit':
          await runSubmit();
          break;
        case 'discard-draft':
          await services.discardDraft();
          break;
      }
    },
    [runRefine, runSubmit, services],
  );

  /*
   * Drain BEFORE performing, not after: `runRefine`/`runSubmit` can dispatch
   * synchronously (both bail out with a failure when there is no repo), and a
   * drain issued afterwards would slice those fresh effects off the front
   * instead of the ones just performed.
   */
  useEffect(() => {
    if (pending.length === 0) return;
    const batch = pending;
    dispatch(drain(batch.length));
    for (const effect of batch) void perform(effect);
  }, [pending, perform]);

  // ── Boot ─────────────────────────────────────────────────────────────────

  const loadRepos = useCallback(
    async (lastRepo: string | null) => {
      try {
        const list = await services.listRepos();
        setRepos(list);
        setRepo((current) => current ?? list.find((r) => r.nameWithOwner === lastRepo) ?? list[0] ?? null);
        setReposError(null);
      } catch (error) {
        setReposError(toFailure(error).message);
      }
    },
    [services],
  );

  /**
   * The one place detection lands, so it is the one place the stored choice gets
   * checked against what the CLIs actually offer (#9, story 38).
   *
   * The reconciled settings become the live settings, and the notice is one-time
   * for free: the write-back means the next boot finds nothing to reconcile
   * because this one already fixed it.
   *
   * Note what is NOT kept: `next.settings` and `next.autostart` land in the live
   * state and nowhere else. That is the split closing — a detection is where
   * those values are READ FROM DISK, not a second place they live.
   */
  const applyDetected = useCallback(
    (next: DetectedState) => {
      const { settings: reconciled, notice } = reconcileSettings(next.settings, next.providers);
      setMachine({ gh: next.gh, providers: next.providers });
      setSettings(reconciled);
      setAutostart(next.autostart);
      if (notice !== null) {
        setSettingsNotice(notice);
        void services.saveSettings(reconciled);
      }
      return reconciled;
    },
    [services],
  );

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const next = await services.detect(true);
      const reconciled = applyDetected(next);
      if (next.gh.authenticated) void loadRepos(reconciled.lastRepo);
    } finally {
      setChecking(false);
    }
  }, [applyDetected, loadRepos, services]);

  /*
   * Boot is THREE INDEPENDENT JOBS, and they are three effects for that reason.
   *
   * They used to be one `await Promise.all([detect, hotkeyConflict, loadDraft])`
   * with nothing catching it, which made all three exactly as fragile as the
   * most fragile of them. `DraftStore.load()` is DOCUMENTED to throw — a manifest
   * entry whose bytes are gone is corruption, and refusing beats restoring a
   * report the user believes still has a screenshot. That rejection aborted the
   * continuation before `applyDetected` ever ran, so `machine` stayed null and
   * the palette sat on "Checking your setup…" FOREVER: no capture box, no error
   * card, not even Discard.
   *
   * That is #8's whole posture inverted. A draft is supposed to be the thing
   * that survives everything; instead it took the app hostage — and the draft you
   * cannot open is precisely the one you most need a working window to get past.
   * So: only detection may stand between the user and the capture box. Everything
   * else fills its own slot when it lands, and fills nothing when it does not.
   */
  useEffect(() => {
    void (async () => {
      const reconciled = applyDetected(await services.detect(true));
      void loadRepos(reconciled.lastRepo);
    })();
  }, [applyDetected, loadRepos, services]);

  useEffect(() => {
    void (async () => setConflict(await services.hotkeyConflict()))();
  }, [services]);

  useEffect(() => {
    void (async () => {
      let saved: Draft | null;
      try {
        saved = await services.loadDraft();
      } catch {
        // Not swallowed — routed. The store's message names a file id, which is
        // no use to anyone; what the user needs to know is that the report they
        // were expecting is not coming back. `warnings` says exactly that.
        setDraftLost(true);
        return;
      }
      // Silent restore: the draft comes back the way it left, with no ceremony.
      if (saved === null) return;
      draftId.current = saved.id;
      imageSeq.current = seqFrom(saved.images);
      for (const action of restoreActions(saved)) dispatch(action);
    })();
  }, [services]);

  // The window is long-lived, so a mounted-once clock would drift for days.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => services.onSummon(() => act({ type: 'summon' })), [act, services]);

  useEffect(() => {
    void services.setWidth(state.width);
  }, [services, state.width]);

  // ── Persistence ──────────────────────────────────────────────────────────

  /*
   * `shouldSaveDraft` owns the decision, not this effect. The rule it encodes —
   * hands off while the submit bracket owns draft.json — is invisible from here
   * and was silently violated: this fired on the transition INTO 'submitting' and
   * rewrote `inFlight: false` on top of what `beginSubmit` had just written, so a
   * kill mid-flight restored a normal draft instead of a failed submit with a
   * Retry.
   */
  useEffect(() => {
    if (!shouldSaveDraft(state)) return;
    void services.saveDraft(toDraft(state, draftId.current, repo?.nameWithOwner ?? NO_REPO));
  }, [repo, services, state]);

  const commitSettings = useCallback(
    (next: Settings) => {
      setSettings(next);
      void services.saveSettings(next);
    },
    [services],
  );

  const commitAutostart = useCallback(
    (on: boolean) => {
      setAutostart(on);
      void services.setAutostart(on);
    },
    [services],
  );

  // ── Images ───────────────────────────────────────────────────────────────

  /**
   * One image joins the report: BYTES FIRST, thumbnail second.
   *
   * The order is the entire fix, not a tidy-up. `add-image` used to be dispatched
   * before this write, which made the thumbnail a promise the disk had not made
   * yet — and the two then disagreed in the one direction that destroys work. The
   * auto-save writes draft.json FROM STATE, which already listed the image, while
   * this call is the only thing that ever writes the BYTES. So a failed write left
   * a manifest entry with no file, which `DraftStore.imageBytes` correctly calls
   * corruption and throws on — and that throw is what bricked the next boot.
   *
   * Landing the bytes first means no intake route can put an image into state
   * that is not already on disk. It also closes the same window in the SUCCESS
   * case, where a crash between the dispatch and the write left the identical
   * corruption.
   *
   * INTAKE only. Annotation is the other producer of an image's bytes and obeys
   * the same order for the same reason — see `saveAnnotation` below, which
   * re-attaches through the store before `annotate-done` is dispatched.
   *
   * The write is unconditional on a repo, same rule as the auto-save and for the
   * same reason: story 29 covers what was PASTED as much as what was typed, and a
   * repo is a submit-time address, not the draft's identity.
   */
  const attach = useCallback(
    async (image: NewImage) => {
      // The id is reserved BEFORE the await so two fast pastes cannot both claim
      // `img_1`. A failure burns it, which costs nothing: ids need only be unique.
      imageSeq.current += 1;
      const attachment: ImageAttachment = {
        id: `img_${imageSeq.current}`,
        bytes: image.bytes,
        mediaType: image.mediaType,
        annotated: false,
      };
      const draft = toDraft(stateRef.current, draftId.current, repoRef.current?.nameWithOwner ?? NO_REPO);
      await services.attachImage({ ...draft, images: [...draft.images, attachment] }, attachment);
      act({ type: 'add-image', image: attachment });
    },
    [act, services],
  );

  /**
   * The WRITE half of a route: bytes offered to the disk, one image at a time.
   * Every route reaches it through `addFrom`, so the promise a thumbnail makes is
   * kept in ONE place rather than three.
   *
   * `attach` throwing means nothing was added and nothing was written, so a Try
   * again cannot land the same screenshot twice — the bytes are still in hand,
   * which is exactly what a retry needs. That is why the failed images are kept
   * rather than the route: a multi-file drop can fail halfway, and re-reading the
   * PATHS would land the ones that already succeeded a second time. The read
   * retries the route, the write retries the bytes; each redoes only what it can
   * honestly redo.
   *
   * Never rejects: it is the end of the line for a write failure.
   */
  const addImages = useCallback(
    async (images: NewImage[]) => {
      const failed: NewImage[] = [];
      let message = '';
      for (const image of images) {
        try {
          await attach(image);
        } catch (error) {
          failed.push(image);
          message = toFailure(error).message;
        }
      }
      setAttachError(failed.length === 0 ? null : { images: failed, message });
    },
    [attach],
  );

  /**
   * The ONE boundary every image crosses, and the whole of a route: READ, then
   * WRITE.
   *
   * Both halves fail, and they are different events the user must be told apart:
   * a failed READ means the screenshot never got here; a failed WRITE means it
   * got here and is not in the report. So they keep their own warnings, their own
   * wording, and their own honest retry.
   *
   * Why this exists instead of three routes doing it themselves: `addImages` was
   * a never-rejects boundary for the WRITE half only, and the READ half had a
   * boundary on exactly ONE route — the drop's `try`. So `services.pickImages()`
   * and `file.arrayBuffer()` sat OUTSIDE any boundary and rejected into a `void`,
   * which is not a boundary at all: an unhandled rejection in a console nobody is
   * reading, nothing on screen, and a screenshot silently absent from the ticket.
   * Half a route guarded and half not was the actual defect — one route drawn
   * three times is how the two halves came apart. Starting the boundary at the
   * READ is what closes it for every route at once.
   *
   * Never rejects, which is what makes `void addFrom(...)` honest at every call
   * site rather than a dropped rejection wearing an operator.
   */
  const addFrom = useCallback(
    async (source: ImageSource) => {
      let images: NewImage[];
      try {
        images = await source.read();
      } catch (error) {
        // The route is kept because it is exactly what a retry needs: the next
        // action is "try that same image again", not "go find it again".
        setReadError({ source, message: toFailure(error).message });
        return;
      }
      setReadError(null);
      await addImages(images);
    },
    [addImages],
  );

  /**
   * The flattened annotation lands the same way an intake image does: BYTES
   * FIRST, state second — because it is the same hazard, from a second producer.
   *
   * `annotate-done` rewrites an image's `bytes` AND its `mediaType` (the editor
   * re-encodes to PNG), and nothing used to write either. Two things followed,
   * both silent:
   *
   *   - Annotating a JPEG renamed it. The auto-save writes draft.json from
   *     state, so the manifest said `img_1.png` while the only file on disk was
   *     still `img_1.jpg` — and `DraftStore.imageBytes` correctly calls that
   *     corruption and throws. The report became unopenable, deterministically.
   *   - Annotating a PNG lost the marks. Same name, stale bytes: the draft
   *     restored with the drawing gone and nothing said so.
   *
   * Re-attaching under the SAME id is what the store already documents as the
   * way annotation lands — it overwrites the file and replaces the manifest
   * entry in one serialized step. The call was simply never made.
   *
   * `flattenedImage` is imported, not restated: the reducer owns "annotated =>
   * PNG + annotated:true" and a copy here is the copy that would drift.
   *
   * Never rejects. On failure nothing is dispatched, so the editor stays open
   * with the user's marks still on the canvas and the draft still describing the
   * image that is genuinely on disk.
   */
  const saveAnnotation = useCallback(
    async (bytes: Uint8Array) => {
      const current = stateRef.current;
      const editing = current.editing;
      const image = editing === null ? undefined : current.images[editing.index];
      if (image === undefined) return;

      const draft = toDraft(current, draftId.current, repoRef.current?.nameWithOwner ?? NO_REPO);
      try {
        await services.attachImage(draft, flattenedImage(image, bytes));
      } catch (error) {
        setAnnotateError({ bytes, message: toFailure(error).message });
        return;
      }
      setAnnotateError(null);
      act({ type: 'annotate-done', bytes });
    },
    [act, services],
  );

  /**
   * The visible route to attaching an image; paste and drag-drop are shortcuts.
   *
   * The picker call is the READ, so it belongs inside the boundary. It used to be
   * `await addImages(await services.pickImages())` — the inner await outside
   * everything that catches, escaping into `void pickImages()`. A picker that
   * threw took the screenshot with it and said nothing.
   *
   * Try again re-opens the picker, which is what "try again" means on this route:
   * the user never got as far as naming a file.
   */
  const pickImages = useCallback(
    () => addFrom({ names: [], read: () => services.pickImages() }),
    [addFrom, services],
  );

  // Clipboard images arrive as PNG through the DOM paste event. The clipboard
  // plugin's readImage() hands back raw RGBA instead, which is not a PNG at all.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file === undefined) return;
      event.preventDefault();
      /*
       * The File is captured, not the bytes: `arrayBuffer()` IS this route's read,
       * so it goes inside the boundary rather than in a `.then` with no `.catch`.
       * Holding the File is also what lets Try again re-read the very image the
       * user pasted — the clipboard may well have moved on by then.
       */
      void addFrom({
        names: [],
        read: async () => [
          { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: mediaTypeOf(file.type) },
        ],
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addFrom]);

  /**
   * Drag-drop is native: the webview never sees the file, only its path, so this
   * is the route most likely to be REFUSED — the fs read happens outside the page,
   * against a scope that may not cover where the file lives. It is also the only
   * route where the user named the files, so it is the only one that passes names.
   */
  const addDropped = useCallback(
    (paths: string[]) => addFrom({ names: paths, read: () => services.readImages(paths) }),
    [addFrom, services],
  );

  useEffect(() => services.onDropFiles((paths) => void addDropped(paths)), [addDropped, services]);

  // ── Hotkey ───────────────────────────────────────────────────────────────

  const applyHotkey = useCallback(
    async (hotkey: string) => {
      const reason = await services.applyHotkey(hotkey);
      setHotkeyError(reason);
      if (reason === null) {
        setConflict(null);
        commitSettings({ ...settingsRef.current, hotkey });
      }
    },
    [commitSettings, services],
  );

  // ── Keyboard ─────────────────────────────────────────────────────────────

  const similar = useMemo(() => similarCandidates(state), [state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (recording) {
        event.preventDefault();
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        if (event.key === 'Escape') {
          setRecording(false);
          return;
        }
        const mods = [
          (event.ctrlKey || event.metaKey) && 'CmdOrCtrl',
          event.altKey && 'Alt',
          event.shiftKey && 'Shift',
        ].filter((m): m is string => typeof m === 'string');
        if (mods.length === 0) {
          setHotkeyError('Add Ctrl, Alt or Shift — a bare key would fire while you type.');
          return;
        }
        setRecording(false);
        void applyHotkey([...mods, event.key.length === 1 ? event.key.toUpperCase() : event.key].join('+'));
        return;
      }

      const command = keyToCommand(chordOf(event), {
        view,
        stage: state.stage,
        editing: state.editing !== null,
        overlay: pickerOpen,
        similarCount: similar.length,
        canNew: canStartNewReport(state),
        canDiscard: canDiscard(state),
      });
      if (command === null) return;
      event.preventDefault();

      switch (command.kind) {
        case 'dispatch':
          act(command.action);
          break;
        case 'open-repos':
          setPickerOpen(true);
          break;
        case 'close-view':
          setView('capture');
          break;
        case 'similar': {
          const candidate = similar[command.index];
          if (candidate !== undefined) act({ type: 'choose-similar', issueNumber: candidate.number });
          break;
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [act, applyHotkey, pickerOpen, recording, similar, state, view]);

  // ── Views ────────────────────────────────────────────────────────────────

  const openIssues = useCallback(async () => {
    setView('issues');
    const target = repoRef.current;
    if (target === null) return;
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      setIssues(await services.listIssues(target.nameWithOwner));
    } catch (error) {
      setIssuesError(toFailure(error).message);
    } finally {
      setIssuesLoading(false);
    }
  }, [services]);

  /**
   * An issue number, opened on GitHub. The read-only list and the similar-issue
   * card are both here, so the URL is built once — `repo` is the only thing that
   * knows where an issue number lives, and it lives here.
   */
  const openIssueInBrowser = useCallback(
    (issueNumber: number) =>
      services.openUrl(`https://github.com/${repo?.nameWithOwner}/issues/${issueNumber}`),
    [repo, services],
  );

  const pickRepo = useCallback(
    (next: Repo) => {
      setRepo(next);
      setPickerOpen(false);
      commitSettings({ ...settingsRef.current, lastRepo: next.nameWithOwner });
    },
    [commitSettings],
  );

  const recover = useCallback(
    (recovery: Recovery) => {
      if (recovery === 'retry') act({ type: state.stage === 'input' ? 'refine' : 'submit' });
      else if (recovery === 'file-as-is') act({ type: 'file-as-is' });
      else act({ type: 'file-without-images' });
    },
    [act, state.stage],
  );

  /**
   * The state the cards, the warnings and the pickers all derive from — composed,
   * never stored, so it cannot go stale behind the controls that write to it.
   *
   * This is the fix to the split, and it is one line: the machine half comes from
   * detection, the settings half comes from the state the buttons write. Both
   * derivations stay pure functions of re-detected machine state (#11: no stored
   * wizard progress — quitting mid-setup still loses nothing, because `settings`
   * is re-read from disk on every summon and `autostart` from the Run key).
   */
  const detected = useMemo(
    (): DetectedState | null => (machine === null ? null : { ...machine, settings, autostart }),
    [autostart, machine, settings],
  );

  const cards = useMemo(() => (detected === null ? [] : deriveOnboardingCards(detected)), [detected]);
  const setupIncomplete = cards.length > 0;

  const setupWarnings = useMemo(
    () => (detected === null ? [] : deriveSetupWarnings(detected)),
    [detected],
  );

  const warnings = useMemo((): Warning[] => {
    const list: Warning[] = [];

    /*
     * A prerequisite that broke on an established install rides HERE and only
     * here. It used to be told twice at once — once as a first-run card taking
     * over the whole window, once in this slot — with two competing "Check
     * again" buttons and no clue which was the real one.
     */
    for (const warning of setupWarnings) {
      list.push(
        warning.kind === 'github'
          ? {
              id: 'gh',
              text:
                warning.problem === 'not_installed'
                  ? 'The GitHub command line tool is missing, so issues cannot be filed.'
                  : 'Your GitHub sign-in has expired, so issues cannot be filed.',
              command: warning.command,
              actionLabel: 'Check again',
              onAction: () => void recheck(),
            }
          : {
              id: 'ai-cli',
              text: 'No AI assistant is ready, so reports cannot be refined. You can still file your raw text.',
              ...(warning.fixes[0] === undefined ? {} : { command: warning.fixes[0].command }),
              actionLabel: 'Check again',
              onAction: () => void recheck(),
            },
      );
    }

    // Listing failed for a `gh` detection says is fine — a network blip, not a
    // setup problem, so it says so and offers the retry rather than a fix command.
    if (reposError !== null && !setupWarnings.some((w) => w.kind === 'github')) {
      list.push({
        id: 'repos',
        text: `Your repo list could not be loaded. ${reposError}`,
        actionLabel: 'Try again',
        onAction: () => void loadRepos(settingsRef.current.lastRepo),
      });
    }

    /*
     * The draft is gone and cannot be brought back, so this is news, not a task:
     * it states what happened and offers the only thing left to do with it. No
     * "Try again" — the store threw because bytes are missing from disk, which a
     * second read cannot conjure up, and a button that cannot work is a lie. No
     * Discard either: nothing here is worth deleting, the fresh draft's first
     * save retires the folder anyway, and a destructive button sitting next to a
     * box that may already hold NEW work is a trap, not an affordance.
     */
    if (draftLost) {
      list.push({
        id: 'draft',
        text: 'Your saved report could not be reopened, so this is a fresh start.',
        actionLabel: 'Got it',
        onAction: () => setDraftLost(false),
      });
    }

    /*
     * A thumbnail is a promise that the screenshot is in the report, so when the
     * write fails the promise is not made — and this is the only thing that tells
     * the user their screenshot did not make it. Silence here is what story 4/5/8
     * looks like when it breaks: the image simply is not in the filed issue, and
     * nobody finds out until the ticket is read.
     */
    if (attachError !== null) {
      list.push({
        id: 'attach',
        text:
          `${
            attachError.images.length === 1
              ? 'Your screenshot could not be saved, so it is not in your report.'
              : `${attachError.images.length} screenshots could not be saved, so they are not in your report.`
          } ${attachError.message}`,
        actionLabel: 'Try again',
        onAction: () => void addImages(attachError.images),
      });
    }

    /*
     * Same promise, same slot, same wording as an intake failure — because it is
     * the same event: bytes that did not reach the disk. "yet" is the one
     * difference that matters, and it is true: the editor is still open behind
     * this, the marks are still on the canvas, and the bytes are still in hand,
     * so Try again is a button that can actually work.
     */
    if (annotateError !== null) {
      list.push({
        id: 'annotate',
        text: `Your marked-up screenshot could not be saved, so your changes are not in your report yet. ${annotateError.message}`,
        actionLabel: 'Try again',
        onAction: () => void saveAnnotation(annotateError.bytes),
      });
    }

    /*
     * "could not be ADDED", never "could not be saved": the screenshot never got
     * here at all, so saying it is not in the report would name the wrong event
     * and point the user at the wrong thing to fix.
     *
     * Says which file when the route knows — a drop of several is one gesture, and
     * "an image" would leave the user guessing which one is missing.
     */
    if (readError !== null) {
      list.push({
        id: 'read',
        text: `${
          readError.source.names.length === 0 ? 'Your screenshot' : imageNames(readError.source.names)
        } could not be added. ${readError.message}`,
        actionLabel: 'Try again',
        onAction: () => void addFrom(readError.source),
      });
    }

    if (conflict !== null) {
      list.push({
        id: 'hotkey',
        text: `${conflict.hotkey} is already taken by another app, so it will not open Quacket.`,
        actionLabel: 'Change shortcut',
        onAction: () => setView('settings'),
      });
    }

    // News, not a problem: the fallback has already landed, so the only thing
    // left to do with it is acknowledge it.
    if (settingsNotice !== null) {
      list.push({
        id: 'model',
        text: settingsNoticeText(
          settingsNotice,
          detected?.providers.find((p) => p.provider === settings.provider)?.models ?? [],
        ),
        actionLabel: 'Got it',
        onAction: () => setSettingsNotice(null),
      });
    }

    return list;
  }, [
    addFrom,
    addImages,
    annotateError,
    attachError,
    conflict,
    detected,
    draftLost,
    readError,
    loadRepos,
    recheck,
    reposError,
    saveAnnotation,
    settings.provider,
    settingsNotice,
    setupWarnings,
  ]);

  const editing = state.editing;
  const editingImage = editing === null ? undefined : state.images[editing.index];

  /**
   * The visible route out of a draft. Story 31 puts the whole weight on this one
   * control: Discard is the ONLY way to lose work, so it has to be a thing you
   * can SEE and click — a shortcut alone would mean the only exit is one you have
   * to be told about, and nothing that has to be explained is discoverable.
   *
   * Labelled "Discard", not a bare trash icon: an icon alone makes the user infer
   * how much it deletes. Ghost-styled and kept away from the primary action,
   * because a destructive verb should never be the thing your hand lands on.
   */
  const discardButton = () =>
    !canDiscard(state) ? null : (
      <button className="btn ghost discard" onClick={() => act({ type: 'discard' })}>
        <Icon name="trash" size={13} />
        Discard
        <kbd>Ctrl+Shift+D</kbd>
      </button>
    );

  // ── Render ───────────────────────────────────────────────────────────────

  const body = () => {
    if (view === 'issues') {
      return (
        <IssueList
          issues={issues}
          loading={issuesLoading}
          error={issuesError}
          now={now}
          onOpen={(issue) => void openIssueInBrowser(issue.number)}
        />
      );
    }

    if (view === 'settings') {
      return (
        <SettingsView
          settings={settings}
          providers={detected?.providers ?? []}
          autostart={autostart}
          hotkeyError={hotkeyError}
          onSettings={commitSettings}
          onAutostart={commitAutostart}
          onRecording={setRecording}
          recording={recording}
        />
      );
    }

    /*
     * The annotation editor morphs the BODY; the chrome stays put and the window
     * widens to ANNOTATE_WIDTH, which the reducer already put on `state.width`.
     * It owns its own tools and keyboard, so `editing.tool` stays unread here.
     */
    if (editing !== null && editingImage !== undefined) {
      return (
        <AnnotateEditor
          image={editingImage}
          onDone={(bytes) => void saveAnnotation(bytes)}
          onCancel={() => {
            // Cancel discards the edits, so it discards the news about them too —
            // otherwise a stale warning would offer to Try again with bytes for
            // an image the user just walked away from.
            setAnnotateError(null);
            act({ type: 'annotate-cancel' });
          }}
        />
      );
    }

    if (detected === null) {
      return (
        <div className="status">
          <Spinner />
          <span>Checking your setup…</span>
        </div>
      );
    }

    // The last card collapses into the real textarea — the same window, no hand-off.
    if (setupIncomplete) {
      return (
        <Onboarding
          cards={cards}
          settings={settings}
          checking={checking}
          onRecheck={() => void recheck()}
          onCopy={(text) => void services.copy(text)}
          onSettings={commitSettings}
          onAutostart={commitAutostart}
        />
      );
    }

    if (state.stage === 'done') {
      return (
        <Done
          entry={lastSent}
          recent={recent}
          onOpen={(url) => void services.openUrl(url)}
          onNew={() => act({ type: 'new-report' })}
        />
      );
    }

    if (state.refined !== null && (state.stage === 'draft' || state.stage === 'submitting')) {
      return (
        <DraftView
          raw={state.raw}
          refined={state.refined}
          answers={state.answers}
          candidates={similar}
          selected={state.target.kind === 'comment' ? state.target.issueNumber : null}
          failure={state.failure}
          stage={state.stage}
          onSetType={(reportType) => act({ type: 'set-type', reportType })}
          onEditTitle={(title) => act({ type: 'edit-title', title })}
          onEditSection={(index, body_) => act({ type: 'edit-section', index, body: body_ })}
          onAnswer={(index, text) => act({ type: 'answer', index, text })}
          onChooseSimilar={(issueNumber) => act({ type: 'choose-similar', issueNumber })}
          onOpenIssue={(issueNumber) => void openIssueInBrowser(issueNumber)}
          onRecover={recover}
        />
      );
    }

    return (
      <>
        {/* A refine failure banners over the input, offering the refine leg's matrix. */}
        {state.failure !== null && state.stage === 'input' && (
          <ErrorCard failure={state.failure} stage={state.stage} onRecover={recover} />
        )}
        <Capture
          raw={state.raw}
          images={state.images}
          busy={state.stage === 'refining'}
          onEdit={(raw) => act({ type: 'edit-raw', raw })}
          onOpenImage={(index) => act({ type: 'open-image', index })}
          onRemoveImage={(index) => act({ type: 'remove-image', index })}
          onAddImage={() => void pickImages()}
        />
        {state.stage === 'refining' && <Refining />}
      </>
    );
  };

  const footerContent = () => {
    if (view !== 'capture' || setupIncomplete || detected === null) return null;
    if (editing !== null) return null;

    if (state.stage === 'done') return null;

    if (state.stage === 'draft' || state.stage === 'submitting') {
      const busy = state.stage === 'submitting';
      return (
        <Footer>
          <button className="btn ghost" onClick={() => act({ type: 'back-to-input' })} disabled={busy}>
            <Icon name="back" size={13} />
            Edit my text
          </button>
          {discardButton()}
          <span className="spacer" />
          <button className="btn primary" onClick={() => act({ type: 'submit' })} disabled={busy}>
            {busy ? (
              <>
                <Spinner size={13} />
                {submitPhase}
              </>
            ) : (
              <>
                {isCommenting(state) && state.target.kind === 'comment'
                  ? `Comment on #${state.target.issueNumber}`
                  : 'Submit issue'}
                <kbd>Ctrl+Enter</kbd>
              </>
            )}
          </button>
        </Footer>
      );
    }

    return (
      <Footer>
        {/* `readyProviders`, not a hand-rolled `models.length > 0`: "which
            assistants can actually be used" is one question, and the onboarding
            card, the Settings row and this picker must not answer it three ways. */}
        <Pickers
          settings={settings}
          providers={readyProviders(detected)}
          onChange={commitSettings}
          disabled={state.stage === 'refining'}
        />
        {discardButton()}
        <span className="spacer" />
        <button
          className="btn primary"
          onClick={() => act({ type: 'refine' })}
          disabled={state.raw.trim() === '' || state.stage === 'refining'}
        >
          <Icon name="zap" size={13} />
          Refine
          <kbd>Ctrl+Enter</kbd>
        </button>
      </Footer>
    );
  };

  return (
    <div className="stage">
      <Panel width={state.width}>
        <Header
          view={view}
          repo={repo}
          onSwitchRepo={() => setPickerOpen(true)}
          onOpenIssues={() => void openIssues()}
          onOpenSettings={() => setView('settings')}
          onHide={() => act({ type: 'esc' })}
          onBack={() => setView('capture')}
        />
        <WarningSlot warnings={warnings} onCopy={(text) => void services.copy(text)} />
        <Body>{body()}</Body>
        {footerContent()}
      </Panel>

      {pickerOpen && (
        <RepoSwitcher repos={repos} current={repo} onPick={pickRepo} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
