/**
 * First-run setup, as inline cards in the capture window itself — no separate
 * surface, no wizard, no stored progress. Every card is derived from re-detected
 * machine state by `deriveOnboardingCards`, so fixing a thing and re-checking
 * makes its card disappear. Quitting halfway loses nothing because nothing was
 * being remembered.
 *
 * All applicable cards render at once rather than one at a time. `isSetupComplete`
 * gates the whole set, so picking a model collapses ALL of them together — in a
 * one-at-a-time wizard the hotkey card would vanish before it was ever shown.
 */

import type { ProviderCapabilities, Settings } from '../../core/types.ts';
import type { OnboardingCard, Problem, ProviderFix } from '../../core/ui/onboarding.ts';
import { effortsFor, hotkeyKeys, providerLabel, reconcileEffort } from './format.ts';
import { Icon, Spinner } from './icons.tsx';
import { CommandLine } from './Palette.tsx';
import { Picker } from './Picker.tsx';

const GH_TITLE: Record<Problem, string> = {
  not_installed: 'GitHub CLI is not installed',
  not_authenticated: 'GitHub CLI is not signed in',
};

const FIX_TITLE: Record<Problem, string> = {
  not_installed: 'is not installed',
  not_authenticated: 'is not signed in',
};

export interface OnboardingProps {
  cards: OnboardingCard[];
  settings: Settings;
  checking: boolean;
  onRecheck: () => void;
  onCopy: (text: string) => void;
  onSettings: (settings: Settings) => void;
  onAutostart: (on: boolean) => void;
}

