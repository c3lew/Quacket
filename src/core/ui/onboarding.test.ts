import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ProviderCapabilities, type Settings } from '../types.ts';
import {
  deriveOnboardingCards,
  deriveSetupWarnings,
  isFirstRun,
  isSetupComplete,
  type DetectedState,
  type OnboardingCard,
} from './onboarding.ts';

// ── Fixtures: real enumeration shapes from the 2026-07-16 research capture ───

const CLAUDE: ProviderCapabilities = {
  provider: 'claude',
  cliVersion: '2.1.210',
  account: 'eva8isverygood@gmail.com',
  models: [
    { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', label: 'Haiku 4.5', efforts: [] },
  ],
};

const CODEX: ProviderCapabilities = {
  provider: 'codex',
  cliVersion: '0.144.4',
  account: 'ChatGPT account',
  models: [
    {
      id: 'gpt-5.3-codex',
      label: 'gpt-5.3-codex',
      efforts: ['minimal', 'low', 'medium', 'high'],
    },
  ],
};

const settings = (extra: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  model: 'sonnet',
  effort: 'medium',
  ...extra,
});

const detected = (extra: Partial<DetectedState> = {}): DetectedState => ({
  gh: { installed: true, authenticated: true },
  providers: [CLAUDE, CODEX],
  settings: settings(),
  autostart: true,
  ...extra,
});

/**
 * A machine that has never finished setup. The cards are a FIRST-RUN surface, so
 * every card fixture has to actually be a first run — `settings.model` is what
 * says so, because only a human could have put a model there.
 */
const firstRun = (extra: Partial<DetectedState> = {}): DetectedState =>
  detected({ settings: settings({ model: null }), ...extra });

const kinds = (cards: OnboardingCard[]) => cards.map((c) => c.kind);

const card = <K extends OnboardingCard['kind']>(
  cards: OnboardingCard[],
  kind: K,
): Extract<OnboardingCard, { kind: K }> => {
  const found = cards.find((c) => c.kind === kind);
  if (!found) throw new Error(`no ${kind} card in [${kinds(cards).join(', ')}]`);
  return found as Extract<OnboardingCard, { kind: K }>;
};

// ── All good ────────────────────────────────────────────────────────────────

describe('everything already set up', () => {
  const state = detected();

  it('shows no cards — the palette is just the capture textarea', () => {
    expect(isSetupComplete(state)).toBe(true);
    expect(deriveOnboardingCards(state)).toEqual([]);
  });
});

// ── No gh ───────────────────────────────────────────────────────────────────

describe('gh not installed, on a first run', () => {
  const state = firstRun({ gh: { installed: false, authenticated: false } });
  const cards = deriveOnboardingCards(state);

  it('leads with the GitHub card, then provider and hotkey', () => {
    expect(kinds(cards)).toEqual(['github', 'provider', 'hotkey']);
  });

  it('asks the user to install gh, with the command to run', () => {
    expect(card(cards, 'github')).toEqual({
      kind: 'github',
      problem: 'not_installed',
      command: 'winget install GitHub.cli',
    });
  });

  it('skips the AI CLI card — a provider is already ready', () => {
    expect(kinds(cards)).not.toContain('ai-cli');
    expect(card(cards, 'provider').choices.map((c) => c.provider)).toEqual(['claude', 'codex']);
  });
});

// ── gh unauthed ─────────────────────────────────────────────────────────────

describe('gh installed but not logged in', () => {
  it('is not complete, however good everything else looks', () => {
    expect(isSetupComplete(detected({ gh: { installed: true, authenticated: false } }))).toBe(false);
  });

  it('asks a first-run user for the login rather than the install', () => {
    const cards = deriveOnboardingCards(firstRun({ gh: { installed: true, authenticated: false } }));

    expect(card(cards, 'github')).toEqual({
      kind: 'github',
      problem: 'not_authenticated',
      command: 'gh auth login',
    });
  });
});

// ── No AI CLI ───────────────────────────────────────────────────────────────

describe('no AI CLI ready', () => {
  it('offers an install command for each missing CLI', () => {
    const cards = deriveOnboardingCards(detected({ providers: [], settings: settings({ model: null }) }));

    expect(kinds(cards)).toEqual(['ai-cli', 'provider', 'hotkey']);
    expect(card(cards, 'ai-cli').fixes).toEqual([
      {
        provider: 'claude',
        problem: 'not_installed',
        command: 'irm https://claude.ai/install.ps1 | iex',
      },
      { provider: 'codex', problem: 'not_installed', command: 'npm install -g @openai/codex' },
    ]);
  });

  it('asks an installed-but-logged-out CLI for a login, not an install', () => {
    const cards = deriveOnboardingCards(
      detected({
        providers: [{ ...CLAUDE, account: null, models: [] }],
        settings: settings({ model: null }),
      }),
    );

    expect(card(cards, 'ai-cli').fixes).toEqual([
      { provider: 'claude', problem: 'not_authenticated', command: 'claude' },
      { provider: 'codex', problem: 'not_installed', command: 'npm install -g @openai/codex' },
    ]);
  });

  it('leaves the provider card with nothing to choose from yet', () => {
    const cards = deriveOnboardingCards(detected({ providers: [], settings: settings({ model: null }) }));
    expect(card(cards, 'provider').choices).toEqual([]);
  });

  it('hides a provider whose models never enumerated', () => {
    const cards = deriveOnboardingCards(
      detected({ providers: [{ ...CLAUDE, models: [] }], settings: settings({ model: null }) }),
    );

    expect(kinds(cards)).toContain('ai-cli');
    expect(card(cards, 'provider').choices).toEqual([]);
    // Logged in and installed — there is no command that would fix it.
    expect(card(cards, 'ai-cli').fixes.map((f) => f.provider)).toEqual(['codex']);
  });
});

