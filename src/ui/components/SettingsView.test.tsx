// @vitest-environment jsdom
/**
 * The settings screen tests.
 *
 * Written from the user's goal, not from the rows: what a person opening Settings
 * needs is (a) to be told the truth about what Quacket will use, and (b) to be
 * able to change it by using the screen. Every assertion below is one of those
 * two, read off the rendered DOM the way a user reads the closed select — which
 * is the only place the browser's silent `option[0]` substitution is visible.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ProviderCapabilities, type Settings } from '../../core/types.ts';
import { SettingsView } from './SettingsView.tsx';

afterEach(cleanup);

// ── Fixtures ────────────────────────────────────────────────────────────────

const CLAUDE: ProviderCapabilities = {
  provider: 'claude',
  cliVersion: '2.1.210',
  account: 'eva8isverygood@gmail.com',
  models: [
    { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] },
    { id: 'opus', label: 'Opus 4', efforts: ['medium', 'high'] },
  ],
};

const CODEX: ProviderCapabilities = {
  provider: 'codex',
  cliVersion: '0.144.4',
  account: 'eva8isverygood@gmail.com',
  models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['minimal', 'low'] }],
};

function show(settings: Partial<Settings>, providers: ProviderCapabilities[] = [CLAUDE, CODEX]) {
  const onSettings = vi.fn();
  render(
    <SettingsView
      settings={{ ...DEFAULT_SETTINGS, ...settings }}
      providers={providers}
      autostart={false}
      hotkeyError={null}
      onSettings={onSettings}
      onAutostart={vi.fn()}
      onRecording={vi.fn()}
      recording={false}
    />,
  );
  return { onSettings };
}

const row = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

// ── The screen never claims a choice that was not made ───────────────────────

describe('SettingsView', () => {
  /**
   * The blocker, from the user's side: first run, gear, and the screen announces a
   * model they never picked and the app does not hold. The display value is the
   * assertion because it is what the user reads — and it is exactly what the
   * browser fabricates when `value` matches no option.
   */
  it('a genuine first run: the Model row claims nothing, and can be used to make a choice true', () => {
    const { onSettings } = show({ provider: 'claude', model: null, effort: null });

    expect(row('Model')).not.toHaveDisplayValue('Sonnet 5');
    expect(row('Model')).toHaveDisplayValue('Choose a model');

    /*
     * The other half of the lie: the model the screen WOULD have claimed must
     * still be pickable. When the browser has already selected it, clicking it
     * fires no change event and the row cannot correct its own claim.
     */
    expect((screen.getByRole('option', { name: 'Sonnet 5' }) as HTMLOptionElement).selected).toBe(false);

    fireEvent.change(row('Model'), { target: { value: 'sonnet' } });
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet', effort: 'medium' }));
  });

  it('a first run: the Thinking effort row claims no level either, and picking one commits it', () => {
    const { onSettings } = show({ provider: 'claude', model: 'sonnet', effort: null });

    expect(row('Thinking effort')).not.toHaveDisplayValue('low');
    expect(row('Thinking effort')).toHaveDisplayValue('Choose a thinking level');
    expect((screen.getByRole('option', { name: 'low' }) as HTMLOptionElement).selected).toBe(false);

    fireEvent.change(row('Thinking effort'), { target: { value: 'high' } });
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
  });

  it('a model that a CLI update retired is not reported as still in force', () => {
    const { onSettings } = show({ provider: 'claude', model: 'sonnet-4-retired', effort: 'medium' });

    expect(row('Model')).toHaveDisplayValue('Choose a model');

    fireEvent.change(row('Model'), { target: { value: 'opus' } });
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
  });

  it('an assistant that is not ready is not reported as the one in force', () => {
    show({ provider: 'codex', model: 'gpt-5' }, [CLAUDE]);
    expect(row('Assistant')).toHaveDisplayValue('Choose an assistant');
    expect(row('Assistant')).not.toHaveDisplayValue('Claude Code');
  });

  it('no assistant ready: the row says so and offers nothing to pick', () => {
    show({ provider: 'claude', model: 'sonnet' }, []);
    expect(row('Assistant')).toHaveDisplayValue('No assistant is ready');
    expect(row('Assistant')).toBeDisabled();
    expect(row('Model')).toBeDisabled();
  });

  /**
   * The pattern guard, and the reason `PickerRow` exists. It is deliberately
   * blind to WHICH rows are on screen: the same bug arrived twice by being fixed
   * one row at a time, so this asserts the invariant over every select the screen
   * renders — a third row is covered on the day it is written.
   */
  it('no row reports a choice the user does not have — checked over every select on the screen', () => {
    // Stored: a real assistant, a real model, and an effort level the model dropped.
    show({ provider: 'claude', model: 'sonnet', effort: 'ultra' });

    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    // Assistant, Model, Thinking effort. A new picker row belongs in `stored` below.
    expect(selects).toHaveLength(3);

    const stored: Record<string, string | null> = {
      Assistant: 'claude',
      Model: 'sonnet',
      'Thinking effort': 'ultra',
    };

    for (const [label, value] of Object.entries(stored)) {
      // Either exactly what settings holds, or nothing at all. Never a third
      // thing the browser picked on the row's behalf.
      expect([value, '']).toContain(row(label).value);
    }
  });

  it('a placeholder cannot be picked as an answer', () => {
    show({ provider: 'claude', model: null });
    expect(screen.getByRole('option', { name: 'Choose a model' })).toBeDisabled();

    cleanup();
    show({ provider: 'codex', model: null }, [CLAUDE]);
    expect(screen.getByRole('option', { name: 'Choose an assistant' })).toBeDisabled();
  });

  // ── Cascading, which is what makes a pick usable next refine ───────────────

  it('switching assistant moves model and effort to that assistant’s default', () => {
    const { onSettings } = show({ provider: 'claude', model: 'sonnet', effort: 'high' });

    fireEvent.change(row('Assistant'), { target: { value: 'codex' } });

    expect(onSettings).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', model: 'gpt-5', effort: 'minimal' }),
    );
  });

  it('switching to a model that does not take the stored effort drops it', () => {
    const { onSettings } = show({ provider: 'claude', model: 'sonnet', effort: 'low' });

    // Opus 4 offers medium/high — 'low' must not survive, or the CLI gets a flag it rejects.
    fireEvent.change(row('Model'), { target: { value: 'opus' } });

    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus', effort: 'medium' }));
  });

  it('names the account behind the assistant in force', () => {
    show({ provider: 'claude', model: 'sonnet' });
    expect(screen.getByText(/eva8isverygood@gmail.com/)).toBeInTheDocument();
  });
});
