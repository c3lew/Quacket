/**
 * What the global hotkey does, as a pure function: show when hidden, hide when
 * visible. Matches tray left-click (`toggle_capture` in src-tauri) — the two
 * summoning gestures must agree. Visible-but-unfocused hides on purpose; a
 * focus-first special case was ruled out in issue #20's brief.
 */
export async function toggleOnHotkey(deps: {
  isVisible(): Promise<boolean>;
  hide(): Promise<void>;
  summon(): Promise<void>;
}): Promise<void> {
  if (await deps.isVisible()) await deps.hide();
  else await deps.summon();
}
