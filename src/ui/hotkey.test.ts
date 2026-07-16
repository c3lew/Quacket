import { describe, expect, it, vi } from 'vitest';

import { frontendOwnsHotkey, liveHotkeyConflict, toggleOnHotkey } from './hotkey.ts';

function deps(visible: boolean) {
  return {
    isVisible: vi.fn(async () => visible),
    hide: vi.fn(async () => {}),
    summon: vi.fn(async () => {}),
  };
}

describe('toggleOnHotkey', () => {
  it('hides a visible window', async () => {
    const d = deps(true);
    await toggleOnHotkey(d);
    expect(d.hide).toHaveBeenCalledOnce();
    expect(d.summon).not.toHaveBeenCalled();
  });

  it('summons a hidden window', async () => {
    const d = deps(false);
    await toggleOnHotkey(d);
    expect(d.summon).toHaveBeenCalledOnce();
    expect(d.hide).not.toHaveBeenCalled();
  });
});

const DEFAULT = 'CmdOrCtrl+Shift+Q';
const TAKEN = { hotkey: DEFAULT, reason: 'taken' };

function conflictDeps(stored: string, native: typeof TAKEN | null, rebindReason: string | null) {
  return {
    stored,
    defaultHotkey: DEFAULT,
    nativeConflict: vi.fn(async () => native),
    rebind: vi.fn(async () => rebindReason),
  };
}

describe('liveHotkeyConflict', () => {
  it('on the default hotkey, reports the native conflict and never rebinds', async () => {
    const d = conflictDeps(DEFAULT, TAKEN, null);
    expect(await liveHotkeyConflict(d)).toEqual(TAKEN);
    expect(d.rebind).not.toHaveBeenCalled();
  });

  it('on the default hotkey with no native conflict, reports nothing', async () => {
    expect(await liveHotkeyConflict(conflictDeps(DEFAULT, null, null))).toBeNull();
  });

  it('on a custom hotkey, a successful rebind silences the native conflict', async () => {
    const d = conflictDeps('Ctrl+Alt+P', TAKEN, null);
    expect(await liveHotkeyConflict(d)).toBeNull();
    expect(d.rebind).toHaveBeenCalledWith('Ctrl+Alt+P');
    expect(d.nativeConflict).not.toHaveBeenCalled();
  });

  it('on a custom hotkey, a failed rebind is reported about THAT hotkey', async () => {
    const d = conflictDeps('Ctrl+Alt+P', null, 'grabbed by someone');
    expect(await liveHotkeyConflict(d)).toEqual({ hotkey: 'Ctrl+Alt+P', reason: 'grabbed by someone' });
  });
});

describe('frontendOwnsHotkey', () => {
  it('cedes the default to Rust and owns everything else', () => {
    expect(frontendOwnsHotkey(DEFAULT, DEFAULT)).toBe(false);
    expect(frontendOwnsHotkey('Ctrl+Alt+P', DEFAULT)).toBe(true);
  });
});
