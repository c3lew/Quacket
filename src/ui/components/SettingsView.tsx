/**
 * Settings: one page, two groups. Reached from the tray menu or the gear.
 *
 * There is no Save button — every control commits on change, so there is no
 * state where the screen disagrees with the app. Autostart is deliberately not
 * a `Settings` field: the Run key is its single source of truth and is read live.
 */

import type { ProviderCapabilities, Settings } from '../../core/types.ts';
import { isProviderReady } from '../../core/ui/onboarding.ts';
import { effortsFor, providerLabel, reconcileEffort } from './format.ts';
import { Icon } from './icons.tsx';
import { Picker } from './Picker.tsx';

/**
 * Every row here is a `Picker`, which is the only thing in the app that writes a
 * `<select>`. This screen is where the "a row claims a choice nobody made" defect
 * was found and fixed twice, one row at a time, before being made structurally
 * impossible — and then it reappeared on the first-run card, which was writing
 * its own raw select. `Picker.tsx` explains the failure and owns the rule; the
 * rows below only say what they are ABOUT.
 */

/** A row shape this screen styles: label left, control right. */
const ROW = { className: 'row', labelClassName: 'row-label' } as const;

export interface SettingsViewProps {
  settings: Settings;
  providers: ProviderCapabilities[];
  autostart: boolean;
  hotkeyError: string | null;
  onSettings: (settings: Settings) => void;
  onAutostart: (on: boolean) => void;
  onRecording: (recording: boolean) => void;
  recording: boolean;
}

export function SettingsView({
  settings,
  providers,
  autostart,
  hotkeyError,
  onSettings,
  onAutostart,
  onRecording,
  recording,
}: SettingsViewProps) {
  /*
   * Filtered HERE rather than trusted from the caller, for both halves of the
   * lie. #9: "pickers only show currently-enumerated options" — an assistant with
   * no enumerated models cannot be used, so offering it hands the user a choice
   * that breaks their next refine. And a component that tells the truth only when
   * its props happen to be consistent is a component that will lie again.
   */
  const choices = providers.filter(isProviderReady);
  const current = choices.find((p) => p.provider === settings.provider) ?? null;
  const models = current?.models ?? [];
  const efforts = effortsFor(models, settings.model);

  return (
    <div className="settings">
      <section className="group">
        <h4>AI</h4>

        <Picker
          {...ROW}
          label="Assistant"
          value={settings.provider}
          options={choices.map((p) => ({ value: p.provider, label: providerLabel(p.provider) }))}
          placeholder={choices.length === 0 ? 'No assistant is ready' : 'Choose an assistant'}
          onPick={(picked) => {
            const provider = choices.find((p) => p.provider === picked);
            if (provider === undefined) return;
            const model = provider.models[0]?.id ?? null;
            onSettings({
              ...settings,
              provider: provider.provider,
              model,
              effort: reconcileEffort(effortsFor(provider.models, model), null),
            });
          }}
        />

        <Picker
          {...ROW}
          label="Model"
          value={settings.model}
          options={models.map((m) => ({ value: m.id, label: m.label }))}
          placeholder={models.length === 0 ? 'No models to choose from' : 'Choose a model'}
          onPick={(model) =>
            onSettings({
              ...settings,
              model,
              effort: reconcileEffort(effortsFor(models, model), settings.effort),
            })
          }
        />

        {efforts.length > 0 && (
          <Picker
            {...ROW}
            label="Thinking effort"
            value={settings.effort}
            options={efforts.map((effort) => ({ value: effort, label: effort }))}
            placeholder="Choose a thinking level"
            onPick={(effort) => onSettings({ ...settings, effort })}
          />
        )}

        {/* `isProviderReady` already guarantees an account, so there is nothing
            left to check: if it is a choice, it is signed in. */}
        {current !== null && (
          <p className="row-note">
            <Icon name="check" size={12} />
            {providerLabel(current.provider)} {current.cliVersion} · {current.account}
          </p>
        )}
      </section>

      <section className="group">
        <h4>App</h4>

        <div className="row">
          <span className="row-label">Summon shortcut</span>
          <button
            className={recording ? 'hotkey-input recording' : 'hotkey-input'}
            onClick={() => onRecording(true)}
          >
            {recording ? 'Press your shortcut…' : settings.hotkey}
          </button>
        </div>
        {hotkeyError !== null && (
          <p className="row-error">
            <Icon name="warning" size={12} />
            {hotkeyError}
          </p>
        )}

        <label className="row">
          <span className="row-label">Start with Windows</span>
          <input type="checkbox" checked={autostart} onChange={(e) => onAutostart(e.target.checked)} />
        </label>
      </section>
    </div>
  );
}
