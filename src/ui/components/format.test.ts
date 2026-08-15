import { describe, expect, it } from 'vitest';

import { FilingError } from '../../core/filing/filing.ts';
import { GitHubError } from '../../core/github/github.ts';
import { ProviderError, type ModelInfo } from '../../core/types.ts';
import {
  effortsFor,
  hotkeyKeys,
  modelLabel,
  providerLabel,
  reconcileEffort,
  relativeTime,
  filingIdOf,
  toFailure,
} from './format.ts';

const NOW = Date.parse('2026-07-16T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('reads the way a human would say it', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d ago');
    expect(relativeTime(ago(14 * DAY), NOW)).toBe('2w ago');
    expect(relativeTime(ago(90 * DAY), NOW)).toBe('3mo ago');
    expect(relativeTime(ago(800 * DAY), NOW)).toBe('2y ago');
  });

  it('rounds down, so nothing is ever reported as older than it is', () => {
    expect(relativeTime(ago(HOUR + 59 * MIN), NOW)).toBe('1h ago');
  });

  it('does not read a clock skew as a date in the future', () => {
    expect(relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('just now');
  });

  it('renders an unparseable timestamp as nothing rather than "NaN ago"', () => {
    expect(relativeTime('not a date', NOW)).toBe('');
  });

  it('parses what gh actually returns', () => {
    expect(relativeTime('2026-07-14T12:00:00Z', NOW)).toBe('2d ago');
  });
});

describe('toFailure', () => {
  it('carries a provider error through with its kind, so the right buttons show', () => {
    expect(toFailure(new ProviderError('rate_limited', 'Slow down.'))).toEqual({
      kind: 'rate_limited',
      message: 'Slow down.',
    });
  });

  it('preserves every ErrorKind', () => {
    for (const kind of [
      'not_authenticated',
      'model_unavailable',
      'rate_limited',
      'timeout',
      'provider_error',
    ] as const) {
      expect(toFailure(new ProviderError(kind, 'x')).kind).toBe(kind);
    }
  });

  it('carries a GitHub error through, including the submit-only kinds', () => {
    expect(toFailure(new GitHubError('upload_failed', 'Upload died.'))).toEqual({
      kind: 'upload_failed',
      message: 'Upload died.',
    });
    expect(toFailure(new GitHubError('create_failed', 'Create died.')).kind).toBe('create_failed');
  });

  it('carries a Filing failure through as the card, and its id separately', () => {
    const error = new FilingError('upload_failed', 'Could not upload an image.', 'fil_1');

    // The card the user reads never mentions the Filing…
    expect(toFailure(error)).toEqual({ kind: 'upload_failed', message: 'Could not upload an image.' });
    // …but [Try again] needs it, or the retry would file a second report.
    expect(filingIdOf(error)).toBe('fil_1');
  });

  it('reports no Filing for a throw that never reached one', () => {
    expect(filingIdOf(new GitHubError('create_failed', 'x'))).toBeUndefined();
    expect(filingIdOf(new Error('boom'))).toBeUndefined();
  });

  it('degrades an unknown throw to a kind the failure matrix can answer', () => {
    expect(toFailure(new Error('boom'))).toEqual({ kind: 'provider_error', message: 'boom' });
  });

  it('survives a non-Error being thrown', () => {
    expect(toFailure('a string')).toEqual({
      kind: 'provider_error',
      message: 'Something went wrong.',
    });
    expect(toFailure(undefined).kind).toBe('provider_error');
  });
});

describe('model and effort labels', () => {
  const models: ModelInfo[] = [
    { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', label: 'Haiku 4.5 — fastest', efforts: [] },
  ];

  it('names providers in words a user recognises', () => {
    expect(providerLabel('claude')).toBe('Claude Code');
    expect(providerLabel('codex')).toBe('Codex');
  });

  it('shows the human label, never the raw id', () => {
    expect(modelLabel(models, 'haiku')).toBe('Haiku 4.5 — fastest');
  });

  it('falls back to the id when a saved model is gone from enumeration', () => {
    expect(modelLabel(models, 'opus-that-was-retired')).toBe('opus-that-was-retired');
  });

  it('says Default when no model is pinned', () => {
    expect(modelLabel(models, null)).toBe('Default');
  });

  it('reads efforts per model, which is the whole reason enumeration exists', () => {
    expect(effortsFor(models, 'sonnet')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor(models, 'haiku')).toEqual([]);
  });

  it('offers no efforts for an unknown model rather than guessing', () => {
    expect(effortsFor(models, 'nope')).toEqual([]);
  });
});

describe('hotkeyKeys', () => {
  it('splits the default accelerator into keycap labels, naming the modifier Ctrl', () => {
    expect(hotkeyKeys('CmdOrCtrl+Shift+Q')).toEqual(['Ctrl', 'Shift', 'Q']);
  });

  it('keeps a single-character key like = as its own cap', () => {
    expect(hotkeyKeys('CmdOrCtrl+=')).toEqual(['Ctrl', '=']);
  });

  it('reads a literal + key, which the recorder joins as "++"', () => {
    expect(hotkeyKeys('CmdOrCtrl+Shift++')).toEqual(['Ctrl', 'Shift', '+']);
  });

  it('passes named keys through untouched', () => {
    expect(hotkeyKeys('Alt+F5')).toEqual(['Alt', 'F5']);
  });
});

describe('reconcileEffort', () => {
  it('keeps the current effort when the new model still takes it', () => {
    expect(reconcileEffort(['low', 'medium', 'high'], 'high')).toBe('high');
  });

  it('drops an effort the new model does not take, instead of passing a bad flag', () => {
    expect(reconcileEffort(['minimal', 'low'], 'ultra')).toBe('minimal');
  });

  it('clears the effort entirely for a model that takes none', () => {
    expect(reconcileEffort([], 'medium')).toBeNull();
  });

  it('lands on medium when there is nothing to carry over', () => {
    expect(reconcileEffort(['low', 'medium', 'high'], null)).toBe('medium');
  });

  it('falls back to the first offered effort when there is no medium', () => {
    expect(reconcileEffort(['minimal', 'ultra'], null)).toBe('minimal');
  });
});
