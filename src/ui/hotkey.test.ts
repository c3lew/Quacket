import { describe, expect, it, vi } from 'vitest';

import { toggleOnHotkey } from './hotkey.ts';

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
