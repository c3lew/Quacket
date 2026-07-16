import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type ProviderCapabilities, type Settings } from '../../core/types.ts';
import { settingsNoticeText } from './format.ts';
import { reconcileSettings } from './settings.ts';

const claude = (models: ProviderCapabilities['models']): ProviderCapabilities => ({
  provider: 'claude',
  cliVersion: '2.0.44',
  account: 'eva8isverygood@gmail.com',
  models,
});

const SONNET = { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', efforts: ['low', 'medium', 'high'] };
const OPUS = { id: 'claude-opus-4-1', label: 'Opus 4.1', efforts: ['medium', 'high'] };

const settings = (extra: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'claude',
  model: SONNET.id,
  effort: 'medium',
  ...extra,
});

describe('a stored model that still exists', () => {
  it('is left exactly alone', () => {
    const result = reconcileSettings(settings(), [claude([SONNET, OPUS])]);

    expect(result.settings).toEqual(settings());
    expect(result.notice).toBeNull();
  });
});

describe('a model the CLI stopped offering', () => {
  const vanished = () =>
    reconcileSettings(settings({ model: 'claude-sonnet-4-0', effort: 'high' }), [claude([SONNET, OPUS])]);

  it('falls back to the provider default instead of reaching the CLI', () => {
    // Unreconciled, this id sailed through every "has a model been picked?" check
    // and was handed to the CLI verbatim, which rejects it — blocking filing,
    // which is the exact outcome story 38 exists to prevent.
    expect(vanished().settings.model).toBe(SONNET.id);
  });

  it('clears the stored choice by replacing it, so the notice is one-time', () => {
    const once = vanished();
    expect(once.notice).toEqual({ kind: 'model-gone', missing: 'claude-sonnet-4-0', fallback: SONNET.id });

    // Boot again with what the first boot wrote back: nothing left to say.
    const twice = reconcileSettings(once.settings, [claude([SONNET, OPUS])]);
    expect(twice.notice).toBeNull();
  });

  it('re-picks an effort the new model actually takes', () => {
    const result = reconcileSettings(settings({ model: 'gone', effort: 'ultra' }), [claude([OPUS])]);

    expect(result.settings.model).toBe(OPUS.id);
    expect(OPUS.efforts).toContain(result.settings.effort);
  });

  it('drops the effort entirely when the fallback model takes none', () => {
    const bare = { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] };
    const result = reconcileSettings(settings({ model: 'gone' }), [claude([bare])]);

    expect(result.settings.model).toBe(bare.id);
    expect(result.settings.effort).toBeNull();
  });

  it('says what happened in plain language', () => {
    const result = vanished();
    const text = settingsNoticeText(result.notice!, [SONNET, OPUS]);

    expect(text).toContain('Sonnet 4.5');
    expect(text).not.toMatch(/enumerat|reconcil|fallback|null/i);
  });
});

describe('an effort level the model stopped offering', () => {
  it('falls back and says so, leaving the model alone', () => {
    const result = reconcileSettings(settings({ model: OPUS.id, effort: 'low' }), [claude([OPUS])]);

    expect(result.settings.model).toBe(OPUS.id);
    expect(OPUS.efforts).toContain(result.settings.effort);
    expect(result.notice).toEqual({ kind: 'effort-gone', missing: 'low', fallback: 'medium' });
  });

  it('stops setting one at all when the model dropped them all', () => {
    const bare = { id: OPUS.id, label: 'Opus 4.1', efforts: [] };
    const result = reconcileSettings(settings({ model: OPUS.id, effort: 'high' }), [claude([bare])]);

    expect(result.settings.effort).toBeNull();
    expect(settingsNoticeText(result.notice!, [bare])).toContain('high');
  });
});

