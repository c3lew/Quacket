// @vitest-environment jsdom
/**
 * The wiring tests.
 *
 * `App.tsx` is where the reducer's decisions are supposed to become real: an
 * effect performed, a file written, a notification fired. The reducer proves it
 * DECIDED to notify; only this proves anyone was told. Every blocker v1 shipped
 * lived in the gap between those two claims, because no test could reach it.
 *
 * These drive the real component through real services-shaped fakes and assert
 * only what crosses the port — never internal state, never call order.
 */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DraftStore } from '../core/drafts/store.ts';
import { nodeFiles } from '../core/testing/node-files.ts';
import {
  DEFAULT_SETTINGS,
  type Draft,
  type ProviderCapabilities,
  type RefinedDraft,
  type Repo,
  type Settings,
} from '../core/types.ts';
import type { DetectedState } from '../core/ui/onboarding.ts';
import { App } from './App.tsx';
import type { UiServices } from './components/services.ts';

afterEach(cleanup);

/*
 * jsdom ships no object-URL machinery, and a thumbnail turns its bytes into one
 * to render. Nothing here tests the <img src>; what matters is that the image
 * reached the palette at all, so the URL is stubbed rather than the thumbnail
 * being kept out of these tests.
 */
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const REPO: Repo = { nameWithOwner: 'c3lew/Quacket', isPrivate: false };

const CLAUDE: ProviderCapabilities = {
  provider: 'claude',
  cliVersion: '2.1.210',
  account: 'eva8isverygood@gmail.com',
  models: [{ id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] }],
};

const CODEX: ProviderCapabilities = {
  provider: 'codex',
  cliVersion: '0.144.4',
  account: 'eva8isverygood@gmail.com',
  models: [{ id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['medium', 'high'] }],
};

/** Installed, but logged out: enumeration got nothing, so it can refine nothing. */
const CLAUDE_LOGGED_OUT: ProviderCapabilities = {
  provider: 'claude',
  cliVersion: '',
  account: null,
  models: [],
};

const settings = (extra: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  model: 'sonnet',
  effort: 'medium',
  ...extra,
});

const detected = (extra: Partial<DetectedState> = {}): DetectedState => ({
  gh: { installed: true, authenticated: true },
  providers: [CLAUDE],
  settings: settings(),
  autostart: false,
  ...extra,
});

const refined = (extra: Partial<RefinedDraft> = {}): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after explorer.exe restarts',
  sections: [{ heading: 'Actual', body: 'The icon is gone.' }],
  followUps: [],
  similarIssues: [],
  ...extra,
});

const never = (): Promise<never> => new Promise(() => {});

/** Everything the palette touches, scripted. Overridable one method at a time. */
function fakeServices(extra: Partial<UiServices> = {}) {
  const spies = {
    detect: vi.fn(async () => detected()),
    hotkeyConflict: vi.fn(async () => null),
    listRepos: vi.fn(async () => [REPO]),
    listIssues: vi.fn(async () => []),
    refine: vi.fn(async () => ({
      draft: refined(),
      thread: { provider: 'claude' as const, sessionId: 's1', dir: '/tmp/x' },
      candidates: [],
    })),
    followUp: vi.fn(async () => refined()),
    submit: vi.fn(async () => ({ url: 'https://github.com/c3lew/Quacket/issues/7', issueNumber: 7 })),
    loadDraft: vi.fn(async (): Promise<Draft | null> => null),
    saveDraft: vi.fn(async () => {}),
    attachImage: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {}),
    loadSettings: vi.fn(async () => settings()),
    saveSettings: vi.fn(async () => {}),
    setAutostart: vi.fn(async () => {}),
    applyHotkey: vi.fn(async () => null),
    notify: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    setWidth: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    readImages: vi.fn(async () => []),
    pickImages: vi.fn(async () => []),
    onSummon: vi.fn(() => () => {}),
    onDropFiles: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(async (): Promise<{ version: string } | null> => null),
    installUpdate: vi.fn(async () => {}),
    ...extra,
  };
  return spies as unknown as UiServices & typeof spies;
}

/** Renders and waits for boot detection to land. */
async function boot(services: UiServices) {
  render(<App services={services} />);
  await waitFor(() => expect(screen.queryByText('Checking your setup…')).toBeNull());
  return services;
}

const CAPTURE_BOX = 'What broke? Type it however it comes out.';

const type = async (text: string) => {
  const input = await screen.findByPlaceholderText(CAPTURE_BOX);
  await act(async () => fireEvent.change(input, { target: { value: text } }));
};

const click = async (name: RegExp | string) => {
  const button = await screen.findByRole('button', { name });
  await act(async () => fireEvent.click(button));
};

