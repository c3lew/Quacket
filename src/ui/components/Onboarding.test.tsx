// @vitest-environment jsdom
/**
 * The first-run cards.
 *
 * Written from the brand-new user's goal, which is the whole of story 42: land in
 * a window you have never seen, and get to a capture box you can file from. Two
 * kinds of assertion serve that and nothing else does:
 *
 *   - what the card SHOWS, read off the closed select the way a user reads it —
 *     which is not `select.value`, and emphatically not the React state behind it.
 *     A value matching no option leaves both of those agreeing with each other
 *     while disagreeing with the app, so only the rendered option can see it.
 *   - what the click COMMITS, read off `saveSettings` and off the `settings` that
 *     reaches `refine` — the store and the CLI, the two places a choice is real.
 *
 * The reason for the second kind is the round-4 diagnosis of why this survived
 * three fixes: "App.test.tsx's first-run block asserts that the cards collapse and
 * that refine got model === 'sonnet'; it never reads the effort select and never
 * asserts what effort reached the CLI." So the flow tests below drive the REAL
 * App, pick a real level, and follow it all the way to the port.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  type Draft,
  type ProviderCapabilities,
  type RefinedDraft,
  type Repo,
  type Settings,
} from '../../core/types.ts';
import { deriveOnboardingCards, type DetectedState } from '../../core/ui/onboarding.ts';
import { App } from '../App.tsx';
import type { UiServices } from './services.ts';

afterEach(cleanup);

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const REPO: Repo = { nameWithOwner: 'c3lew/Quacket', isPrivate: false };

/**
 * `max` is deliberately NOT 'medium' and NOT `efforts[0]`, so a test that picks it
 * cannot be satisfied by either fallback `reconcileEffort` reaches for. 'low' is
 * first, which is what the browser silently displays when nothing is stored.
 */
const CLAUDE: ProviderCapabilities = {
  provider: 'claude',
  cliVersion: '2.1.210',
  account: 'eva8isverygood@gmail.com',
  models: [
    { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'max'] },
    { id: 'opus', label: 'Opus 4', efforts: ['medium', 'max'] },
  ],
};

const CODEX: ProviderCapabilities = {
  provider: 'codex',
  cliVersion: '0.144.4',
  account: 'eva8isverygood@gmail.com',
  models: [{ id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['minimal', 'high'] }],
};

const refined = (): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after explorer.exe restarts',
  sections: [{ heading: 'Actual', body: 'The icon is gone.' }],
  followUps: [],
  similarIssues: [],
});

/** A genuine first run: nothing picked, which is the ONLY thing that makes it one. */
const fresh = (extra: Partial<DetectedState> = {}): DetectedState => ({
  gh: { installed: true, authenticated: true },
  providers: [CLAUDE],
  settings: { ...DEFAULT_SETTINGS, model: null, effort: null },
  autostart: false,
  ...extra,
});

function fakeServices(state: DetectedState = fresh(), extra: Partial<UiServices> = {}) {
  const spies = {
    detect: vi.fn(async () => state),
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
    loadSettings: vi.fn(async () => state.settings),
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
    ...extra,
  };
  return spies as unknown as UiServices & typeof spies;
}

const CAPTURE_BOX = 'What broke? Type it however it comes out.';

async function boot(services: UiServices) {
  render(<App services={services} />);
  await waitFor(() => expect(screen.queryByText('Checking your setup…')).toBeNull());
  return services;
}

const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));

const picker = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

/**
 * What the control actually SHOWS — the rendered option, not `.value`. When
 * `value` matches no option the browser selects `option[0]` and reports it as the
 * value, so `.value` corroborates the lie instead of exposing it.
 */
const shows = (select: HTMLSelectElement): string =>
  select.options[select.selectedIndex]?.textContent ?? '';

/** The `settings` the CLI adapter was actually handed. */
const settingsAtRefine = (services: UiServices): Settings | undefined =>
  vi.mocked(services.refine).mock.calls[0]?.[0]?.settings;

/** The `settings` last written to disk. */
const settingsOnDisk = (services: UiServices): Settings | undefined =>
  vi.mocked(services.saveSettings).mock.calls.at(-1)?.[0];

// ── The card never claims a choice nobody made ──────────────────────────────

