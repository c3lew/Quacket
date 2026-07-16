/**
 * The palette shell: the chrome every view sits inside, plus the one control
 * that lives in it permanently — the repo pill. The AI / model / thinking
 * choice lives in Settings, its single surface: a footer copy was tried and
 * retired (#18) — five controls plus shortcut hints could not share one
 * 620px row without squeezing some control's value into an unreadable stub.
 */

import type { ReactNode } from 'react';

import type { Repo } from '../../core/types.ts';
import { Icon, Wordmark } from './icons.tsx';
import type { View } from './keymap.ts';

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
 *
 * The window is undecorated, so this header is also its title bar: every blank
 * surface carries `data-tauri-drag-region` (#19). Tauri's injected handler
 * starts the drag on mousedown over the EXACT element with the attribute —
 * children are exempt, which is what keeps the buttons clickable, and also why
 * the spacer (the flex:1 empty middle) and the view title need the attribute
 * themselves rather than inheriting the header's.
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
    <header className="panel-head" data-tauri-drag-region>
      <Wordmark />

      {view === 'capture' ? (
        <>
          <button className="repo-pill" onClick={onSwitchRepo}>
            <Icon name="repo" size={13} />
            <span className="repo-name">{repo?.nameWithOwner ?? 'Choose a repo'}</span>
            <Icon name="chevronDown" size={12} />
            <kbd>Ctrl+R</kbd>
          </button>

          <span className="spacer" data-tauri-drag-region />

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
          <span className="view-title" data-tauri-drag-region>
            {view === 'issues' ? 'Open issues' : 'Settings'}
          </span>
          <span className="spacer" data-tauri-drag-region />
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
