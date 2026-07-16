import { describe, expect, it } from 'vitest';

import { keyToCommand, type KeyChord, type KeyContext } from './keymap.ts';

const chord = (partial: Partial<KeyChord> & { key: string }): KeyChord => ({
  ctrl: false,
  shift: false,
  alt: false,
  inField: false,
  ...partial,
});

const ctx = (partial: Partial<KeyContext> = {}): KeyContext => ({
  view: 'capture',
  stage: 'input',
  editing: false,
  overlay: false,
  similarCount: 0,
  canNew: false,
  canDiscard: false,
  ...partial,
});

describe('modality', () => {
  it('gives the repo switcher every key while it is open', () => {
    for (const key of ['Escape', 'Enter', 'r', 'n', '1']) {
      expect(keyToCommand(chord({ key, ctrl: true }), ctx({ overlay: true }))).toBeNull();
    }
  });

  it('does not fire the palette shortcuts from a secondary view', () => {
    for (const view of ['issues', 'settings'] as const) {
      expect(keyToCommand(chord({ key: 'Enter', ctrl: true }), ctx({ view }))).toBeNull();
      expect(keyToCommand(chord({ key: 'r', ctrl: true }), ctx({ view }))).toBeNull();
    }
  });
});

describe('Esc', () => {
  it('hides to tray from every stage of the capture view', () => {
    for (const stage of ['input', 'refining', 'draft', 'submitting', 'done'] as const) {
      expect(keyToCommand(chord({ key: 'Escape' }), ctx({ stage }))).toEqual({
        kind: 'dispatch',
        action: { type: 'esc' },
      });
    }
  });

  it('backs out of a secondary view instead of hiding', () => {
    for (const view of ['issues', 'settings'] as const) {
      expect(keyToCommand(chord({ key: 'Escape' }), ctx({ view }))).toEqual({ kind: 'close-view' });
    }
  });

  it('hides even from inside a text field — the textarea has focus by default', () => {
    expect(keyToCommand(chord({ key: 'Escape', inField: true }), ctx())).toEqual({
      kind: 'dispatch',
      action: { type: 'esc' },
    });
  });
});

describe('annotation editor', () => {
  /*
   * The editor handles Esc / Enter / Ctrl+Z / P / O / C itself, against undo
   * state only it has. Every one of these must stay unclaimed here, or a single
   * keypress fires two handlers.
   */
  it('yields its whole keyboard to the editor', () => {
    for (const key of ['Escape', 'Enter', 'p', 'o', 'c', 'P', 'z', 'Delete']) {
      expect(keyToCommand(chord({ key }), ctx({ editing: true }))).toBeNull();
    }
  });

  it('yields the modified combinations too, including Ctrl+Z undo', () => {
    for (const key of ['z', 'c', 'Enter', 'r', 'n']) {
      expect(keyToCommand(chord({ key, ctrl: true }), ctx({ editing: true }))).toBeNull();
    }
  });

  it('does not refine or submit behind an open editor', () => {
    expect(
      keyToCommand(chord({ key: 'Enter', ctrl: true }), ctx({ editing: true, stage: 'draft' })),
    ).toBeNull();
  });
});

describe('Ctrl+Enter', () => {
  it('refines from the input stage', () => {
    expect(keyToCommand(chord({ key: 'Enter', ctrl: true }), ctx({ stage: 'input' }))).toEqual({
      kind: 'dispatch',
      action: { type: 'refine' },
    });
  });

  it('submits from the draft stage', () => {
    expect(keyToCommand(chord({ key: 'Enter', ctrl: true }), ctx({ stage: 'draft' }))).toEqual({
      kind: 'dispatch',
      action: { type: 'submit' },
    });
  });

  it('does nothing while work is already in flight', () => {
    for (const stage of ['refining', 'submitting', 'done'] as const) {
      expect(keyToCommand(chord({ key: 'Enter', ctrl: true }), ctx({ stage }))).toBeNull();
    }
  });

  it('fires from inside the textarea — that is where the caret always is', () => {
    expect(
      keyToCommand(chord({ key: 'Enter', ctrl: true, inField: true }), ctx({ stage: 'input' })),
    ).toEqual({ kind: 'dispatch', action: { type: 'refine' } });
  });

  it('leaves a bare Enter alone so it types a newline', () => {
    expect(keyToCommand(chord({ key: 'Enter' }), ctx({ stage: 'input' }))).toBeNull();
  });
});