describe('the first-run card, before anything is picked', () => {
  /**
   * The defect, on the surface the spec guarantees a brand-new user lands on. By
   * execution against the code as it was: the card read "Thinking effort: low"
   * and `select.value` read back `"low"` while `settings.effort` was null — so
   * the card asserted a level nobody had chosen and the app did not hold, and
   * re-picking the "low" on screen fired no change event, because the browser
   * already had it selected. The one control telling the lie could not correct it.
   */
  it('claims no thinking level, and the level it WOULD have claimed stays pickable', async () => {
    await boot(fakeServices());

    expect(shows(picker('Thinking effort'))).not.toBe('low');
    expect(shows(picker('Thinking effort'))).toBe('Choose a thinking level');

    // The other half of the lie: `low` must not be pre-selected, or clicking it
    // fires nothing and the row cannot be corrected through itself.
    expect((screen.getByRole('option', { name: 'low' }) as HTMLOptionElement).selected).toBe(false);
  });

  it('claims no model either — `settings.model` is null by definition here', async () => {
    // `settings.model === null` IS what makes this a first run (`isFirstRun`), so
    // this card is the surface most certain to be asked to show a choice nobody
    // made. It must not answer "Sonnet 5".
    await boot(fakeServices());

    expect(shows(picker('Model'))).not.toBe('Sonnet 5');
    expect(shows(picker('Model'))).toBe('Choose a model');
    expect((screen.getByRole('option', { name: 'Sonnet 5' }) as HTMLOptionElement).selected).toBe(false);
  });

  it('offers no placeholder as an answer', async () => {
    await boot(fakeServices());

    expect(screen.getByRole('option', { name: 'Choose a model' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Choose a thinking level' })).toBeDisabled();
  });

  /**
   * Deliberately blind to WHICH rows are on screen. The same bug arrived four
   * times by being fixed one row, one file at a time, so this asserts the
   * invariant over every select the card renders — a third row is covered on the
   * day someone writes it.
   */
  it('no row on the card reports a choice the user does not have', async () => {
    await boot(fakeServices({ ...fresh(), providers: [CLAUDE, CODEX] }));

    const stored: Record<string, string | null> = { Model: null, 'Thinking effort': null };
    for (const [label, value] of Object.entries(stored)) {
      // Either exactly what settings holds, or nothing at all. Never a third
      // thing the browser picked on the row's behalf.
      expect([value ?? '', '']).toContain(picker(label).value);
    }
  });
});

// ── What the card's own button commits ──────────────────────────────────────

describe('a first run where the user picks a thinking level', () => {
  /**
   * The major, end to end, through the real App: pick a non-default level in the
   * card, press the card's own primary button, and follow that level to the two
   * places it becomes real.
   *
   * `use()` reconciled effort against `null` instead of the value on screen, so a
   * deliberate "max" was overwritten with "medium" — by the very button on the
   * very card the choice was made in. Every first report filed at the wrong
   * effort. Nothing caught it because the existing first-run test asserts the
   * cards collapse and that refine got `model === 'sonnet'`; it never reads the
   * effort select and never asserts what effort reached the CLI.
   *
   * 'max' is neither 'medium' (reconcileEffort's preferred default) nor
   * `efforts[0]` ('low', its other fallback, and what the broken select displayed)
   * — so this cannot pass by accident down any of those paths.
   */
  it('files that level to the CLI, not the default', async () => {
    const services = await boot(fakeServices());

    fireEvent.change(picker('Thinking effort'), { target: { value: 'max' } });
    // The card now genuinely holds what it shows, so the button has something to commit.
    expect(shows(picker('Thinking effort'))).toBe('max');

    await click(/Use Claude Code/);

    // 1. The disk. What the next launch will find.
    await waitFor(() => expect(settingsOnDisk(services)?.effort).toBe('max'));

    // 2. The CLI. What this report is actually refined at.
    fireEvent.change(await screen.findByPlaceholderText(CAPTURE_BOX), {
      target: { value: 'tray icon vanished after explorer restart' },
    });
    await click(/Refine/);

    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(settingsAtRefine(services)?.effort).toBe('max');
    expect(settingsAtRefine(services)?.model).toBe('sonnet');
  });

  it('keeps the level when the user picks a model too, and the model is the one they picked', async () => {
    // Opus 4 offers medium/max. A level the new model still takes must survive
    // the model pick — dropping it is the same discard, one control over.
    const services = await boot(fakeServices());

    fireEvent.change(picker('Thinking effort'), { target: { value: 'max' } });
    fireEvent.change(picker('Model'), { target: { value: 'opus' } });

    await waitFor(() => expect(settingsOnDisk(services)?.model).toBe('opus'));
    expect(settingsOnDisk(services)?.effort).toBe('max');

    fireEvent.change(await screen.findByPlaceholderText(CAPTURE_BOX), { target: { value: 'tray icon gone' } });
    await click(/Refine/);

    await waitFor(() => expect(services.refine).toHaveBeenCalled());
    expect(settingsAtRefine(services)?.model).toBe('opus');
    expect(settingsAtRefine(services)?.effort).toBe('max');
  });

  it('picking the model the browser used to pre-select still commits — it fires a real change', async () => {
    /*
     * `value={settings.model ?? models[0].id}` was not a lie, but it made the row
     * DEAD: the browser already had Sonnet 5 selected, so choosing Sonnet 5 — the
     * obvious first act on a card that says "Choose your AI" — fired no change
     * event and did nothing at all. Nothing stored, cards still up, no feedback.
     */
    const services = await boot(fakeServices());

    fireEvent.change(picker('Model'), { target: { value: 'sonnet' } });

    await waitFor(() => expect(settingsOnDisk(services)?.model).toBe('sonnet'));
    expect(await screen.findByPlaceholderText(CAPTURE_BOX)).toBeVisible();
  });

  /** The card commits a real level when the user does not care to choose one. */
  it('a user who ignores the level still gets a working one, not null', async () => {
    const services = await boot(fakeServices());

    await click(/Use Claude Code/);

    await waitFor(() => expect(services.saveSettings).toHaveBeenCalled());
    expect(CLAUDE.models[0]?.efforts).toContain(settingsOnDisk(services)?.effort);
  });

  it('commits the assistant whose card was on screen', async () => {
    // `settings.provider` defaults to 'claude' but this machine only has codex,
    // so the card shows codex. What it commits must be what it showed.
    const services = await boot(fakeServices(fresh({ providers: [CODEX] })));

    await click(/Use Codex/);

    await waitFor(() => expect(settingsOnDisk(services)?.provider).toBe('codex'));
    expect(settingsOnDisk(services)?.model).toBe('gpt-5.1-codex');
    expect(CODEX.models[0]?.efforts).toContain(settingsOnDisk(services)?.effort);
  });
});

// ── Story 42: a first run has to FINISH ─────────────────────────────────────

describe('a first run, start to finish', () => {
  it('reaches a capture box that really files a report', async () => {
    const services = await boot(fakeServices());
    expect(screen.queryByPlaceholderText(CAPTURE_BOX)).toBeNull();

    fireEvent.change(picker('Thinking effort'), { target: { value: 'max' } });
    await click(/Use Claude Code/);

    // "The final card collapses into the real capture textarea" — same window.
    const box = await screen.findByPlaceholderText(CAPTURE_BOX);
    expect(box).toBeVisible();

    fireEvent.change(box, { target: { value: 'tray icon vanished after explorer restart' } });
    await click(/Refine/);
    await screen.findByDisplayValue(refined().title);
    await click(/Submit issue/);

    await waitFor(() => expect(services.submit).toHaveBeenCalled());
    expect(await screen.findByText('Issue #7 filed')).toBeVisible();
  });

  it('shows all four cards at once, so the hotkey is seen before the model pick collapses them', async () => {
    // A one-at-a-time wizard would retire the hotkey card before it was ever
    // read: `settings.model` ends setup, and the hotkey card comes after it.
    await boot(fakeServices(fresh({ gh: { installed: false, authenticated: false }, providers: [] })));

    expect(screen.getByText('winget install GitHub.cli')).toBeVisible();
    expect(screen.getByText('irm https://claude.ai/install.ps1 | iex')).toBeVisible();
    expect(screen.getByText('Choose your AI')).toBeVisible();
    expect(screen.getByText('Your summon shortcut')).toBeVisible();
  });

  it('carries the level over into the footer that reports it from then on', async () => {
    // The footer pickers are the app's standing answer to "what will refine my
    // report?". It must agree with the card that set it — one source of truth.
    await boot(fakeServices());

    fireEvent.change(picker('Thinking effort'), { target: { value: 'max' } });
    await click(/Use Claude Code/);
    await screen.findByPlaceholderText(CAPTURE_BOX);

    expect(shows(picker('Thinking'))).toBe('max');
    expect(shows(picker('Model'))).toBe('Sonnet 5');
  });
});

// ── #11: no stored wizard progress ──────────────────────────────────────────

describe('the cards are derived, never remembered', () => {
  it('quitting mid-setup loses nothing, because nothing about the cards is stored', () => {
    // `deriveOnboardingCards` is a pure function of RE-DETECTED machine state.
    // Same machine, same cards — there is no counter that could say "step 3 of 4"
    // and no way for a half-finished setup to be resumed wrong, because it is not
    // resumed at all: it is re-derived.
    const machine = fresh({ gh: { installed: true, authenticated: false } });

    expect(deriveOnboardingCards(machine)).toEqual(deriveOnboardingCards(machine));
    expect(deriveOnboardingCards(machine).map((c) => c.kind)).toEqual(['github', 'provider', 'hotkey']);
  });

  it('a picked model is what ends setup — no card survives it', () => {
    expect(deriveOnboardingCards({ ...fresh(), settings: { ...DEFAULT_SETTINGS, model: 'sonnet' } })).toEqual(
      [],
    );
  });
});