describe('a PROVIDER the machine stopped offering', () => {
  const codex: ProviderCapabilities = {
    provider: 'codex',
    cliVersion: '0.144.4',
    account: 'a@b.c',
    models: [{ id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['medium', 'high'] }],
  };
  /** Installed, signed out: enumeration got nothing, so it can refine nothing. */
  const claudeLoggedOut: ProviderCapabilities = {
    provider: 'claude',
    cliVersion: '',
    account: null,
    models: [],
  };

  it('falls back to one that IS ready, instead of feeding the CLI a dead pair', () => {
    // Reconciliation only ever looked WITHIN the stored provider, so a provider
    // that vanished outright was invisible to it: claude+sonnet went over the
    // wire forever on a machine with no claude. Story 38, one level up.
    const result = reconcileSettings(settings(), [codex]);

    expect(result.settings).toMatchObject({ provider: 'codex', model: 'gpt-5.1-codex' });
    expect(result.notice).toEqual({ kind: 'provider-gone', missing: 'claude', fallback: 'codex' });
  });

  it('counts "signed out" as gone — an assistant that cannot refine is not a choice', () => {
    const result = reconcileSettings(settings(), [claudeLoggedOut, codex]);

    expect(result.settings.provider).toBe('codex');
  });

  it('takes an effort the new provider’s model actually offers', () => {
    const result = reconcileSettings(settings({ effort: 'low' }), [codex]);

    expect(codex.models[0]!.efforts).toContain(result.settings.effort);
  });

  it('is one-time: the write-back leaves nothing to say next boot', () => {
    const once = reconcileSettings(settings(), [codex]);
    expect(reconcileSettings(once.settings, [codex]).notice).toBeNull();
  });

  it('says what happened without naming a single internal', () => {
    const text = settingsNoticeText(reconcileSettings(settings(), [codex]).notice!, []);

    expect(text).toBe('Claude Code is not available any more, so Quacket switched to Codex.');
  });

  it('keeps a good choice when NOTHING is ready to fall back to', () => {
    // Every CLI signed out at once is not evidence the user's pick is bad; the
    // ai-cli warning covers it. Clearing here would lose the setting for good.
    const result = reconcileSettings(settings(), [claudeLoggedOut]);

    expect(result.settings).toEqual(settings());
    expect(result.notice).toBeNull();
  });

  it('does not cry "gone" over a default nobody ever picked', () => {
    // A fresh install whose default provider is not the CLI this machine has is
    // a first run, not a disappearance — the provider card's job. Telling the
    // user "Claude Code is not available any more" about a CLI they never chose
    // would be a lie with a plausible-looking sentence around it.
    const result = reconcileSettings(settings({ model: null, effort: null }), [codex]);

    expect(result.settings.provider).toBe('claude');
    expect(result.notice).toBeNull();
  });
});

describe('what reconciliation must NOT do', () => {
  it('does not clear a good choice just because enumeration came back empty', () => {
    // Enumeration failing is not evidence the model vanished. Throwing the user's
    // pick away because `claude` was busy would be worse than the bug this fixes.
    const result = reconcileSettings(settings(), [claude([])]);

    expect(result.settings).toEqual(settings());
    expect(result.notice).toBeNull();
  });

  it('does not clear a good choice when the provider is not installed at all', () => {
    const result = reconcileSettings(settings(), []);

    expect(result.settings).toEqual(settings());
    expect(result.notice).toBeNull();
  });

  it('treats "never picked" as the provider card’s job, not a disappearance', () => {
    const result = reconcileSettings(settings({ model: null, effort: null }), [claude([SONNET])]);

    expect(result.settings.model).toBeNull();
    expect(result.notice).toBeNull();
  });

  it('judges the stored choice against the stored PROVIDER, not whatever is first', () => {
    const codex: ProviderCapabilities = {
      provider: 'codex',
      cliVersion: '0.144.4',
      account: 'a@b.c',
      models: [{ id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['medium'] }],
    };
    const result = reconcileSettings(settings(), [codex, claude([SONNET])]);

    expect(result.settings.model).toBe(SONNET.id);
    expect(result.notice).toBeNull();
  });
});