const press = async (key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => {
  await act(async () =>
    fireEvent.keyDown(document, { key, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false }),
  );
};

/**
 * What a `<select>` actually SHOWS the user — which is not `select.value`, and
 * emphatically not the React state behind it. A value matching no option leaves
 * the browser displaying `option[0]` and reading it back as the value, so both of
 * those agree with each other while disagreeing with the app.
 */
const shows = (select: HTMLElement): string =>
  (select as HTMLSelectElement).options[(select as HTMLSelectElement).selectedIndex]?.textContent ?? '';

/** Walks the palette to the draft screen the way a user does. */
async function toDraftScreen(services: UiServices) {
  await boot(services);
  await type('tray icon vanished after explorer restart');
  await click(/Refine/);
  await screen.findByDisplayValue(refined().title);
}

// ── Story 27: bad news reaches a hidden window ──────────────────────────────

describe('a submit that fails while the window is hidden', () => {
  it('NOTIFIES the user', async () => {
    // The reducer decides to notify; this is the only thing that can prove anyone
    // was told. `runSubmit` dispatches `images-uploaded` right after
    // `submit-failed` in the same React batch — which used to render the notify
    // effect over before it was ever performed, so the notification that is the
    // entire point of story 27 reached nobody.
    const services = fakeServices({
      submit: vi.fn(async () => {
        throw new Error('Could not create the issue.');
      }),
    });
    await toDraftScreen(services);

    await press('Escape'); // to tray — the submit keeps going
    await click(/Submit issue/);

    await waitFor(() => expect(services.notify).toHaveBeenCalledWith('Could not create the issue.'));
  });

  it('stays silent on success — notifications carry only bad news', async () => {
    const services = fakeServices();
    await toDraftScreen(services);

    await press('Escape');
    await click(/Submit issue/);

    await waitFor(() => expect(services.submit).toHaveBeenCalled());
    expect(services.notify).not.toHaveBeenCalled();
  });

  /**
   * Story 16 says last-USED, not last-picked. Live QA filed a real issue through
   * the real app and found lastRepo still null afterwards: it was only written by
   * the Ctrl+R switcher, so a user filing against the repos[0] default never got
   * it persisted — and repos[0] reorders whenever any other repo is pushed,
   * silently retargeting their next report.
   */
  it('persists the repo as last-used on a successful submit, without the switcher', async () => {
    const services = fakeServices();
    await toDraftScreen(services);
    vi.mocked(services.saveSettings).mockClear();

    await click(/Submit issue/);

    await waitFor(() =>
      expect(vi.mocked(services.saveSettings).mock.calls.some(
        ([s]) => s.lastRepo === REPO.nameWithOwner,
      )).toBe(true),
    );
  });

  it('stays silent when the window is up — the error card is already on screen', async () => {
    const services = fakeServices({
      submit: vi.fn(async () => {
        throw new Error('Could not create the issue.');
      }),
    });
    await toDraftScreen(services);

    await click(/Submit issue/);

    await screen.findByText('Could not create the issue.');
    expect(services.notify).not.toHaveBeenCalled();
  });
});

/** A real DraftStore over a real temp dir — the only proof a draft is on DISK. */
const withStore = async (run: (store: DraftStore, dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'quacket-app-'));
  try {
    await run(new DraftStore(dir, nodeFiles), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Lets a test fire the native drag-drop the way Tauri does: paths, no File. */
function dropper() {
  let handler: ((paths: string[]) => void) | null = null;
  return {
    onDropFiles: vi.fn((h: (paths: string[]) => void) => {
      handler = h;
      return () => {};
    }),
    drop: async (paths: string[]) => {
      await act(async () => handler?.(paths));
    },
  };
}

// ── #15 / story 28: killed mid-flight ──────────────────────────────────────

describe('an app killed mid-flight', () => {
  it('leaves the draft on disk marked in-flight, so it restores with a Retry', async () => {
    await withStore(async (store) => {
      /*
       * The real submit bracket, exactly as `components/services.ts` writes it:
       * beginSubmit marks the draft in-flight, then the pipeline runs. Here it
       * never returns — the app is killed inside the bracket.
       */
      const services = fakeServices({
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        submit: vi.fn(async (draft: Draft) => {
          await store.beginSubmit(draft);
          return never();
        }),
      });
      await toDraftScreen(services);
      await click(/Submit issue/);
      await waitFor(() => expect(services.submit).toHaveBeenCalled());

      // Let every queued auto-save land, then "kill" the app and reload from disk.
      await new Promise((r) => setTimeout(r, 30));
      const restored = await store.load();

      expect(restored).not.toBeNull();
      expect(restored?.lastError?.kind).toBe('create_failed');
      expect(restored?.lastError?.message).toContain('Retry');
    });
  });

  it('does not lose the report text it was submitting', async () => {
    await withStore(async (store) => {
      const services = fakeServices({
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        submit: vi.fn(async (draft: Draft) => {
          await store.beginSubmit(draft);
          return never();
        }),
      });
      await toDraftScreen(services);
      await click(/Submit issue/);
      await waitFor(() => expect(services.submit).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));

      expect((await store.load())?.raw).toBe('tray icon vanished after explorer restart');
    });
  });

  /**
   * The SECOND writer. `shouldSaveDraft` refusing to write mid-flight was never
   * the guarantee — it only ever spoke for the auto-save, and the auto-save is
   * not the only thing that writes draft.json. `attach` goes through the store's
   * attach path, which wrote `inFlight: false` without ever consulting it, and a
   * paste listens on the document at EVERY stage: the spinner is up, the user
   * pastes the screenshot they meant to include, and the mark is gone.
   *
   * Which makes this the worst version of story 28 rather than a corner of it:
   * the draft that loses its Retry is the one the user cared about enough to keep
   * adding to.
   */
  it('keeps the Retry when a screenshot arrives mid-flight', async () => {
    await withStore(async (store) => {
      const d = dropper();
      const services = fakeServices({
        onDropFiles: d.onDropFiles,
        readImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]),
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        attachImage: vi.fn((draft: Draft, image) => store.attachImage(draft, image).then(() => {})),
        submit: vi.fn(async (draft: Draft) => {
          await store.beginSubmit(draft);
          return never(); // The app is killed inside the bracket.
        }),
      });
      await toDraftScreen(services);
      await click(/Submit issue/);
      await waitFor(() => expect(services.submit).toHaveBeenCalled());

      // The screenshot lands while the submit is still in the air.
      await d.drop(['C:\\Users\\user\\shot.png']);
      await waitFor(() => expect(services.attachImage).toHaveBeenCalled());
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));

      // "Killed." The next launch is a real one: a fresh App over the same disk.
      cleanup();
      await boot(fakeServices({ loadDraft: vi.fn(() => store.load()) }));

      // #15: "restores the draft in a failed-submit state with manual Retry" —
      // a button the user can press, not a flag a test can read.
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
      expect(await screen.findByText(/closed while this report was being submitted/)).toBeVisible();
    });
  });

  it('still has the screenshot that arrived mid-flight when it restores', async () => {
    // The mark must not be bought by dropping the write it rode in on.
    await withStore(async (store) => {
      const d = dropper();
      const services = fakeServices({
        onDropFiles: d.onDropFiles,
        readImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]),
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        attachImage: vi.fn((draft: Draft, image) => store.attachImage(draft, image).then(() => {})),
        submit: vi.fn(async (draft: Draft) => {
          await store.beginSubmit(draft);
          return never();
        }),
      });
      await toDraftScreen(services);
      await click(/Submit issue/);
      await waitFor(() => expect(services.submit).toHaveBeenCalled());
      await d.drop(['C:\\Users\\user\\shot.png']);
      await waitFor(() => expect(services.attachImage).toHaveBeenCalled());
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));

      const restored = await store.load();
      expect(restored?.images[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});

// ── Story 31: explicit Discard ─────────────────────────────────────────────

