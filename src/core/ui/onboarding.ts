/**
 * First-run onboarding, as a pure derivation.
 *
 * There is NO stored wizard progress. The cards fall out of RE-DETECTED machine
 * state on every summon, which is what makes quitting mid-setup lose nothing:
 * a card exists because the machine is still missing something, not because a
 * counter says step 2 of 4. Fix the thing, re-detect, the card is gone.
 *
 * Keep this a pure function.
 */

import type { ProviderCapabilities, ProviderId, Settings } from '../types.ts';

export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex'];

/** What a card asks the user to fix, and the command that fixes it. */
export type Problem = 'not_installed' | 'not_authenticated';

/** Copy-and-run commands. Verified against the CLIs installed on 2026-07-16. */
const GH_COMMAND: Record<Problem, string> = {
  not_installed: 'winget install GitHub.cli',
  not_authenticated: 'gh auth login',
};

const PROVIDER_COMMAND: Record<ProviderId, Record<Problem, string>> = {
  claude: {
    not_installed: 'irm https://claude.ai/install.ps1 | iex',
    not_authenticated: 'claude',
  },
  codex: {
    not_installed: 'npm install -g @openai/codex',
    not_authenticated: 'codex login',
  },
};

// ── Detected state ──────────────────────────────────────────────────────────

export interface GhState {
  installed: boolean;
  authenticated: boolean;
}

/**
 * The machine facts, and nothing else: what is installed, signed in, and
 * enumerable. Not one field here is something a control in the palette can
 * change — the only way any of it moves is the user fixing their machine and a
 * re-detect noticing.
 *
 * That is the whole reason it is split out. See `DetectedState`.
 */
export interface MachineState {
  gh: GhState;
  /** One entry per INSTALLED AI CLI. Absent from this array = not installed. */
  providers: ProviderCapabilities[];
}

/**
 * Everything the cards derive from — all of it re-read at summon time.
 *
 * `settings` and `autostart` are the LIVE values, never a snapshot taken when
 * detection ran. The cards ask "is setup done, and with what?", and the controls
 * ON those cards are what answer it: the provider card writes `settings.model`,
 * the hotkey card writes `autostart`. Derive from a copy frozen at detect time
 * and the derivation answers with what was true BEFORE the user clicked — which
 * is precisely how a first run could click "Use Claude Code", have the model
 * saved, and still never leave onboarding.
 *
 * So this type is assembled at the point of use from the one `MachineState` the
 * host holds plus the one live `Settings` it holds — there is no second copy for
 * the two to drift apart. `MachineState` exists to make that stale copy
 * unrepresentable rather than merely discouraged.
 *
 * `autostart` is not a setting: the HKCU Run key is its single source of truth,
 * so it is re-read with the rest of the machine state instead of being stored.
 */
export interface DetectedState extends MachineState {
  settings: Settings;
  autostart: boolean;
}

export interface ProviderFix {
  provider: ProviderId;
  problem: Problem;
  command: string;
}

export type OnboardingCard =
  | { kind: 'github'; problem: Problem; command: string }
  | { kind: 'ai-cli'; fixes: ProviderFix[] }
  | { kind: 'provider'; choices: ProviderCapabilities[] }
  | { kind: 'hotkey'; hotkey: string; autostart: boolean };

// ── Derivations ─────────────────────────────────────────────────────────────

/**
 * Installed is not enough: unauthenticated (`account: null`) can't refine, and
 * a provider whose models never enumerated has nothing real to offer — the
 * fallback chain already had its turn, so we hide what stayed unverified.
 */
export const isProviderReady = (p: ProviderCapabilities): boolean =>
  p.account !== null && p.models.length > 0;

export const readyProviders = (d: DetectedState): ProviderCapabilities[] =>
  d.providers.filter(isProviderReady);

export const isGhReady = (d: DetectedState): boolean => d.gh.installed && d.gh.authenticated;

/**
 * Everything needed to actually FILE is present: a working `gh`, a provider that
 * can refine, and a model to refine with.
 *
 * Deliberately not what gates the cards — that is `isFirstRun`. This predicate
 * says whether the machine is whole right now; it says nothing about whether the
 * user has been here before, and conflating the two is what let a lapsed `gh`
 * auth on a months-old install present itself as a first run.
 */
