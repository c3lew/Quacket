/**
 * Reconciling the user's stored choice against what the CLIs actually offer now.
 *
 * Settings and enumeration have different semantics on purpose — one is what the
 * user picked, the other is what exists today — and #9 is explicit that they can
 * drift: "Disappeared model/effort -> auto-fall back to the provider default,
 * clear the stored choice, one-time non-blocking notice on next open. Pickers
 * only show currently-enumerated options."
 *
 * Nothing reconciled them. A stored id that a CLI update retired stayed non-null,
 * so it sailed through every "has the user picked a model" check, rendered the
 * picker blank (a `<select>` whose value matches no `<option>` shows nothing),
 * and was handed to the CLI verbatim — which rejects it. The result is the exact
 * failure story 38 exists to prevent: a CLI update quietly blocks filing, and the
 * only clue is an error at the end of a report you have already written.
 *
 * So it is done ONCE, at the boot/re-detect edge where enumeration lands, and the
 * fallback is written back — which is what makes the notice one-time without
 * anything having to remember it was shown.
 *
 * Pure, and returns the notice as DATA rather than a sentence: core owns the
 * decision, `format.ts` owns the words.
 */

import type { ProviderCapabilities, ProviderId, Settings } from '../../core/types.ts';
import { isProviderReady } from '../../core/ui/onboarding.ts';
import { effortsFor, reconcileEffort } from './format.ts';

/**
 * What vanished and what replaced it — ids, not prose. Rendered by
 * `settingsNoticeText`.
 */
export type SettingsNotice =
  | { kind: 'provider-gone'; missing: ProviderId; fallback: ProviderId }
  | { kind: 'model-gone'; missing: string; fallback: string }
  | { kind: 'effort-gone'; missing: string; fallback: string | null };

export interface Reconciled {
  settings: Settings;
  /** Null when the stored choice is still real — the overwhelmingly common case. */
  notice: SettingsNotice | null;
}

/**
 * The provider default is the first enumerated model. Same rule the provider
 * picker already uses when you switch providers, so a fallback lands you exactly
 * where picking that provider fresh would have.
 */
export function reconcileSettings(
  settings: Settings,
  providers: ProviderCapabilities[],
): Reconciled {
  // No stored choice yet: nothing has vanished, because nothing was ever picked.
  // That is the provider card's job (`settings.model === null` IS "first run").
  // Checked before the provider, or a fresh install whose default provider is not
  // the one they have would be told "Claude Code is not available any more" about
  // a CLI they never chose and never used.
  if (settings.model === null) return { settings, notice: null };

  const current = providers.find((p) => p.provider === settings.provider);

  /*
   * The PROVIDER itself can vanish, not just a model inside it — its CLI gets
   * uninstalled, or its login lapses — and reconciling only within the stored
   * provider let that sail through untouched: a dead provider+model went to the
   * CLI on every refine, with no notice and no warning. The exact outcome story
   * 38 exists to prevent, one level up from where it was being caught.
   */
  if (current === undefined || !isProviderReady(current)) {
    const fallback = providers.find(isProviderReady);

    // Nothing to fall back TO. Enumeration failing, every CLI logged out at once,
    // or an offline machine are not evidence the user's choice is bad — throwing
    // it away here would lose a good setting permanently and gain nothing. The
    // ai-cli warning already says no assistant is ready; this stays out of it.
    if (fallback === undefined) return { settings, notice: null };

    const model = fallback.models[0] as ProviderCapabilities['models'][number];
    return {
      settings: {
        ...settings,
        provider: fallback.provider,
        model: model.id,
        effort: reconcileEffort(effortsFor(fallback.models, model.id), null),
      },
      notice: { kind: 'provider-gone', missing: settings.provider, fallback: fallback.provider },
    };
  }

  // `isProviderReady` guarantees this is non-empty, so a miss below is a model
  // that really is gone rather than an enumeration that never landed.
  const models = current.models;

  if (!models.some((m) => m.id === settings.model)) {
    const fallback = models[0] as ProviderCapabilities['models'][number];
    return {
      settings: {
        ...settings,
        model: fallback.id,
        effort: reconcileEffort(effortsFor(models, fallback.id), null),
      },
      notice: { kind: 'model-gone', missing: settings.model, fallback: fallback.id },
    };
  }

  // The model survived but its effort levels may not have: they are per-model,
  // so a model that dropped a level leaves a flag the CLI would now reject.
  const efforts = effortsFor(models, settings.model);
  if (settings.effort !== null && !efforts.includes(settings.effort)) {
    const fallback = reconcileEffort(efforts, null);
    return {
      settings: { ...settings, effort: fallback },
      notice: { kind: 'effort-gone', missing: settings.effort, fallback },
    };
  }

  return { settings, notice: null };
}