describe('discard', () => {
  it('is a control you can SEE, not a keystroke you have to be told about', async () => {
    await boot(fakeServices());
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull();

    await type('tray icon vanished');
    expect(await screen.findByRole('button', { name: /Discard/ })).toBeVisible();
  });

  it('actually deletes the draft folder and clears the palette', async () => {
    // discardDraft was implemented, exported and had ZERO callers: a user could
    // never drop a draft. The slot freed only on submit success, and clearing the
    // textarea skipped the save without deleting the folder — so the draft came
    // silently back on the next summon. Undeletable.
    const services = await boot(fakeServices());
    await type('tray icon vanished');

    await click(/Discard/);

    await waitFor(() => expect(services.discardDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toHaveValue('');
  });

  it('drops a refined draft too, not just raw text', async () => {
    const services = fakeServices();
    await toDraftScreen(services);

    await click(/Discard/);

    await waitFor(() => expect(services.discardDraft).toHaveBeenCalledTimes(1));
    expect(await screen.findByPlaceholderText(CAPTURE_BOX)).toHaveValue('');
  });

  it('has a shortcut ON TOP of the button, never instead of it', async () => {
    const services = await boot(fakeServices());
    await type('tray icon vanished');

    await press('D', { ctrl: true, shift: true });

    await waitFor(() => expect(services.discardDraft).toHaveBeenCalledTimes(1));
  });

  it('is the ONLY way a draft is lost — Esc hides, it does not discard', async () => {
    const services = await boot(fakeServices());
    await type('tray icon vanished');

    await press('Escape');

    await waitFor(() => expect(services.hide).toHaveBeenCalled());
    expect(services.discardDraft).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toHaveValue(
      'tray icon vanished',
    );
  });

  it('does not fire on an empty palette', async () => {
    const services = await boot(fakeServices());
    await press('D', { ctrl: true, shift: true });

    expect(services.discardDraft).not.toHaveBeenCalled();
  });
});

// ── Story 29: auto-save is unconditional ───────────────────────────────────

describe('typing before a repo is known', () => {
  /**
   * #35's own scenario: `gh` cannot list repos, so there is no target — and the
   * spec deliberately KEEPS THE CAPTURE BOX LIVE anyway, because a broken
   * prerequisite must never stop you capturing.
   */
  const noRepos = (extra: Partial<UiServices> = {}) =>
    fakeServices({
      listRepos: vi.fn(async () => {
        throw new Error('gh auth broken');
      }),
      ...extra,
    });

  it('still auto-saves from the first keystroke', async () => {
    /*
     * The auto-save was gated on a non-null repo, so in exactly this scenario the
     * user typed into a fully live capture box and NOTHING was persisted. A close,
     * crash or update lost the draft — and there was no Discard to be seen either,
     * because as far as the app was concerned no draft existed.
     *
     * The repo is a submit-time ADDRESS, not the draft's identity: drafts live at
     * `<baseDir>/drafts/<id>/` and never needed one.
     */
    const services = await boot(noRepos());
    await type('tray icon vanished after explorer restart');

    await waitFor(() => expect(services.saveDraft).toHaveBeenCalled());
    expect(vi.mocked(services.saveDraft).mock.calls.at(-1)?.[0]).toMatchObject({
      raw: 'tray icon vanished after explorer restart',
    });
  });

  it('survives the crash that story 29 exists for', async () => {
    await withStore(async (store) => {
      const services = noRepos({ saveDraft: vi.fn((draft: Draft) => store.save(draft)) });
      await boot(services);
      await type('half-written report I care about');
      await waitFor(() => expect(services.saveDraft).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));

      // "Killed." What comes back is what the next summon would restore.
      expect((await store.load())?.raw).toBe('half-written report I care about');
    });
  });

  it('gives the user the Discard that proves the draft is real', async () => {
    // Story 31 makes Discard the only way to lose work. No save, no draft, no
    // Discard — the control that guards the work vanished with the work.
    await boot(noRepos());
    await type('tray icon vanished');

    expect(await screen.findByRole('button', { name: /Discard/ })).toBeVisible();
  });

  it('persists a screenshot dropped before a repo is chosen', async () => {
    // Story 29 covers what was PASTED as much as what was typed, and attachImage
    // is the only thing that writes the bytes. Skipped, the draft restores
    // claiming an image whose file was never written — which the store treats as
    // corruption and throws on.
    const d = dropper();
    const services = noRepos({
      onDropFiles: d.onDropFiles,
      readImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]),
    });
    await boot(services);

    await d.drop(['C:\\Users\\user\\shot.png']);

    await waitFor(() => expect(services.attachImage).toHaveBeenCalled());
  });
});

// ── The blocker: a draft that takes the app hostage ────────────────────────

describe('a saved draft that cannot be reopened', () => {
  /**
   * `DraftStore.load()` is DOCUMENTED to throw when a manifest entry's bytes are
   * gone, deliberately and correctly — silently restoring a report the user
   * believes still has a screenshot is worse than refusing.
   *
   * What it must never do is stop the app. Boot bundled detection, the hotkey
   * probe and the restore into ONE `Promise.all` with no catch, so this rejection
   * aborted the whole continuation before `applyDetected` ever ran: the palette
   * sat on "Checking your setup…" forever. No capture box, no error card, not
   * even Discard. That is #8's entire draft-safety posture inverted — the draft
   * holding the app hostage — and a draft you cannot open is precisely the one
   * you most need a working window to get past.
   */
  const corrupt = (extra: Partial<UiServices> = {}) =>
    fakeServices({
      loadDraft: vi.fn(async (): Promise<Draft | null> => {
        throw new Error('draft image img_1 is missing from disk');
      }),
      ...extra,
    });

  it('lets the user file a report anyway, start to finish', async () => {
    const services = corrupt();
    render(<App services={services} />);

    await type('tray icon vanished after explorer restart');
    await click(/Refine/);
    await screen.findByDisplayValue(refined().title);
    await click(/Submit issue/);

    await waitFor(() => expect(services.submit).toHaveBeenCalled());
    expect(await screen.findByText('Issue #7 filed')).toBeVisible();
  });

  it('leaves every other boot job standing — the repo pill still fills in', async () => {
    // Same `Promise.all`, same blast radius: detection and the repo list are not
    // the draft's business and must not go down with it.
    await boot(corrupt());

    expect(await screen.findByText(REPO.nameWithOwner)).toBeVisible();
  });

  it('says so, once, in plain language', async () => {
    await boot(corrupt());

    const warning = await screen.findByText(/could not be reopened/);
    expect(warning).toBeVisible();
    expect(warning.textContent).not.toMatch(/manifest|disk|img_|json|corrupt|null|undefined/i);
  });

  it('is news, not a task — nothing is asked of the user, so it dismisses', async () => {
    await boot(corrupt());

    await click('Got it');

    await waitFor(() => expect(screen.queryByText(/could not be reopened/)).toBeNull());
  });

  it('says nothing when the draft reopens fine', async () => {
    const services = fakeServices();
    services.loadDraft = vi.fn(async () => ({
      id: 'd1',
      repo: REPO.nameWithOwner,
      raw: 'half-written report I care about',
      images: [],
      target: { kind: 'new-issue' as const },
    }));
    await boot(services);

    expect(await screen.findByDisplayValue('half-written report I care about')).toBeVisible();
    expect(screen.queryByText(/could not be reopened/)).toBeNull();
  });
});

