/**
 * The palette shell: the chrome every view sits inside, plus the two controls
 * that live in it permanently — the repo pill and the model/effort pickers.
 */

import type { ReactNode } from 'react';

import type { ModelInfo, ProviderCapabilities, ProviderId, Repo, Settings } from '../../core/types.ts';
import { effortsFor, modelLabel, providerLabel, reconcileEffort } from './format.ts';
import { Icon, Wordmark } from './icons.tsx';
import type { View } from './keymap.ts';
import { Picker } from './Picker.tsx';

// ── Shell ───────────────────────────────────────────────────────────────────

export function Panel({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="panel" style={{ width }}>
      {children}
    </div>
  );
}

export interface HeaderProps {
  view: View;
  repo: Repo | null;
  onSwitchRepo: () => void;
  onOpenIssues: () => void;
  onOpenSettings: () => void;
  onHide: () => void;
  onBack: () => void;
}

/**
 * The repo pill is the only place the target is stated, so it is stated at rest
 * on every stage: nobody should have to remember where their issue is going.
 */
export function Header({
  view,
  repo,
  onSwitchRepo,
  onOpenIssues,
  onOpenSettings,
  onHide,
  onBack,
}: HeaderProps) {
  return (
    <header className="panel-head">
      <Wordmark />

      {view === 'capture' ? (
        <>
          <button className="repo-pill" onClick={onSwitchRepo}>
            <Icon name="repo" size={13} />
            <span className="repo-name">{repo?.nameWithOwner ?? 'Choose a repo'}</span>
            <Icon name="chevronDown" size={12} />
            <kbd>Ctrl+R</kbd>
          </button>

          <span className="spacer" />

          <button className="btn ghost" onClick={onOpenIssues}>
            <Icon name="list" size={14} />
            Issues
          </button>
          <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
            <Icon name="gear" />
          </button>
        </>
      ) : (
        <>
          <span className="view-title">{view === 'issues' ? 'Open issues' : 'Settings'}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onBack}>
            <Icon name="back" size={13} />
            Back
            <kbd>Esc</kbd>
          </button>
        </>
      )}

      <button className="icon-btn" onClick={onHide} aria-label="Hide to tray">
        <Icon name="close" />
      </button>
    </header>
  );
}

export const Body = ({ children }: { children: ReactNode }) => <div className="panel-body">{children}</div>;

export const Footer = ({ children }: { children: ReactNode }) => (
  <footer className="panel-foot">{children}</footer>
);

// ── Warning slot ────────────────────────────────────────────────────────────

export interface Warning {
  id: string;
  text: string;
  /** Rendered as a copyable command when present. */
  command?: string;
  actionLabel: string;
  onAction: () => void;
}

/**
 * One persistent, non-blocking slot shared by gh-auth breakage and a hotkey
 * conflict. Non-blocking is the point: neither one stops you filing an issue, so
 * neither one gets to be a modal.
 */
export function WarningSlot({ warnings, onCopy }: { warnings: Warning[]; onCopy: (text: string) => void }) {
  if (warnings.length === 0) return null;

  return (
    <div className="warnings">
      {warnings.map((warning) => (
        <div className="warning" key={warning.id}>
          <span className="warn-icon">
            <Icon name="warning" size={14} />
          </span>
          <div className="warn-main">
            <span>{warning.text}</span>
            {warning.command !== undefined && (
              <CommandLine command={warning.command} onCopy={onCopy} />
            )}
          </div>
          <button className="btn" onClick={warning.onAction}>
            {warning.actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * A command the user runs elsewhere. The Copy button is the affordance: reading
 * the command is optional, copying it is one click, and nothing has to be typed
 * correctly from memory.
 */
export function CommandLine({ command, onCopy }: { command: string; onCopy: (text: string) => void }) {
  return (
    <div className="cmd">
      <code>{command}</code>
      <button className="btn ghost cmd-copy" onClick={() => onCopy(command)}>
        <Icon name="copy" size={13} />
        Copy
      </button>
    </div>
  );
}

// ── Model / effort pickers ──────────────────────────────────────────────────

export interface PickersProps {
  settings: Settings;
  providers: ProviderCapabilities[];
  onChange: (settings: Settings) => void;
  disabled?: boolean;
}

/**
 * Fed entirely by live enumeration — never a hardcoded list. Effort is per
 * MODEL, not per provider, so the effort picker disappears for a model that
 * takes none rather than offering a flag the CLI would reject.
 *
 * These sit in the footer of every capture, which makes them the app's standing
 * answer to "what will refine my report?". They go through `Picker` for the same
 * reason the Settings rows and the first-run card do: a `<select>` whose value
 * matches no option shows `option[0]` and reads it back, so a stale or unset
 * choice would have this footer quietly naming a model the CLI is not being
 * given. `Picker.tsx` owns that rule; there is nowhere else to write one.
 */
export function Pickers({ settings, providers, onChange, disabled = false }: PickersProps) {
  const current = providers.find((p) => p.provider === settings.provider);
  const models: ModelInfo[] = current?.models ?? [];
  const efforts = effortsFor(models, settings.model);

  const pickProvider = (provider: ProviderId) => {
    const next = providers.find((p) => p.provider === provider);
    const model = next?.models[0]?.id ?? null;
    onChange({
      ...settings,
      provider,
      model,
      effort: reconcileEffort(effortsFor(next?.models ?? [], model), null),
    });
  };

  const pickModel = (model: string) =>
    onChange({ ...settings, model, effort: reconcileEffort(effortsFor(models, model), settings.effort) });

  return (
    <>
      {providers.length > 1 && (
        <Picker
          className="picker"
          label="AI"
          value={settings.provider}
          options={providers.map((p) => ({ value: p.provider, label: providerLabel(p.provider) }))}
          placeholder="Choose an assistant"
          disabled={disabled}
          onPick={(picked) => pickProvider(picked as ProviderId)}
        />
      )}

      <Picker
        className="picker"
        label="Model"
        value={settings.model}
        options={models.map((m) => ({ value: m.id, label: m.label }))}
        /* Nothing enumerated: there is no choice to offer, so the row names the
           stored id rather than pretending one is pickable. `Picker` disables an
           empty row on its own. */
        placeholder={models.length === 0 ? modelLabel(models, settings.model) : 'Choose a model'}
        disabled={disabled}
        onPick={pickModel}
      />

      {efforts.length > 0 && (
        <Picker
          className="picker"
          label="Thinking"
          value={settings.effort}
          options={efforts.map((effort) => ({ value: effort, label: effort }))}
          placeholder="Choose a thinking level"
          disabled={disabled}
          onPick={(effort) => onChange({ ...settings, effort })}
        />
      )}
    </>
  );
}