/** Re-detect. The only "progress" that exists: look at the machine again. */
function RecheckButton({ checking, onRecheck }: { checking: boolean; onRecheck: () => void }) {
  return (
    <button className="btn" onClick={onRecheck} disabled={checking}>
      {checking ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
      Check again
    </button>
  );
}

function GithubCard({ card, ...rest }: { card: Extract<OnboardingCard, { kind: 'github' }> } & Omit<OnboardingProps, 'cards' | 'settings' | 'onSettings' | 'onAutostart'>) {
  return (
    <section className="card">
      <h3>
        <Icon name="github" size={16} />
        {GH_TITLE[card.problem]}
      </h3>
      <p className="lead">Quacket files issues through the GitHub login you already have. No tokens to paste.</p>
      <CommandLine command={card.command} onCopy={rest.onCopy} />
      <div className="card-actions">
        <RecheckButton checking={rest.checking} onRecheck={rest.onRecheck} />
      </div>
    </section>
  );
}

function AiCliCard({
  fixes,
  checking,
  onRecheck,
  onCopy,
}: {
  fixes: ProviderFix[];
  checking: boolean;
  onRecheck: () => void;
  onCopy: (text: string) => void;
}) {
  return (
    <section className="card">
      <h3>
        <Icon name="zap" size={15} />
        No AI assistant is ready yet
      </h3>
      <p className="lead">
        Quacket rewrites your notes with Claude Code or Codex — whichever you already use. One is enough.
      </p>
      {fixes.map((fix) => (
        <div className="fix" key={fix.provider}>
          <h5>
            <Icon name="warning" size={13} />
            {providerLabel(fix.provider)} {FIX_TITLE[fix.problem]}
          </h5>
          <CommandLine command={fix.command} onCopy={onCopy} />
        </div>
      ))}
      <div className="card-actions">
        <RecheckButton checking={checking} onRecheck={onRecheck} />
      </div>
    </section>
  );
}

/**
 * The card that ends setup: `settings.model` is the completion signal, so
 * choosing one here is what collapses the cards into the real textarea. The
 * button says so — it is a deliberate act, not an incidental click.
 *
 * `settings.model` is therefore ALWAYS null while this card is on screen — that
 * is what `isFirstRun` means and why the card exists — so its rows are the two
 * places in the app most likely to be asked to show a choice nobody has made.
 * They go through `Picker`, which is the only thing that writes a `<select>` and
 * the only place the "value that matches no option" rule is decided. This card
 * previously wrote its own, and reproduced the exact lie the Settings screen had
 * already been fixed for twice: it read "Thinking effort: low" with nothing
 * stored, and re-picking "low" fired no change event.
 *
 * `use()` and the rows below read from ONE derivation, so what the card commits
 * is what the card shows. They used to disagree: `use()` reconciled effort
 * against `null` rather than the value on screen, so a deliberately-picked "max"
 * was thrown away by the card's own primary button and every first report filed
 * at "medium".
 */
function ProviderCard({
  choices,
  settings,
  onSettings,
}: {
  choices: ProviderCapabilities[];
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  if (choices.length === 0) {
    return (
      <section className="card muted">
        <h3>
          <Icon name="zap" size={15} />
          Choose your AI
        </h3>
        <p className="lead">Model choices appear here once an AI assistant above is ready.</p>
      </section>
    );
  }

  const selected = choices.find((c) => c.provider === settings.provider) ?? choices[0];
  if (selected === undefined) return null;

  const models = selected.models;
  /**
   * The model this card will use: the user's pick, else the assistant's default.
   * The effort rows are ABOUT this model, because efforts are per-model — so a
   * level offered here is one the CLI will actually take.
   */
  const model = settings.model ?? models[0]?.id ?? null;
  const efforts = effortsFor(models, model);

  /**
   * Commit what the card holds — not a fresh set of defaults derived behind the
   * user's back.
   *
   * `reconcileEffort(efforts, settings.effort)` KEEPS a level the user picked in
   * the row above, and falls back only when they picked none. Passing `null`
   * here instead is what silently overwrote a deliberate "max" with "medium" on
   * every first report: the choice was made in this card, on this card's own
   * control, and thrown away by this card's own button.
   */
  const use = () => {
    onSettings({
      ...settings,
      provider: selected.provider,
      model,
      effort: reconcileEffort(efforts, settings.effort),
    });
  };

  return (
    <section className="card">
      <h3>
        <Icon name="zap" size={15} />
        Choose your AI
      </h3>
      <p className="lead">This is what turns rough notes into a clean ticket. You can change it later.</p>

      <div className="prov-list">
        {choices.map((choice) => {
          const on = choice.provider === selected.provider;
          return (
            <button
              key={choice.provider}
              className={on ? 'prov on' : 'prov'}
              aria-pressed={on}
              onClick={() => onSettings({ ...settings, provider: choice.provider, model: null, effort: null })}
            >
              <span className="sim-radio" />
              <span className="prov-main">
                <b>{providerLabel(choice.provider)}</b>
                <span className="prov-sub">
                  <Icon name="check" size={11} />
                  {choice.cliVersion} · {choice.account} · {choice.models.length} models
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sel-row">
        <Picker
          className="field"
          label="Model"
          value={settings.model}
          options={models.map((m) => ({ value: m.id, label: m.label }))}
          placeholder="Choose a model"
          onPick={(picked) =>
            onSettings({
              ...settings,
              provider: selected.provider,
              model: picked,
              effort: reconcileEffort(effortsFor(models, picked), settings.effort),
            })
          }
        />

        {efforts.length > 0 && (
          <Picker
            className="field"
            label="Thinking effort"
            value={settings.effort}
            options={efforts.map((effort) => ({ value: effort, label: effort }))}
            placeholder="Choose a thinking level"
            onPick={(effort) => onSettings({ ...settings, effort })}
          />
        )}
      </div>

      <div className="card-actions">
        <span className="spacer" />
        <button className="btn primary" onClick={use}>
          Use {providerLabel(selected.provider)}
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </section>
  );
}

function HotkeyCard({
  card,
  onAutostart,
}: {
  card: Extract<OnboardingCard, { kind: 'hotkey' }>;
  onAutostart: (on: boolean) => void;
}) {
  return (
    <section className="card">
      <h3>
        <Icon name="key" size={15} />
        Your summon shortcut
      </h3>
      <p className="lead">Quacket lives in the tray. This shortcut opens it from anywhere.</p>
      <div className="hotkey-show">
        {hotkeyKeys(card.hotkey).map((key, i) => (
          <kbd key={i} className="big">
            {key}
          </kbd>
        ))}
      </div>
      <label className="checkrow">
        <input type="checkbox" checked={card.autostart} onChange={(e) => onAutostart(e.target.checked)} />
        Start Quacket when Windows starts
      </label>
    </section>
  );
}

export function Onboarding(props: OnboardingProps) {
  return (
    <div className="onboarding">
      {props.cards.map((card) => {
        switch (card.kind) {
          case 'github':
            return (
              <GithubCard
                key="github"
                card={card}
                checking={props.checking}
                onRecheck={props.onRecheck}
                onCopy={props.onCopy}
              />
            );
          case 'ai-cli':
            return (
              <AiCliCard
                key="ai-cli"
                fixes={card.fixes}
                checking={props.checking}
                onRecheck={props.onRecheck}
                onCopy={props.onCopy}
              />
            );
          case 'provider':
            return (
              <ProviderCard
                key="provider"
                choices={card.choices}
                settings={props.settings}
                onSettings={props.onSettings}
              />
            );
          case 'hotkey':
            return <HotkeyCard key="hotkey" card={card} onAutostart={props.onAutostart} />;
        }
      })}
    </div>
  );
}
