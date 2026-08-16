// @vitest-environment jsdom
/**
 * The palette header's drag contract (#19).
 *
 * The window is undecorated, so the header doubles as the title bar: Tauri's
 * injected handler starts a window drag on mousedown over any element carrying
 * `data-tauri-drag-region` — and ONLY over that exact element, never its
 * children. That cuts both ways, and each cut is one test below:
 *
 *  - every blank surface of the header (the header itself, the flex spacer
 *    that owns the empty middle, the view title) must carry the attribute,
 *    or the visually-empty area silently refuses to drag;
 *  - no interactive control may carry it, or clicking that control starts a
 *    drag instead of doing its job.
 *
 * Plus the shell's other permanent surface, the warning slot, which now carries
 * rows that are not warnings at all (#29) — so what it must NOT do is make them
 * all look alike.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Header, WarningSlot, type HeaderProps } from './Palette.tsx';

afterEach(cleanup);

function show(view: HeaderProps['view'] = 'capture') {
  const handlers = {
    onSwitchRepo: vi.fn(),
    onOpenIssues: vi.fn(),
    onOpenSettings: vi.fn(),
    onHide: vi.fn(),
    onBack: vi.fn(),
  };
  render(
    <Header
      view={view}
      repo={{ nameWithOwner: 'c3lew/quacket', isPrivate: false }}
      {...handlers}
    />,
  );
  return handlers;
}

const DRAG = 'data-tauri-drag-region';

describe('the header is the undecorated window\'s drag handle', () => {
  // The spacer is flex:1 — it IS the empty middle the user will grab. Asserting
  // the count first keeps this from passing vacuously if the spacer is renamed.
  const expectSpacerDraggable = (header: HTMLElement) => {
    const spacers = header.querySelectorAll('.spacer');
    expect(spacers).toHaveLength(1);
    for (const spacer of spacers) expect(spacer).toHaveAttribute(DRAG);
  };

  it('marks its blank surfaces as drag regions on the capture view', () => {
    show('capture');
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute(DRAG);
    expectSpacerDraggable(header);
    // The wordmark is blank surface too. Its children are made pointer-inert in
    // styles.css so the span stays the mousedown target — jsdom cannot see that
    // rule, so it is verified in a real browser; the attribute is pinned here.
    expect(header.querySelector('.wordmark')).toHaveAttribute(DRAG);
  });

  it('marks the view title too, since a title bar label should drag', () => {
    show('settings');
    expect(screen.getByText('Settings')).toHaveAttribute(DRAG);
    expectSpacerDraggable(screen.getByRole('banner'));
  });

  it('keeps every control OUT of the drag region so clicks stay clicks', () => {
    show('capture');
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute(DRAG);
    }
  });

  it('still routes clicks: the drag attribute costs no affordance', () => {
    const handlers = show('capture');
    fireEvent.click(screen.getByText('c3lew/quacket'));
    fireEvent.click(screen.getByText('Issues'));
    fireEvent.click(screen.getByLabelText('Settings'));
    fireEvent.click(screen.getByLabelText('Hide to tray'));
    expect(handlers.onSwitchRepo).toHaveBeenCalledOnce();
    expect(handlers.onOpenIssues).toHaveBeenCalledOnce();
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
    expect(handlers.onHide).toHaveBeenCalledOnce();
  });

  it('still routes Back on the non-capture views', () => {
    const handlers = show('issues');
    fireEvent.click(screen.getByText('Back'));
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });
});

describe('the one persistent, non-blocking slot', () => {
  it('carries a row that has nothing to offer yet without inventing a button', () => {
    render(
      <WarningSlot
        warnings={[{ id: 'a', text: 'Still checking your report from last time…', tone: 'busy' }]}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getByText(/Still checking/)).toBeVisible();
    // Not a disabled button, not a dead "Check again" — no button at all. A
    // control that cannot work is a lie the user tries to click.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not dress news that is not a problem as one', () => {
    const { container } = render(
      <WarningSlot
        warnings={[
          { id: 'good', text: 'Your report from last time was filed as issue #42.', tone: 'good' },
          {
            id: 'bad',
            text: 'Your GitHub sign-in has expired.',
            action: { label: 'Check again', onAction: vi.fn() },
          },
        ]}
        onCopy={vi.fn()}
      />,
    );

    // Same slot, same shape — a different tone, so they never read as one thing.
    expect(container.querySelector('.warning.good')).not.toBeNull();
    expect(container.querySelector('.warning.warn')).not.toBeNull();
  });
});
