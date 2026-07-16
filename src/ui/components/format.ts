/**
 * Presentation helpers. Pure, so they are testable — the alternative is inline
 * ternaries in JSX that no test ever reaches.
 */

import { GitHubError } from '../../core/github/github.ts';
import { ProviderError, type ModelInfo, type ProviderId } from '../../core/types.ts';
import type { Failure } from '../../core/ui/reducer.ts';
import type { SettingsNotice } from './settings.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Short relative time, as the issue list shows it. Coarse on purpose: nobody
 * scanning open issues cares about the difference between 61 and 89 minutes.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const delta = now - then;
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w ago`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo ago`;
  return `${Math.floor(delta / YEAR)}y ago`;
}

/**
 * Any thrown thing to the card the UI already knows how to draw.
 *
 * `Failure` is the frozen persisted shape, so a live failure and a restored one
 * are the same value and the same card. An unrecognised throw becomes
 * `provider_error` — which offers [Retry] / [File as-is], the pair that is
 * always safe when we do not know what broke.
 */
export function toFailure(error: unknown): Failure {
  if (error instanceof ProviderError) return { kind: error.kind, message: error.message };
  if (error instanceof GitHubError) return { kind: error.kind, message: error.message };
  return {
    kind: 'provider_error',
    message: error instanceof Error ? error.message : 'Something went wrong.',
  };
}

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };

export const providerLabel = (provider: ProviderId): string => PROVIDER_LABELS[provider];

/** The picker shows the human label; the CLI only ever sees `ModelInfo.id`. */
export const modelLabel = (models: ModelInfo[], id: string | null): string =>
  models.find((m) => m.id === id)?.label ?? id ?? 'Default';

/**
 * The efforts the picked model actually takes. Per-model, never per-provider —
 * enumeration exists precisely because these diverge between models.
 */
export const effortsFor = (models: ModelInfo[], id: string | null): string[] =>
  models.find((m) => m.id === id)?.efforts ?? [];

/**
 * Keeps `effort` honest when the model changes: an effort the new model does not
 * take must not survive, or we hand the CLI a flag it rejects. Prefers the
 * current value, then a middle-ish default, then the first one offered.
 */
export function reconcileEffort(efforts: string[], current: string | null): string | null {
  if (efforts.length === 0) return null;
  if (current !== null && efforts.includes(current)) return current;
  return efforts.find((e) => e === 'medium') ?? (efforts[0] as string);
}

/**
 * The one-time notice when a stored choice stopped existing (#9, story 38).
 *
 * States what happened and what Quacket already did about it, in that order,
 * because by the time this is read the fallback has landed and nothing is being
 * asked of the user — the notice is news, not a task. Model IDs are shown through
 * `modelLabel`, so it names the thing the user picked from the picker rather than
 * the string the CLI happens to call it.
 */
export function settingsNoticeText(notice: SettingsNotice, models: ModelInfo[]): string {
  switch (notice.kind) {
    // The whole assistant went away — uninstalled, or its login lapsed. Named the
    // way the picker names it, and it does not say WHY: the user is not being
    // asked to do anything, and "signed out or uninstalled" is our problem, not
    // theirs. If they want it back, the assistant picker is where they go.
    case 'provider-gone':
      return (
        `${providerLabel(notice.missing)} is not available any more, ` +
        `so Quacket switched to ${providerLabel(notice.fallback)}.`
      );

    case 'model-gone':
      // `missing` is gone from `models` by definition, so this falls through to
      // the stored id — the only name left for it, and better than "Default".
      return (
        `${modelLabel(models, notice.missing)} is not offered any more, ` +
        `so Quacket switched to ${modelLabel(models, notice.fallback)}.`
      );

    case 'effort-gone':
      return notice.fallback === null
        ? `The "${notice.missing}" thinking level is not offered any more, so Quacket stopped setting one.`
        : `The "${notice.missing}" thinking level is not offered any more, so Quacket switched to "${notice.fallback}".`;
  }
}