// ── Fresh machine ───────────────────────────────────────────────────────────

describe('fresh machine — nothing installed', () => {
  const state = detected({
    gh: { installed: false, authenticated: false },
    providers: [],
    settings: settings({ model: null, effort: null }),
    autostart: false,
  });
  const cards = deriveOnboardingCards(state);

  it('walks GitHub -> AI CLI -> provider -> hotkey', () => {
    expect(kinds(cards)).toEqual(['github', 'ai-cli', 'provider', 'hotkey']);
  });

  it('offers the default hotkey and the live autostart state on the last card', () => {
    expect(card(cards, 'hotkey')).toEqual({
      kind: 'hotkey',
      hotkey: 'CmdOrCtrl+Shift+Q',
      autostart: false,
    });
  });
});

// ── Purity / no stored progress ─────────────────────────────────────────────

describe('cards derive purely from re-detected state', () => {
  it('drops a card the moment the machine state that caused it is fixed', () => {
    const broken = firstRun({ gh: { installed: true, authenticated: false } });
    expect(kinds(deriveOnboardingCards(broken))).toContain('github');

    // The user ran `gh auth login` and we re-detected. No progress was stored;
    // the card is gone because the reason for it is gone.
    const fixed = firstRun({ gh: { installed: true, authenticated: true } });
    expect(kinds(deriveOnboardingCards(fixed))).not.toContain('github');
  });

  it('brings the card back if the machine regresses mid-setup', () => {
    expect(kinds(deriveOnboardingCards(firstRun()))).not.toContain('ai-cli');
    expect(kinds(deriveOnboardingCards(firstRun({ providers: [] })))).toContain('ai-cli');
  });

  it('is a pure function of its input', () => {
    const state = detected({ gh: { installed: false, authenticated: false } });
    const snapshot = structuredClone(state);

    expect(deriveOnboardingCards(state)).toEqual(deriveOnboardingCards(state));
    expect(state).toEqual(snapshot);
  });

  it('keeps asking for a model choice until one is actually stored', () => {
    const unpicked = detected({ settings: settings({ model: null }) });
    expect(isSetupComplete(unpicked)).toBe(false);
    expect(kinds(deriveOnboardingCards(unpicked))).toEqual(['provider', 'hotkey']);

    expect(deriveOnboardingCards(detected({ settings: settings({ model: 'sonnet' }) }))).toEqual([]);
  });
});

// ── First run vs. an install that has been working for months ───────────────

describe('an established install is never taken over by onboarding', () => {
  const established = detected();

  it('knows it is not a first run because a model was actually picked', () => {
    expect(isFirstRun(established)).toBe(false);
    expect(isFirstRun(detected({ settings: settings({ model: null }) }))).toBe(true);
  });

  it('does not replace the capture surface when gh auth expires', () => {
    // The bug: same machine facts as a fresh install, so a lapsed `gh` login
    // presented itself as a first run — throwing away the window the user
    // summoned, and any silently-restored draft sitting in it, to re-teach them
    // an app they have used for months.
    const lapsed = detected({ gh: { installed: true, authenticated: false } });

    expect(deriveOnboardingCards(lapsed)).toEqual([]);
  });

  it('does not take over when gh is uninstalled outright', () => {
    expect(deriveOnboardingCards(detected({ gh: { installed: false, authenticated: false } }))).toEqual([]);
  });

  it('does not take over when the AI CLI disappears', () => {
    expect(deriveOnboardingCards(detected({ providers: [] }))).toEqual([]);
  });

  it('says the same thing ONCE, in the non-blocking slot', () => {
    // It used to be said twice at once — a first-run card over the whole window
    // AND a warning — each with its own competing "Check again" button.
    const lapsed = detected({ gh: { installed: true, authenticated: false } });

    expect(deriveOnboardingCards(lapsed)).toEqual([]);
    expect(deriveSetupWarnings(lapsed)).toEqual([
      { kind: 'github', problem: 'not_authenticated', command: 'gh auth login' },
    ]);
  });

  it('tells a missing gh apart from an expired login, with the right command', () => {
    expect(deriveSetupWarnings(detected({ gh: { installed: false, authenticated: false } }))).toEqual([
      { kind: 'github', problem: 'not_installed', command: 'winget install GitHub.cli' },
    ]);
  });

  it('warns when the AI CLI vanished, with the command that brings it back', () => {
    const warnings = deriveSetupWarnings(detected({ providers: [] }));

    expect(warnings.map((w) => w.kind)).toEqual(['ai-cli']);
    expect(warnings[0]).toMatchObject({
      fixes: [
        { provider: 'claude', problem: 'not_installed' },
        { provider: 'codex', problem: 'not_installed' },
      ],
    });
  });

  it('stays silent while everything works', () => {
    expect(deriveSetupWarnings(established)).toEqual([]);
  });
});

describe('a first run gets cards, never warnings', () => {
  it('never says the same problem in both places at once', () => {
    const fresh = firstRun({ gh: { installed: false, authenticated: false }, providers: [] });

    expect(kinds(deriveOnboardingCards(fresh))).toEqual(['github', 'ai-cli', 'provider', 'hotkey']);
    expect(deriveSetupWarnings(fresh)).toEqual([]);
  });

  it('is still a pure derivation with no stored progress', () => {
    const state = firstRun({ gh: { installed: false, authenticated: false } });
    const snapshot = structuredClone(state);

    expect(deriveSetupWarnings(state)).toEqual(deriveSetupWarnings(state));
    expect(state).toEqual(snapshot);
  });
});