// ── The chain: a screenshot the disk refused ───────────────────────────────

describe('a screenshot whose bytes cannot be saved', () => {
  /** Pastes the way the OS does: a real image File on the clipboard. */
  const pasteImage = async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(document, { clipboardData: { files: [file], items: [], types: ['Files'] } });
      await Promise.resolve();
    });
  };

  const PNG = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const };

  /** The write fails; everything else about the machine is fine. */
  const dead = (extra: Partial<UiServices> = {}) =>
    fakeServices({
      attachImage: vi.fn(async () => {
        throw new Error('There is not enough space on the disk.');
      }),
      readImages: vi.fn(async () => [PNG]),
      pickImages: vi.fn(async () => [PNG]),
      ...extra,
    });

  it('shows no thumbnail, because a thumbnail promises the screenshot is saved', async () => {
    const d = dropper();
    await boot(dead({ onDropFiles: d.onDropFiles }));

    await d.drop(['C:\\Users\\user\\shot.png']);

    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit screenshot 1' })).toBeNull();
  });

  it('says so on the paste route', async () => {
    // `void file.arrayBuffer().then(() => addImage(...))` — a rejection with
    // nowhere to go. The screenshot vanished from the report with no sign at all.
    await boot(dead());

    await pasteImage();

    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit screenshot 1' })).toBeNull();
  });

  it('says so on the pick route', async () => {
    await boot(dead());

    await click('Add screenshot');

    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit screenshot 1' })).toBeNull();
  });

  it('says so on the drag-drop route, whose try only ever guarded the read', async () => {
    const d = dropper();
    const services = dead({ onDropFiles: d.onDropFiles });
    await boot(services);

    await d.drop(['C:\\Users\\user\\shot.png']);

    // The read WORKED, so this is not the read's warning — it is the write's.
    await waitFor(() => expect(services.readImages).toHaveBeenCalled());
    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.queryByText(/could not be added/)).toBeNull();
  });

  it('offers a Try again that really re-saves the same screenshot', async () => {
    const d = dropper();
    const attachImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('There is not enough space on the disk.'))
      .mockResolvedValue(undefined);
    await boot(dead({ onDropFiles: d.onDropFiles, attachImage }));
    await d.drop(['C:\\Users\\user\\shot.png']);
    await screen.findByText(/could not be saved/);

    await click('Try again');

    // The screenshot lands, and the warning goes with it — it was true, now it is not.
    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull());
  });

  it('leaves a draft that still opens — the whole chain, against a real store', async () => {
    /*
     * The end of the chain, proven on a real disk. `add-image` was dispatched
     * BEFORE the write, so the auto-save — which builds draft.json FROM STATE —
     * recorded an image whose bytes only `attachImage` was ever going to write.
     * A failed write therefore left a manifest entry with no file, which
     * `DraftStore.imageBytes` correctly calls corruption and throws on, and that
     * throw is what bricked the next boot.
     *
     * Landing the bytes first is what makes the manifest structurally unable to
     * lie: state can only ever describe images that are really on disk.
     */
    await withStore(async (store) => {
      const d = dropper();
      const services = dead({
        onDropFiles: d.onDropFiles,
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
      });
      await boot(services);
      await type('tray icon vanished after explorer restart');
      await d.drop(['C:\\Users\\user\\shot.png']);
      await screen.findByText(/could not be saved/);
      await new Promise((r) => setTimeout(r, 30));

      // The next summon. The words come back, and nothing throws.
      const restored = await store.load();
      expect(restored?.raw).toBe('tray icon vanished after explorer restart');
      expect(restored?.images).toEqual([]);
    });
  });

  it('says nothing when the write works', async () => {
    const d = dropper();
    await boot(fakeServices({ onDropFiles: d.onDropFiles, readImages: vi.fn(async () => [PNG]) }));

    await d.drop(['C:\\Users\\user\\shot.png']);

    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    expect(screen.queryByText(/could not be saved/)).toBeNull();
  });
});

// ── A drag-drop the fs refuses ─────────────────────────────────────────────

describe('an image dragged in that cannot be read', () => {
  const denied = () =>
    dropper();

  it('SAYS SO, instead of silently never appearing', async () => {
    // The read was a `void`-ed async IIFE: the rejection went nowhere and the
    // image just never showed up. No error, no feedback, nothing to retry.
    const d = denied();
    const services = fakeServices({
      onDropFiles: d.onDropFiles,
      readImages: vi.fn(async () => {
        throw new Error('forbidden path: C:\\Users\\user\\shot.png');
      }),
    });
    await boot(services);

    await d.drop(['C:\\Users\\user\\shot.png']);

    const warning = await screen.findByText(/could not be added/);
    expect(warning).toBeVisible();
    // Named the way the user knows it — they dragged a file, not a path.
    expect(warning.textContent).toContain('shot.png');
  });

  it('offers a Try again that really re-reads the file', async () => {
    const d = denied();
    const readImages = vi
      .fn()
      .mockRejectedValueOnce(new Error('forbidden path'))
      .mockResolvedValueOnce([{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]);
    const services = fakeServices({ onDropFiles: d.onDropFiles, readImages });
    await boot(services);
    await d.drop(['C:\\Users\\user\\shot.png']);
    await screen.findByText(/could not be added/);

    await click('Try again');

    // The image lands, and the warning goes with it — it was true, now it is not.
    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/could not be added/)).toBeNull());
  });

  it('says nothing when the read works', async () => {
    const d = denied();
    const services = fakeServices({
      onDropFiles: d.onDropFiles,
      readImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]),
    });
    await boot(services);

    await d.drop(['C:\\Users\\user\\shot.png']);

    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    expect(screen.queryByText(/could not be added/)).toBeNull();
  });
});

