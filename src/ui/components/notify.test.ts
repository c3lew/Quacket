import { describe, expect, it, vi } from 'vitest';

import { createNotifier, type NotifyDeps } from './notify.ts';

const deps = (extra: Partial<NotifyDeps> = {}) => {
  const handlers: Array<() => void> = [];
  const spies = {
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => 'granted' as const),
    send: vi.fn(),
    onAction: vi.fn(async (handler: () => void) => {
      handlers.push(handler);
      return undefined;
    }),
    summon: vi.fn(async () => {}),
    ...extra,
  };
  /** What the OS does when the user clicks the notification. */
  const click = () => handlers.forEach((h) => h());
  return { spies, handlers, click };
};

describe('the failure notification', () => {
  it('says what broke, under the app’s name', async () => {
    const { spies } = deps();
    await createNotifier(spies).notify('Could not upload screenshot-1.png');

    expect(spies.send).toHaveBeenCalledWith({
      title: 'Quacket',
      body: 'Could not upload screenshot-1.png',
    });
  });

  it('re-summons the palette when the user clicks it', async () => {
    // Without this the notification is a dead end: it tells you something broke
    // while the window is in the tray, and then does not open the window.
    const { spies, click } = deps();
    await createNotifier(spies).notify('Could not create the issue.');

    expect(spies.summon).not.toHaveBeenCalled();
    click();
    expect(spies.summon).toHaveBeenCalledTimes(1);
  });

  it('is listening before the notification the user could click instantly', async () => {
    const order: string[] = [];
    const { spies } = deps({
      onAction: vi.fn(async () => void order.push('listen')),
      send: vi.fn(() => void order.push('send')),
    });
    await createNotifier(spies).notify('boom');

    expect(order).toEqual(['listen', 'send']);
  });

  it('summons ONCE per click however many times a submit has failed', async () => {
    // `onAction` is a plugin-wide listener, not a property of one notification.
    // Registering per notify stacks one listener per failure — and the user who
    // sees this most is the one whose submits keep failing.
    const { spies, handlers, click } = deps();
    const notifier = createNotifier(spies);

    await notifier.notify('first');
    await notifier.notify('second');
    await notifier.notify('third');

    expect(handlers).toHaveLength(1);
    expect(spies.onAction).toHaveBeenCalledTimes(1);

    click();
    expect(spies.summon).toHaveBeenCalledTimes(1);
  });

  it('asks for permission only when there is bad news to deliver', async () => {
    const { spies } = deps({ isPermissionGranted: vi.fn(async () => false) });
    createNotifier(spies);

    expect(spies.requestPermission).not.toHaveBeenCalled();

    await createNotifier(spies).notify('boom');
    expect(spies.requestPermission).toHaveBeenCalledTimes(1);
    expect(spies.send).toHaveBeenCalled();
  });

  it('stays quiet — and registers nothing — when permission is refused', async () => {
    const { spies, handlers } = deps({
      isPermissionGranted: vi.fn(async () => false),
      requestPermission: vi.fn(async () => 'denied' as const),
    });
    await createNotifier(spies).notify('boom');

    expect(spies.send).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });

  it('does not re-ask once permission is already granted', async () => {
    const { spies } = deps();
    await createNotifier(spies).notify('boom');

    expect(spies.requestPermission).not.toHaveBeenCalled();
  });
});
