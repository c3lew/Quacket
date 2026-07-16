/**
 * The OS notification, and the click that has to lead somewhere.
 *
 * Story 27's whole point is that bad news reaches the user when the window is
 * hidden. A notification nobody can act on delivers the news and then strands
 * them: the palette is in the tray, the failed draft is inside it, and the thing
 * that just told them something broke is the one thing on screen that doesn't
 * open it. The spec says so outright — "click re-summons".
 *
 * The dependencies are injected rather than imported, so the decisions here — the
 * permission gate, registering the click listener exactly once, what a click
 * means — are testable without Tauri, a window, or an OS. `main.tsx` supplies the
 * real plugin functions and holds no logic of its own.
 */

export interface NotifyDeps {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<'granted' | 'denied' | 'default'>;
  send(options: { title: string; body: string }): void;
  /** Fires when the user acts on ANY Quacket notification. Global, not per-send. */
  onAction(handler: () => void): Promise<unknown>;
  /** Show + focus the palette, i.e. exactly what the hotkey does. */
  summon(): Promise<void>;
}

export interface Notifier {
  notify(message: string): Promise<void>;
}

const TITLE = 'Quacket';

export function createNotifier(deps: NotifyDeps): Notifier {
  /*
   * `onAction` is a plugin-wide listener, not a property of one notification, so
   * it is registered once and only once. Re-registering per notify would stack a
   * listener per failure and summon the window N times on a single click — and
   * the user who sees this notification most is the one whose submits keep
   * failing, which is precisely when N is large.
   */
  let listening: Promise<unknown> | null = null;

  const listen = (): Promise<unknown> => {
    listening ??= deps.onAction(() => void deps.summon());
    return listening;
  };

  return {
    async notify(message) {
      // Asked for only when there is something to say: a permission prompt on a
      // machine that never fails a submit is a prompt for nothing.
      if (!(await deps.isPermissionGranted()) && (await deps.requestPermission()) !== 'granted') {
        return;
      }
      // Before the send, so the listener is live for a notification the user
      // could plausibly click the instant it appears.
      await listen();
      deps.send({ title: TITLE, body: message });
    },
  };
}