export const isSetupComplete = (d: DetectedState): boolean =>
  isGhReady(d) && readyProviders(d).length > 0 && d.settings.model !== null;

/**
 * Whether this machine has ever finished setup — the concept the cards were
 * missing, and the reason a broken prerequisite used to take the whole window.
 *
 * `settings.model` is the signal because it is the one thing on disk that ONLY a
 * human could have put there: enumeration offers models, a person picks one. It
 * is a real setting, re-read from disk on every summon, so it carries "setup
 * happened once" without a single byte of wizard progress being stored — quitting
 * mid-setup still loses nothing, because nothing about the cards is remembered.
 *
 * Why it has to exist: onboarding and a broken prerequisite look identical to a
 * pure derivation over machine state. `gh auth` expiring on an install someone
 * has used for months is not a first run, and answering it by replacing the
 * capture surface with first-run cards throws away the window they summoned —
 * and any silently-restored draft sitting in it — to re-teach them an app they
 * already know. Same facts, different user: the difference is whether they have
 * been here before.
 */
export const isFirstRun = (d: DetectedState): boolean => d.settings.model === null;

/**
 * What an ESTABLISHED install shows instead of cards: the same facts, demoted to
 * the persistent non-blocking slot the hotkey conflict already uses (#9).
 *
 * Non-blocking is the whole point. Neither a dead `gh` nor a vanished CLI stops
 * you CAPTURING — you can type, paste, annotate, and refine; only the last step
 * is blocked — so neither one gets to take the surface. The warning stays up
 * until re-detection says it is fixed, which is exactly as long as it is true.
 */
export type SetupWarning =
  | { kind: 'github'; problem: Problem; command: string }
  | { kind: 'ai-cli'; fixes: ProviderFix[] };

export function deriveSetupWarnings(d: DetectedState): SetupWarning[] {
  // On a first run these same problems are the cards. They must never be both,
  // or the user reads one message twice with two competing buttons.
  if (isFirstRun(d)) return [];

  const warnings: SetupWarning[] = [];

  if (!isGhReady(d)) {
    const problem: Problem = d.gh.installed ? 'not_authenticated' : 'not_installed';
    warnings.push({ kind: 'github', problem, command: GH_COMMAND[problem] });
  }
  if (readyProviders(d).length === 0) warnings.push({ kind: 'ai-cli', fixes: aiFixes(d) });

  return warnings;
}

const aiFixes = (d: DetectedState): ProviderFix[] =>
  PROVIDER_IDS.flatMap((provider) => {
    const found = d.providers.find((p) => p.provider === provider);
    const problem: Problem | null =
      found === undefined ? 'not_installed' : found.account === null ? 'not_authenticated' : null;
    return problem === null
      ? []
      : [{ provider, problem, command: PROVIDER_COMMAND[provider][problem] }];
  });

/**
 * GitHub -> AI CLI (only when none is ready) -> provider/model/effort -> hotkey.
 * Empty means the cards have collapsed into the real capture textarea.
 *
 * Empty on an ESTABLISHED install too, unconditionally. Onboarding is a
 * first-run surface: it exists to teach the palette to someone who has never
 * seen it, and there is nothing to teach someone who has. Whatever broke on a
 * machine that is already set up is a warning (`deriveSetupWarnings`), because a
 * problem that does not stop you capturing does not get to stop you capturing.
 *
 * Still pure, still derived entirely from re-detected machine state — `isFirstRun`
 * reads a setting the user made, not a step counter we kept.
 */
export function deriveOnboardingCards(d: DetectedState): OnboardingCard[] {
  if (!isFirstRun(d)) return [];

  const cards: OnboardingCard[] = [];

  if (!isGhReady(d)) {
    const problem: Problem = d.gh.installed ? 'not_authenticated' : 'not_installed';
    cards.push({ kind: 'github', problem, command: GH_COMMAND[problem] });
  }

  const ready = readyProviders(d);
  if (ready.length === 0) cards.push({ kind: 'ai-cli', fixes: aiFixes(d) });

  cards.push({ kind: 'provider', choices: ready });
  cards.push({ kind: 'hotkey', hotkey: d.settings.hotkey, autostart: d.autostart });

  return cards;
}
