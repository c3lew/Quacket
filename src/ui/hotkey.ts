/**
 * The hotkey policy, as pure functions: what a press does, who handles which
 * hotkey, and what the startup conflict banner should say.
 */

/**
 * What the global hotkey does: show when hidden, hide when visible. Matches
 * tray left-click (`toggle_capture` in src-tauri) — the two summoning gestures
 * must agree. Visible-but-unfocused hides on purpose; a focus-first special
 * case was ruled out in issue #20's brief.
 */
export async function toggleOnHotkey(deps: {
  isVisible(): Promise<boolean>;
  hide(): Promise<void>;
  summon(): Promise<void>;
}): Promise<void> {
  if (await deps.isVisible()) await deps.hide();
  else await deps.summon();
}

/**
 * Who toggles for a given hotkey. Rust's global handler fires for EVERY
 * registered shortcut — even ones the frontend registers — and toggles exactly
 * the default (see lib.rs). The frontend callback must therefore toggle
 * exactly the rest, or one press fires two toggles that cancel out (#20).
 */
export const frontendOwnsHotkey = (hotkey: string, defaultHotkey: string): boolean =>
  hotkey !== defaultHotkey;

export interface HotkeyConflict {
  hotkey: string;
  reason: string;
}

/**
 * Why the configured hotkey is not live at startup — null when it is.
 *
 * The native conflict only speaks for the DEFAULT hotkey: Rust registers it
 * blind at boot, it cannot read the settings store. Once the user has rebound,
 * the default's fate is irrelevant — what matters is whether the rebind of the
 * stored hotkey took. Surfacing the native conflict unconditionally is bug #21
 * (a changed hotkey warns about the default forever); discarding the rebind
 * result is its silent twin (a dead custom hotkey warns about nothing).
 */
export async function liveHotkeyConflict(deps: {
  stored: string;
  defaultHotkey: string;
  nativeConflict(): Promise<HotkeyConflict | null>;
  rebind(hotkey: string): Promise<string | null>;
}): Promise<HotkeyConflict | null> {
  if (deps.stored === deps.defaultHotkey) return deps.nativeConflict();
  const reason = await deps.rebind(deps.stored);
  return reason === null ? null : { hotkey: deps.stored, reason };
}