// ── The other half of the same route: a read on paste and pick ─────────────

/**
 * Round 4 closed the WRITE half on all three routes. The READ half was closed on
 * exactly ONE — the drop's `try` — so `services.pickImages()` sat outside
 * `addImages`'s never-rejects boundary and escaped into `void pickImages()`, and
 * the paste route's `file.arrayBuffer()` had no `.catch` at all. Half a route
 * inside the boundary and half outside: the only trace of a lost screenshot was
 * an unhandled rejection in a console the user is not reading.
 *
 * "could not be ADDED" is the read's wording and stays distinct from the write's
 * "could not be SAVED, so it is not in your report". They are different events —
 * one means the screenshot never got here, the other means it got here and is not
 * in the ticket — so they must not read the same.
 */
describe('a screenshot the page never manages to read', () => {
  /** What Node reports for a promise nobody handled — the reviewer's exact trace. */
  const watchUnhandled = () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onRejection);
    return { seen, stop: () => void process.off('unhandledRejection', onRejection) };
  };

  /** Long enough for a rejection with nowhere to go to be reported as such. */
  const settle = () => new Promise((r) => setTimeout(r, 10));

  /** Pastes the way the OS does, with a File whose bytes refuse to be read. */
  const pasteUnreadable = async (arrayBuffer: () => Promise<ArrayBuffer>) => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
    await act(async () => {
      fireEvent.paste(document, { clipboardData: { files: [file], items: [], types: ['Files'] } });
      await Promise.resolve();
    });
  };

  it('SAYS SO on the pick route, instead of dropping the rejection on the floor', async () => {
    const watch = watchUnhandled();
    try {
      const services = fakeServices({
        pickImages: vi.fn(async () => {
          throw new Error('The file could not be opened.');
        }),
      });
      await boot(services);

      await click('Add screenshot');

      const warning = await screen.findByText(/could not be added/);
      expect(warning).toBeVisible();
      expect(warning.textContent).toContain('The file could not be opened.');
      // The read died, so nothing was ever offered to the disk — this is not the
      // write's failure and must not borrow the write's words.
      expect(screen.queryByText(/could not be saved/)).toBeNull();
      expect(services.attachImage).not.toHaveBeenCalled();

      await settle();
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('SAYS SO on the paste route, whose .then never had a .catch', async () => {
    const watch = watchUnhandled();
    try {
      const services = await boot(fakeServices());

      await pasteUnreadable(() => Promise.reject(new Error('The screenshot could not be read.')));

      const warning = await screen.findByText(/could not be added/);
      expect(warning).toBeVisible();
      expect(warning.textContent).toContain('The screenshot could not be read.');
      expect(screen.queryByText(/could not be saved/)).toBeNull();
      expect(services.attachImage).not.toHaveBeenCalled();

      await settle();
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('shows no thumbnail — nothing reached the page, let alone the report', async () => {
    await boot(
      fakeServices({
        pickImages: vi.fn(async () => {
          throw new Error('The file could not be opened.');
        }),
      }),
    );

    await click('Add screenshot');

    await screen.findByText(/could not be added/);
    expect(screen.queryByRole('button', { name: 'Edit screenshot 1' })).toBeNull();
  });

  it('offers a Try again that really re-opens the picker', async () => {
    const pickImages = vi
      .fn()
      .mockRejectedValueOnce(new Error('The file could not be opened.'))
      .mockResolvedValueOnce([{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]);
    await boot(fakeServices({ pickImages }));
    await click('Add screenshot');
    await screen.findByText(/could not be added/);

    await click('Try again');

    // The screenshot lands, and the warning goes with it — it was true, now it is not.
    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/could not be added/)).toBeNull());
  });

  it('offers a Try again that re-reads the very image that was pasted', async () => {
    // Not "paste it again": the clipboard has likely moved on, and the File the
    // user handed over is still in hand.
    const arrayBuffer = vi
      .fn()
      .mockRejectedValueOnce(new Error('The screenshot could not be read.'))
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
    await boot(fakeServices());
    await pasteUnreadable(arrayBuffer);
    await screen.findByText(/could not be added/);

    await click('Try again');

    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/could not be added/)).toBeNull());
  });

  it('says nothing when the pick works', async () => {
    await boot(
      fakeServices({
        pickImages: vi.fn(async () => [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }]),
      }),
    );

    await click('Add screenshot');

    expect(await screen.findByRole('button', { name: 'Edit screenshot 1' })).toBeVisible();
    expect(screen.queryByText(/could not be added/)).toBeNull();
  });
});

// ── Story 35 / #9: a broken prerequisite on an established install ─────────

describe('gh auth expiring on an install that has been working for months', () => {
  const lapsed = () =>
    fakeServices({
      detect: vi.fn(async () => detected({ gh: { installed: true, authenticated: false } })),
      listRepos: vi.fn(async () => {
        throw new Error('gh auth broken');
      }),
    });

  it('leaves the capture surface up — the warning is non-blocking', async () => {
    await boot(lapsed());

    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toBeVisible();
  });

  it('says it ONCE, with ONE button to act on', async () => {
    // It used to be said twice at once — first-run onboarding taking the window
    // AND the warning slot — with two competing "Check again" buttons.
    await boot(lapsed());

    expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(1);
    expect(screen.getAllByText(/GitHub sign-in has expired/)).toHaveLength(1);
  });

  it('does not throw away a silently-restored draft to show onboarding', async () => {
    // The worst of it: the draft restores into a window that is then replaced.
    const services = lapsed();
    services.loadDraft = vi.fn(async () => ({
      id: 'd1',
      repo: REPO.nameWithOwner,
      raw: 'half-written report I care about',
      images: [],
      target: { kind: 'new-issue' as const },
    }));
    await boot(services);

    expect(await screen.findByDisplayValue('half-written report I care about')).toBeVisible();
  });

  it('gives the user the command that fixes it', async () => {
    await boot(lapsed());

    expect(screen.getByText('gh auth login')).toBeVisible();
  });

  it('re-detects when the user says they fixed it', async () => {
    const services = lapsed();
    await boot(services);

    await click('Check again');

    await waitFor(() => expect(services.detect).toHaveBeenCalledTimes(2));
  });
});