describe('Ctrl+R', () => {
  it('opens the repo switcher from any capture stage', () => {
    for (const stage of ['input', 'draft', 'done'] as const) {
      expect(keyToCommand(chord({ key: 'r', ctrl: true }), ctx({ stage }))).toEqual({
        kind: 'open-repos',
      });
    }
  });
});

describe('Ctrl+N', () => {
  it('starts a new report only where the reducer allows it', () => {
    expect(keyToCommand(chord({ key: 'n', ctrl: true }), ctx({ stage: 'done', canNew: true }))).toEqual(
      { kind: 'dispatch', action: { type: 'new-report' } },
    );
  });

  it('is inert while a draft is still alive, so the slot cannot be dropped', () => {
    expect(
      keyToCommand(chord({ key: 'n', ctrl: true }), ctx({ stage: 'draft', canNew: false })),
    ).toBeNull();
  });
});

describe('Ctrl+1..9 similar issues', () => {
  it('picks a candidate by position', () => {
    expect(
      keyToCommand(chord({ key: '2', ctrl: true }), ctx({ stage: 'draft', similarCount: 3 })),
    ).toEqual({ kind: 'similar', index: 1 });
  });

  it('ignores a number past the end of the list', () => {
    expect(
      keyToCommand(chord({ key: '3', ctrl: true }), ctx({ stage: 'draft', similarCount: 2 })),
    ).toBeNull();
  });

  it('only applies on the draft stage, where the card exists', () => {
    expect(
      keyToCommand(chord({ key: '1', ctrl: true }), ctx({ stage: 'input', similarCount: 3 })),
    ).toBeNull();
  });
});

describe('everything else', () => {
  it('is left alone', () => {
    for (const key of ['a', 'F5', 'Tab', 'ArrowDown', ' ']) {
      expect(keyToCommand(chord({ key }), ctx())).toBeNull();
    }
  });

  it('ignores Ctrl+Alt combinations, which are AltGr on many layouts', () => {
    expect(keyToCommand(chord({ key: 'r', ctrl: true, alt: true }), ctx())).toBeNull();
  });
});

describe('discard', () => {
  it('is an accelerator for the visible Discard button', () => {
    expect(keyToCommand(chord({ key: 'd', ctrl: true, shift: true }), ctx({ canDiscard: true }))).toEqual({
      kind: 'dispatch',
      action: { type: 'discard' },
    });
  });

  it('works on the draft screen too, where the button also is', () => {
    expect(
      keyToCommand(chord({ key: 'd', ctrl: true, shift: true }), ctx({ stage: 'draft', canDiscard: true })),
    ).toEqual({ kind: 'dispatch', action: { type: 'discard' } });
  });

  it('does nothing when there is no draft to lose', () => {
    expect(keyToCommand(chord({ key: 'd', ctrl: true, shift: true }), ctx({ canDiscard: false }))).toBeNull();
  });

  it('needs BOTH modifiers — no accidental gesture may destroy work', () => {
    for (const c of [
      chord({ key: 'd' }),
      chord({ key: 'd', ctrl: true }),
      chord({ key: 'd', shift: true }),
      chord({ key: 'd', ctrl: true, shift: true, alt: true }),
    ]) {
      expect(keyToCommand(c, ctx({ canDiscard: true }))).toBeNull();
    }
  });

  it('never steals Ctrl+Backspace from the text field', () => {
    // Ctrl+Backspace is "delete the previous word" in every text field ever, and
    // the capture box IS a text field. Bound to Discard, fixing a typo would have
    // deleted the report.
    for (const key of ['Backspace', 'Delete']) {
      expect(keyToCommand(chord({ key, ctrl: true, inField: true }), ctx({ canDiscard: true }))).toBeNull();
      expect(
        keyToCommand(chord({ key, ctrl: true, shift: true, inField: true }), ctx({ canDiscard: true })),
      ).toBeNull();
    }
  });

  it('leaves discard to the annotation editor’s own keyboard', () => {
    expect(
      keyToCommand(chord({ key: 'd', ctrl: true, shift: true }), ctx({ editing: true, canDiscard: true })),
    ).toBeNull();
  });
});
