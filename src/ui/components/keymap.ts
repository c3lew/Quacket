/**
 * The keyboard model, as a pure function.
 *
 * Every shortcut here is an ACCELERATOR: each one has a visible, labelled
 * control somewhere in the palette, and this table only makes it faster. Nothing
 * is reachable by keyboard alone.
 *
 * Keeping it pure is what makes it testable — the alternative is a `keydown`
 * listener full of branches that no test ever reaches.
 */

import type { Stage } from '../../core/types.ts';
import type { Action } from '../../core/ui/reducer.ts';

/** Which palette view is on screen. Only 'capture' runs the stage machine. */
export type View = 'capture' | 'issues' | 'settings';

export interface KeyChord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Focus is in a text field, so bare-letter shortcuts must not fire. */
  inField: boolean;
}

export interface KeyContext {
  view: View;
  stage: Stage;
  /** The annotation editor has morphed into the body and owns its own keys. */
  editing: boolean;
  /** The repo switcher is modal and handles its own keyboard. */
  overlay: boolean;
  similarCount: number;
  canNew: boolean;
  /** There is a draft to lose, and it is at rest. Mirrors `canDiscard`. */
  canDiscard: boolean;
}

/**
 * Commands the reducer cannot express are separate variants rather than being
 * faked as actions: view switching and the modal overlay are not stages.
 */
export type Command =
  | { kind: 'dispatch'; action: Action }
  | { kind: 'open-repos' }
  | { kind: 'close-view' }
  /** By position — the keymap does not know issue numbers. */
  | { kind: 'similar'; index: number };

const dispatch = (action: Action): Command => ({ kind: 'dispatch', action });

export function keyToCommand(chord: KeyChord, ctx: KeyContext): Command | null {
  // A modal is modal: it owns every key while it is open.
  if (ctx.overlay) return null;

  /*
   * The annotation editor is the other nested surface, and it owns its whole
   * keyboard — Esc, Enter, Ctrl+Z and the P/O/C tool keys are all handled by
   * `keyIntent` in src/ui/annotate/model.ts, against undo state only it has.
   * Handling them here too would fire both paths for one keypress.
   */
  if (ctx.editing) return null;

  const key = chord.key.toLowerCase();

  // Esc backs out of a secondary view; everywhere else it hides to tray.
  if (chord.key === 'Escape') {
    return ctx.view === 'capture' ? dispatch({ type: 'esc' }) : { kind: 'close-view' };
  }

  if (!chord.ctrl || chord.alt) return null;
  if (ctx.view !== 'capture') return null;

  if (key === 'r') return { kind: 'open-repos' };
  if (key === 'n') return ctx.canNew ? dispatch({ type: 'new-report' }) : null;

  /*
   * Discard wears TWO modifiers on purpose. It is the only key in the app that
   * destroys work, and story 31's promise is that no accidental gesture can —
   * so the gesture has to be one nobody makes by accident. Ctrl+Backspace was
   * the obvious mnemonic and is disqualified for exactly that reason: it means
   * "delete the previous word" in every text field ever, and the capture box IS
   * a text field. Reaching for it to fix a typo would have deleted the report.
   */
  if (key === 'd' && chord.shift) return ctx.canDiscard ? dispatch({ type: 'discard' }) : null;

  if (chord.key === 'Enter') {
    if (ctx.stage === 'input') return dispatch({ type: 'refine' });
    if (ctx.stage === 'draft') return dispatch({ type: 'submit' });
    return null;
  }

  if (ctx.stage === 'draft' && /^[1-9]$/.test(chord.key)) {
    const index = Number(chord.key) - 1;
    return index < ctx.similarCount ? { kind: 'similar', index } : null;
  }

  return null;
}

/** Reads a DOM KeyboardEvent into a chord. The one place `document` leaks in. */
export const chordOf = (event: KeyboardEvent): KeyChord => {
  const target = event.target as HTMLElement | null;
  return {
    key: event.key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    inField:
      target !== null &&
      (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable),
  };
};