describe('a new version waiting on the release feed', () => {
  const updatable = () =>
    fakeServices({
      checkForUpdate: vi.fn(async () => ({ version: '0.3.0' })),
    });

  it('offers it in the warning slot without blocking capture', async () => {
    await boot(updatable());

    expect(await screen.findByText('Quacket 0.3.0 is ready to install.')).toBeVisible();
    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toBeVisible();
  });

  it('installs on the one visible action', async () => {
    const services = updatable();
    await boot(services);
    await screen.findByText('Quacket 0.3.0 is ready to install.');

    await click('Update now');

    await waitFor(() => expect(services.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('stays silent when the check finds nothing — the default fake is up to date', async () => {
    await boot(fakeServices());

    expect(screen.queryByText(/ready to install/)).toBeNull();
  });
});

describe('a genuine first run', () => {
  /** Nothing picked yet — the one thing that makes this a first run (#11). */
  const fresh = (extra: Partial<DetectedState> = {}) =>
    fakeServices({
      detect: vi.fn(async () => detected({ settings: settings({ model: null, effort: null }), ...extra })),
    });

  it('still gets the onboarding cards', async () => {
    await boot(
      fresh({ gh: { installed: false, authenticated: false }, providers: [] }),
    );

    expect(screen.queryByPlaceholderText(CAPTURE_BOX)).toBeNull();
    expect(screen.getByText('winget install GitHub.cli')).toBeVisible();
  });

  it('can be FINISHED, without relaunching the app', async () => {
    /*
     * The blocker every other first-run test walked past: they all asserted the
     * cards APPEAR, so nothing noticed that they could never leave.
     *
     * "Use Claude Code" is the card the code itself calls "the card that ends
     * setup". It saved the model to `settings` — while the cards derived from the
     * separate `detected` snapshot, which only boot and `recheck` ever wrote. So
     * the cards stayed up, and on this path (gh fine, a provider ready) not one
     * card carries a re-check button: the capture textarea was unreachable until
     * the app was killed and relaunched. First launch, unusable.
     *
     * So this drives a first run to COMPLETION and files a report with it.
     */
    const services = await boot(fresh());
    expect(screen.queryByPlaceholderText(CAPTURE_BOX)).toBeNull();

    await click(/Use Claude Code/);

    // #11 / story 42: "the final card collapses into the real capture textarea".
    expect(await screen.findByPlaceholderText(CAPTURE_BOX)).toBeVisible();

    // And it is a REAL textarea, not just a rendered one: the whole flow works.
    await type('tray icon vanished after explorer restart');
    await click(/Refine/);
    await screen.findByDisplayValue(refined().title);

    expect(vi.mocked(services.refine).mock.calls[0]?.[0]?.settings.model).toBe('sonnet');
  });

  it('remembers the autostart box the user just ticked', async () => {
    // The same split, second symptom: the checkbox wrote `autostart` while the
    // card rendered `detected.autostart`, so ticking it visibly bounced back off.
    const services = await boot(fresh());
    const box = await screen.findByRole('checkbox', { name: /Start Quacket when Windows starts/ });
    expect(box).not.toBeChecked();

    fireEvent.click(box);

    await waitFor(() => expect(services.setAutostart).toHaveBeenCalledWith(true));
    expect(box).toBeChecked();
  });
});

// ── Story 38: a model that vanished ────────────────────────────────────────

describe('a model the CLI stopped offering', () => {
  const vanished = () =>
    fakeServices({
      detect: vi.fn(async () => detected({ settings: settings({ model: 'claude-sonnet-4-0' }) })),
    });

  it('falls back to a real model instead of handing the CLI a dead id', async () => {
    const services = vanished();
    await boot(services);
    await type('tray icon vanished');
    await click(/Refine/);

    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(vi.mocked(services.refine).mock.calls[0]?.[0]?.settings.model).toBe('sonnet');
  });

  it('clears the stored choice so the notice never fires twice', async () => {
    const services = vanished();
    await boot(services);

    await waitFor(() => expect(services.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(services.saveSettings).mock.calls[0]?.[0]).toMatchObject({ model: 'sonnet' });
  });

  it('says so in plain language, without blocking anything', async () => {
    await boot(vanished());

    // Names the model the way the picker names it, and says what Quacket already
    // did — no ids, no jargon, nothing asked of the user.
    const notice = await screen.findByText(/is not offered any more/);
    expect(notice).toBeVisible();
    expect(notice.textContent).toContain('Sonnet 5');
    expect(notice.textContent).not.toMatch(/enumerat|reconcil|null|undefined/i);

    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toBeVisible();
  });

  it('is dismissible — the fallback has already landed, so it is news, not a task', async () => {
    await boot(vanished());
    await click('Got it');

    await waitFor(() => expect(screen.queryByText(/is not offered any more/)).toBeNull());
  });

  it('says nothing at all when the stored model still exists', async () => {
    const services = await boot(fakeServices());

    expect(screen.queryByText(/is not offered any more/)).toBeNull();
    expect(services.saveSettings).not.toHaveBeenCalled();
  });
});

// ── Story 38: an assistant that vanished, not just a model ─────────────────

describe('an AI CLI that is gone from a machine that was using it', () => {
  /**
   * Claude was picked months ago. Since then its CLI stopped answering — logged
   * out, or uninstalled — and codex is what this machine has now.
   */
  const claudeGone = (extra: Partial<DetectedState> = {}) =>
    fakeServices({
      detect: vi.fn(async () =>
        detected({ providers: [CODEX], settings: settings({ provider: 'claude', model: 'sonnet' }), ...extra }),
      ),
    });

  it('does not keep handing the CLI a dead provider forever', async () => {
    // Reconciliation only ever looked WITHIN the stored provider, so a provider
    // that vanished outright was never noticed: `claude`+`sonnet` went over the
    // wire on every refine, on a machine with no claude, with no notice and no
    // warning — story 38's exact failure, one level up from where it was caught.
    const services = claudeGone();
    await boot(services);
    await type('tray icon vanished');
    await click(/Refine/);

    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(vi.mocked(services.refine).mock.calls[0]?.[0]?.settings).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.1-codex',
    });
  });

  it('is the same story when the CLI is merely signed out', async () => {
    const services = claudeGone({ providers: [CLAUDE_LOGGED_OUT, CODEX] });
    await boot(services);
    await type('tray icon vanished');
    await click(/Refine/);

    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(vi.mocked(services.refine).mock.calls[0]?.[0]?.settings.provider).toBe('codex');
  });

  it('says so once, in plain language, and blocks nothing', async () => {
    await boot(claudeGone());

    const notice = await screen.findByText(/Claude Code is not available any more/);
    expect(notice.textContent).toContain('Codex');
    expect(notice.textContent).not.toMatch(/enumerat|reconcil|provider|null|undefined/i);
    expect(screen.getByPlaceholderText(CAPTURE_BOX)).toBeVisible();
  });

  it('writes the fallback back, so the notice never fires twice', async () => {
    const services = claudeGone();
    await boot(services);

    await waitFor(() => expect(services.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(services.saveSettings).mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.1-codex',
    });
  });

  it('keeps a good choice when there is nothing to fall back TO', async () => {
    // Every CLI logged out at once is not evidence the user's pick is bad. It
    // rides in the warning slot; throwing the setting away would lose it for good.
    const services = fakeServices({
      detect: vi.fn(async () =>
        detected({ providers: [CLAUDE_LOGGED_OUT], settings: settings({ provider: 'claude', model: 'sonnet' }) }),
      ),
    });
    await boot(services);

    expect(screen.queryByText(/is not available any more/)).toBeNull();
    expect(services.saveSettings).not.toHaveBeenCalled();
    expect(await screen.findByText(/No AI assistant is ready/)).toBeVisible();
  });
});

// ── #9: Settings must not misreport what is running ────────────────────────

describe('the Settings screen', () => {
  const openSettings = async () => {
    await click('Settings');
    return screen.findByLabelText('Assistant');
  };

  it('names the assistant that is actually in force', async () => {
    const services = fakeServices({
      detect: vi.fn(async () =>
        detected({ providers: [CODEX], settings: settings({ provider: 'claude', model: 'sonnet' }) }),
      ),
    });
    await boot(services);

    // Whatever the row shows IS the user's answer to "which AI am I running?".
    // It must agree with what refine gets handed — one source of truth or none.
    expect(shows(await openSettings())).toBe('Codex');

    await click(/Back/);
    await type('tray icon vanished');
    await click(/Refine/);
    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(vi.mocked(services.refine).mock.calls[0]?.[0]?.settings.provider).toBe('codex');
  });

  it('never names one Quacket is not set up to use', async () => {
    /*
     * Nothing has been picked yet, so `provider` is still the default 'claude'
     * and reconciliation has nothing to fall back FROM — there is no vanished
     * choice, just a default that does not match this machine.
     *
     * The row rendered value="claude" against options holding only Codex. A
     * select whose value matches no option does not go blank: the browser selects
     * option[0], so the screen read "Codex" — an assistant Quacket was not set to
     * use — and picking the Codex it was already showing fired no change event,
     * so it could not be corrected either.
     */
    const services = fakeServices({
      detect: vi.fn(async () =>
        detected({ providers: [CODEX], settings: settings({ provider: 'claude', model: null, effort: null }) }),
      ),
    });
    await boot(services);
    const assistant = await openSettings();

    expect(shows(assistant)).not.toBe('Codex');

    // ...and it is correctable: picking Codex is what MAKES it Codex.
    fireEvent.change(assistant, { target: { value: 'codex' } });

    await waitFor(() =>
      expect(services.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex', model: 'gpt-5.1-codex' }),
      ),
    );
    expect(shows(await screen.findByLabelText('Assistant'))).toBe('Codex');
  });

  it('does not offer an assistant that cannot refine', async () => {
    // #9: pickers only ever show currently-enumerated options. A signed-out CLI
    // enumerates nothing, so picking it would break the user's next refine.
    await boot(
      fakeServices({
        detect: vi.fn(async () =>
          detected({ providers: [CLAUDE_LOGGED_OUT, CODEX], settings: settings({ provider: 'codex', model: 'gpt-5.1-codex' }) }),
        ),
      }),
    );
    const assistant = await openSettings();

    expect([...(assistant as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Codex']);
  });
});

// ── UI rules ───────────────────────────────────────────────────────────────

describe('icons and labels', () => {
  it('spells Enter as a word, never as a glyph', async () => {
    // `⏎` was the last typographic-glyph-as-icon in the codebase. It renders
    // differently per OS and font, cannot be recoloured, and reads as unfinished.
    await boot(fakeServices());
    await type('tray icon vanished');

    expect(document.body.textContent).not.toContain('⏎');
    expect(await screen.findByText('Ctrl+Enter')).toBeVisible();
  });

  it('names real keys in the hotkey-conflict banner, never the CmdOrCtrl token', async () => {
    await boot(
      fakeServices({
        hotkeyConflict: vi.fn(async () => ({ hotkey: 'CmdOrCtrl+=', reason: 'taken' })),
      }),
    );

    expect(await screen.findByText(/Ctrl\+= is already taken/)).toBeVisible();
    expect(document.body.textContent).not.toContain('CmdOrCtrl');
  });

  it('draws every icon as inline SVG stroking currentColor', async () => {
    await boot(fakeServices());
    await type('tray icon vanished');

    // The duck mark is the one deliberate exception: it is brand art in the
    // tray icon's fixed colours (#23), not a state-tinted icon.
    const svgs = [...document.querySelectorAll('svg:not(.duck-mark)')];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute('stroke') ?? svg.querySelector('[fill="currentColor"]')).toBeTruthy();
    }
  });
});

// ── The annotation editor's Done, which is a SECOND writer of the image ─────

describe('an image that has been marked up', () => {
  /*
   * jsdom ships neither a canvas nor an <img> that ever loads, so the editor
   * could not run here at all — which is exactly why nothing in this file had
   * ever opened it, and why `annotate-done` got to be a second, independent
   * producer of the corruption the intake tests above pin.
   *
   * These fill the two HOST gaps and nothing else: the decode resolving, and the
   * re-encode handing back PNG bytes. Everything between them — the ops, the
   * geometry, the flatten, and every line of App.tsx under test — is real. This
   * is the same category as the `URL.createObjectURL` stub in `beforeAll`: a
   * browser API jsdom lacks, not a failure being stubbed away.
   */
  const FLAT = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
  const JPEG = { bytes: new Uint8Array([255, 216, 255, 224]), mediaType: 'image/jpeg' as const };

  const IMG_PROPS = ['naturalWidth', 'naturalHeight', 'src'] as const;
  const CANVAS_PROPS = ['getContext', 'toBlob'] as const;
  const realImg: PropertyDescriptor[] = [];
  const realCanvas: PropertyDescriptor[] = [];

  beforeAll(() => {
    for (const prop of IMG_PROPS) {
      realImg.push(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, prop)!);
    }
    for (const prop of CANVAS_PROPS) {
      realCanvas.push(Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop)!);
    }
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 50 });
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      set(this: HTMLImageElement) {
        setTimeout(() => this.onload?.(new Event('load')), 0);
      },
    });
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([FLAT]));
    };
  });

  // Put back, both prototypes. A describe added below this one must not silently
  // inherit a canvas that jsdom does not have — that phantom support is exactly
  // the kind of quiet host lie the tests above exist to catch.
  afterAll(() => {
    for (const [i, prop] of IMG_PROPS.entries()) {
      Object.defineProperty(HTMLImageElement.prototype, prop, realImg[i]!);
    }
    for (const [i, prop] of CANVAS_PROPS.entries()) {
      Object.defineProperty(HTMLCanvasElement.prototype, prop, realCanvas[i]!);
    }
  });

  /** Boots, attaches one image, and opens it in the editor the way a user does. */
  const toEditor = async (services: UiServices) => {
    const d = dropper();
    Object.assign(services, { onDropFiles: d.onDropFiles });
    await boot(services);
    await type('the export dialog is unreadable');
    await d.drop(['C:\\Users\\user\\shot.jpg']);
    await click('Edit screenshot 1');
    await screen.findByRole('button', { name: /Done/ });
  };

  it('leaves a draft that still opens — a marked-up JPEG, against a real store', async () => {
    /*
     * The fatal one, and it needed no race: `annotate-done` rewrites `bytes` AND
     * `mediaType` to PNG in state, the auto-save writes draft.json FROM STATE, so
     * the manifest said `img_1.png` while the only file on disk was still the
     * `img_1.jpg` intake wrote. `DraftStore.fileFor` derives the name from
     * mediaType, so `load()` threw `draft image img_1 is missing from disk` and
     * the report could never be reopened. 100% of annotated JPEGs.
     */
    await withStore(async (store) => {
      const services = fakeServices({
        readImages: vi.fn(async () => [JPEG]),
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        attachImage: vi.fn((draft: Draft, image) => store.attachImage(draft, image).then(() => {})),
      });
      await toEditor(services);

      await click(/Done/);
      await waitFor(() => expect(screen.queryByRole('button', { name: /Done/ })).toBeNull());

      // The next summon. Nothing throws, and the words come back.
      const restored = await store.load();
      expect(restored?.raw).toBe('the export dialog is unreadable');
      expect(restored?.images).toHaveLength(1);
    });
  });

  it('KEEPS THE MARKS — the flattened bytes are what comes back off the disk', async () => {
    /*
     * The quiet half of the same defect. Even on a PNG, where the filename never
     * changed, `attachImage` is the only thing that ever writes bytes and the
     * annotate path never called it — so the draft restored with the drawing
     * gone and nothing said so. Asserting on the BYTES is the only way to see it:
     * the manifest looked perfect either way.
     */
    await withStore(async (store) => {
      const services = fakeServices({
        readImages: vi.fn(async () => [JPEG]),
        saveDraft: vi.fn((draft: Draft) => store.save(draft)),
        attachImage: vi.fn((draft: Draft, image) => store.attachImage(draft, image).then(() => {})),
      });
      await toEditor(services);

      await click(/Done/);
      await waitFor(() => expect(screen.queryByRole('button', { name: /Done/ })).toBeNull());

      const restored = await store.load();
      expect(restored?.images[0]?.bytes).toEqual(FLAT);
      expect(restored?.images[0]?.mediaType).toBe('image/png');
      expect(restored?.images[0]?.annotated).toBe(true);
    });
  });

  it('SAYS SO when the marked-up image cannot be saved, instead of showing it as done', async () => {
    const services = fakeServices({
      readImages: vi.fn(async () => [JPEG]),
      attachImage: vi
        .fn()
        .mockResolvedValueOnce(undefined) // the intake write lands
        .mockRejectedValue(new Error('There is not enough space on the disk.')),
    });
    await toEditor(services);

    await click(/Done/);

    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.getByText(/There is not enough space on the disk\./)).toBeVisible();
    // Still open, marks still on the canvas: nothing was thrown away, and the
    // draft still describes the image that is genuinely on disk.
    expect(screen.getByRole('button', { name: /Done/ })).toBeVisible();
  });

  it('lets Try again land the marks that failed the first time', async () => {
    const services = fakeServices({
      readImages: vi.fn(async () => [JPEG]),
      attachImage: vi
        .fn()
        .mockResolvedValueOnce(undefined) // intake
        .mockRejectedValueOnce(new Error('There is not enough space on the disk.'))
        .mockResolvedValue(undefined), // the retry works
    });
    await toEditor(services);
    await click(/Done/);
    await screen.findByText(/could not be saved/);

    await click('Try again');

    // The editor closed, which is the palette saying the marks are in the report.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Done/ })).toBeNull());
    expect(screen.queryByText(/could not be saved/)).toBeNull();
  });

  it('says nothing when the write works', async () => {
    const services = fakeServices({ readImages: vi.fn(async () => [JPEG]) });
    await toEditor(services);

    await click(/Done/);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Done/ })).toBeNull());
    expect(screen.queryByText(/could not be saved/)).toBeNull();
  });
});
