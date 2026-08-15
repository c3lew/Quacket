import { describe, expect, it } from 'vitest';
import { TITLE_MAX_CHARS } from '../refine/schema.ts';
import type { ImageAttachment, RefinedDraft } from '../types.ts';
import {
  ANNOTATE_WIDTH,
  PALETTE_WIDTH,
  canDiscard,
  canStartNewReport,
  hasDraft,
  initialState,
  isCommenting,
  recoveryOptions,
  reduce,
  similarCandidates,
  type Action,
  type UiState,
} from './reducer.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

const image = (id: string, extra: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png',
  annotated: false,
  ...extra,
});

const draft = (extra: Partial<RefinedDraft> = {}): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after explorer.exe restarts',
  sections: [
    { heading: 'Repro steps', body: '1. Restart explorer.exe' },
    { heading: 'Actual', body: 'The icon is gone.' },
  ],
  followUps: ['Which Windows version?', 'Every time or intermittent?'],
  similarIssues: [],
  ...extra,
});

/** Drive the machine the way the UI does: real actions, from the real start. */
const run = (actions: Action[], from: UiState = initialState()): UiState =>
  actions.reduce((s, a) => reduce(s, a).state, from);

const effectsOf = (state: UiState, action: Action) => reduce(state, action).effects;

/** A state parked on the draft screen, the way a real refine gets there. */
const atDraft = (d: RefinedDraft = draft()): UiState =>
  run([
    { type: 'edit-raw', raw: 'tray icon vanished after explorer restart' },
    { type: 'refine' },
    { type: 'refine-ok', draft: d },
  ]);

// ── Stage transitions ───────────────────────────────────────────────────────

describe('stage transitions', () => {
  it('starts on the input stage at rest width', () => {
    expect(initialState().stage).toBe('input');
    expect(initialState().width).toBe(PALETTE_WIDTH);
  });

  it('walks input -> refining -> draft -> submitting -> done', () => {
    const typed = run([{ type: 'edit-raw', raw: 'tray icon vanished' }]);
    expect(typed.stage).toBe('input');

    const refining = reduce(typed, { type: 'refine' });
    expect(refining.state.stage).toBe('refining');
    expect(refining.effects).toEqual([{ type: 'refine' }]);

    const drafted = reduce(refining.state, { type: 'refine-ok', draft: draft() });
    expect(drafted.state.stage).toBe('draft');
    expect(drafted.state.refined?.title).toBe('Tray icon disappears after explorer.exe restarts');

    const submitting = reduce(drafted.state, { type: 'submit' });
    expect(submitting.state.stage).toBe('submitting');
    expect(submitting.effects).toEqual([{ type: 'submit', withoutImages: false }]);

    const done = reduce(submitting.state, {
      type: 'submit-ok',
      result: { url: 'https://github.com/c3lew/Quacket/issues/123', issueNumber: 123 },
    });
    expect(done.state.stage).toBe('done');
    expect(done.state.result?.issueNumber).toBe(123);
  });

  it('refuses to refine an empty dump', () => {
    const next = reduce(initialState(), { type: 'refine' });
    expect(next.state.stage).toBe('input');
    expect(next.effects).toEqual([]);
  });

  it('opens one blank answer slot per follow-up question', () => {
    expect(atDraft().answers).toEqual(['', '']);
    expect(run([{ type: 'answer', index: 1, text: 'every time' }], atDraft()).answers).toEqual([
      '',
      'every time',
    ]);
  });

  it('goes back to the raw input without losing the draft', () => {
    const back = reduce(atDraft(), { type: 'back-to-input' });
    expect(back.state.stage).toBe('input');
    expect(back.state.refined).not.toBeNull();
  });
});

// ── Esc / hide / summon ─────────────────────────────────────────────────────

describe('Esc hides to tray at any stage', () => {
  const stages: Array<[string, UiState]> = [
    ['input', initialState()],
    ['refining', run([{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }])],
    ['draft', atDraft()],
    ['submitting', run([{ type: 'submit' }], atDraft())],
    ['done', run([{ type: 'submit-ok', result: { url: 'u', issueNumber: 1 } }], run([{ type: 'submit' }], atDraft()))],
  ];

  it.each(stages)('hides from %s', (stage, state) => {
    const next = reduce(state, { type: 'esc' });
    expect(next.state.hidden).toBe(true);
    expect(next.effects).toEqual([{ type: 'hide' }]);
    expect(next.state.stage).toBe(stage);
  });

  it('does not cancel a submit — it keeps running in the background', () => {
    const sending = run([{ type: 'submit' }], atDraft());
    const hidden = reduce(sending, { type: 'esc' });

    expect(hidden.state.stage).toBe('submitting');
    expect(hidden.effects).toEqual([{ type: 'hide' }]);

    // The submission lands while nobody is watching.
    const landed = reduce(hidden.state, {
      type: 'submit-ok',
      result: { url: 'https://github.com/c3lew/Quacket/issues/7', issueNumber: 7 },
    });
    expect(landed.state.stage).toBe('done');
    expect(landed.effects).toEqual([]);
  });

  it('re-summoning mid-flight shows the live sending state', () => {
    const hidden = run([{ type: 'submit' }, { type: 'esc' }], atDraft());
    const back = reduce(hidden, { type: 'summon' });

    expect(back.state.hidden).toBe(false);
    expect(back.state.stage).toBe('submitting');
    expect(back.effects).toEqual([]);
  });

  it('lands the next summon on the failed draft error card', () => {
    const failed = run(
      [
        { type: 'submit' },
        { type: 'esc' },
        { type: 'submit-failed', error: { kind: 'create_failed', message: 'API returned 502' } },
      ],
      atDraft(),
    );
    const back = reduce(failed, { type: 'summon' });

    expect(back.state.stage).toBe('draft');
    expect(back.state.failure).toEqual({ kind: 'create_failed', message: 'API returned 502' });
  });
});

// ── Notifications ───────────────────────────────────────────────────────────

describe('notifications carry only bad news', () => {
  it('notifies when a submit fails while hidden', () => {
    const hidden = run([{ type: 'submit' }, { type: 'esc' }], atDraft());
    const effects = effectsOf(hidden, {
      type: 'submit-failed',
      error: { kind: 'upload_failed', message: 'Could not upload screenshot-1.png' },
    });

    expect(effects).toEqual([{ type: 'notify', message: 'Could not upload screenshot-1.png' }]);
  });

  it('stays quiet when a submit fails while the window is up', () => {
    const visible = run([{ type: 'submit' }], atDraft());
    const next = reduce(visible, {
      type: 'submit-failed',
      error: { kind: 'upload_failed', message: 'Could not upload screenshot-1.png' },
    });

    expect(next.effects).toEqual([]);
    expect(next.state.failure?.kind).toBe('upload_failed');
  });

  it('stays silent on success, hidden or not', () => {
    const hidden = run([{ type: 'submit' }, { type: 'esc' }], atDraft());
    const effects = effectsOf(hidden, {
      type: 'submit-ok',
      result: { url: 'u', issueNumber: 9 },
    });

    expect(effects).toEqual([]);
  });

  it('notifies when a refine fails while hidden', () => {
    const hidden = run([{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }, { type: 'esc' }]);
    const effects = effectsOf(hidden, {
      type: 'refine-failed',
      error: { kind: 'rate_limited', message: 'Claude is rate limited — try again in a minute' },
    });

    expect(effects).toEqual([
      { type: 'notify', message: 'Claude is rate limited — try again in a minute' },
    ]);
  });
});

// ── Done gating ─────────────────────────────────────────────────────────────

describe('New report is gated on the done screen', () => {
  const done = run(
    [{ type: 'submit' }, { type: 'submit-ok', result: { url: 'u', issueNumber: 5 } }],
    atDraft(),
  );

  it.each([
    ['input', run([{ type: 'edit-raw', raw: 'half typed' }])],
    ['refining', run([{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }])],
    ['draft', atDraft()],
    ['submitting', run([{ type: 'submit' }], atDraft())],
  ])('refuses to free the draft slot from %s', (_stage, state) => {
    expect(canStartNewReport(state)).toBe(false);
    expect(reduce(state, { type: 'new-report' }).state).toBe(state);
  });

  it('frees the draft slot only on confirmed success', () => {
    expect(canStartNewReport(done)).toBe(true);

    const fresh = reduce(done, { type: 'new-report' }).state;
    expect(fresh.stage).toBe('input');
    expect(fresh.raw).toBe('');
    expect(fresh.refined).toBeNull();
    expect(fresh.images).toEqual([]);
    expect(fresh.result).toBeNull();
  });
});

// ── Failure matrix ──────────────────────────────────────────────────────────

describe('failure matrix', () => {
  it('offers Retry / File as-is when refine fails', () => {
    const failed = reduce(run([{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }]), {
      type: 'refine-failed',
      error: { kind: 'timeout', message: 'Claude took too long' },
    }).state;

    expect(failed.stage).toBe('input');
    expect(recoveryOptions(failed.failure!, failed.stage)).toEqual(['retry', 'file-as-is']);
  });

  it('files as-is with the raw text as the body and the first line as the title', () => {
    const raw = 'tray icon vanished after explorer restart\nhappens every single time';
    const filed = run([{ type: 'edit-raw', raw }, { type: 'file-as-is' }]);

    expect(filed.stage).toBe('draft');
    expect(filed.refined?.title).toBe('tray icon vanished after explorer restart');
    expect(filed.refined?.sections).toEqual([{ heading: '', body: raw }]);
    expect(filed.refined?.followUps).toEqual([]);
  });

  it('truncates a long first line into a usable title', () => {
    const long = 'x'.repeat(200);
    const filed = run([{ type: 'edit-raw', raw: long }, { type: 'file-as-is' }]);

    expect(filed.refined?.title).toHaveLength(TITLE_MAX_CHARS);
  });

  it('leaves the filed-as-is title editable', () => {
    const filed = run([
      { type: 'edit-raw', raw: 'messy dump' },
      { type: 'file-as-is' },
      { type: 'edit-title', title: 'Tray icon vanishes on explorer restart' },
    ]);

    expect(filed.refined?.title).toBe('Tray icon vanishes on explorer restart');
  });

  it('retries a refine from the failure banner', () => {
    const failed = reduce(run([{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }]), {
      type: 'refine-failed',
      error: { kind: 'provider_error', message: 'claude exited 1' },
    }).state;

    const retry = reduce(failed, { type: 'refine' });
    expect(retry.state.stage).toBe('refining');
    expect(retry.state.failure).toBeNull();
    expect(retry.effects).toEqual([{ type: 'refine' }]);
  });

  it('offers Retry / File without images when the upload fails', () => {
    const failed = run(
      [
        { type: 'add-image', image: image('img_1') },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'upload_failed', message: 'upload died' } },
      ],
      atDraft(),
    );

    expect(failed.stage).toBe('draft');
    expect(recoveryOptions(failed.failure!, failed.stage)).toEqual(['retry', 'file-without-images']);
  });

  it('files without images by dropping them and resubmitting', () => {
    const failed = run(
      [
        { type: 'add-image', image: image('img_1') },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'upload_failed', message: 'upload died' } },
      ],
      atDraft(),
    );

    const next = reduce(failed, { type: 'file-without-images' });
    expect(next.state.images).toEqual([]);
    expect(next.state.stage).toBe('submitting');
    expect(next.state.failure).toBeNull();
    // The DECISION is what reaches Filing; the cleared thumbnails are cosmetic.
    expect(next.effects).toEqual([{ type: 'submit', withoutImages: true }]);
    // The refined draft is never rewritten here: Filing files the frozen report,
    // so a reducer that edited it would only be lying to the screen.
    expect(next.state.refined).toEqual(failed.refined);
  });

  /**
   * The floor — a report whose every section was image-only must file as the raw
   * dump rather than a title over an empty body — used to be applied HERE, by
   * rewriting `refined`. It moved into Filing's renderer with the rest of body
   * rendering, and `filing.test.ts` pins it there. This is the other half of that
   * move: the reducer must not rewrite a report a Filing already owns.
   */
  it('never rewrites the refined draft when dropping images', () => {
    const imageOnly = draft({
      sections: [
        { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
        { heading: 'Expected', body: ' ![](quacket-image:img_2) ' },
      ],
    });
    const failed = run(
      [
        { type: 'add-image', image: image('img_1') },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'upload_failed', message: 'upload died' } },
      ],
      atDraft(imageOnly),
    );

    const next = reduce(failed, { type: 'file-without-images' });
    expect(next.state.refined).toEqual(imageOnly);
    expect(next.state.images).toEqual([]);
    expect(next.effects).toEqual([{ type: 'submit', withoutImages: true }]);
  });

  /** One surviving sentence is enough: the floor must not overwrite real prose. */
  it('keeps the sections when even one survives the image strip', () => {
    const oneSurvivor = draft({
      sections: [
        { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
        { heading: 'Repro steps', body: 'Restart explorer.exe' },
      ],
    });
    const failed = run(
      [
        { type: 'add-image', image: image('img_1') },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'upload_failed', message: 'upload died' } },
      ],
      atDraft(oneSurvivor),
    );

    const next = reduce(failed, { type: 'file-without-images' });
    expect(next.state.refined?.sections).toEqual(oneSurvivor.sections);
  });

  it('offers only Retry when issue creation fails after the upload', () => {
    const failed = run(
      [
        { type: 'add-image', image: image('img_1') },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'create_failed', message: 'gh issue create failed' } },
      ],
      atDraft(),
    );

    expect(recoveryOptions(failed.failure!, failed.stage)).toEqual(['retry']);
  });

  /**
   * Retry means "finish THAT report", not "file another one". The Filing id is
   * what carries that, and it has to survive the retry — a `submit` that lost it
   * would start a second Filing against a report GitHub may already have.
   */
  it('remembers the Filing a failed submit belongs to, and keeps it across a retry', () => {
    const failed = run(
      [
        { type: 'submit' },
        {
          type: 'submit-failed',
          error: { kind: 'create_failed', message: 'gh issue create failed' },
          filingId: 'fil_1',
        },
      ],
      atDraft(),
    );

    expect(failed.filingId).toBe('fil_1');

    const retry = reduce(failed, { type: 'submit' });
    expect(retry.effects).toEqual([{ type: 'submit', withoutImages: false }]);
    expect(retry.state.filingId).toBe('fil_1');
  });

  it('keeps the known Filing when a later failure carries none', () => {
    // Nothing reached Filing that time (no repo, a thrown non-FilingError).
    // Clearing the id would turn the next Retry into a second report.
    const failed = run(
      [
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'create_failed', message: 'x' }, filingId: 'fil_1' },
        { type: 'submit' },
        { type: 'submit-failed', error: { kind: 'provider_error', message: 'Nothing to submit.' } },
      ],
      atDraft(),
    );

    expect(failed.filingId).toBe('fil_1');
  });
});

// ── Type switcher ───────────────────────────────────────────────────────────

describe('draft type switcher', () => {
  it('reclassifies in one keystroke', () => {
    const reclassified = run([{ type: 'set-type', reportType: 'feature' }], atDraft());
    expect(reclassified.refined?.type).toBe('feature');

    expect(run([{ type: 'set-type', reportType: 'chore' }], reclassified).refined?.type).toBe(
      'chore',
    );
  });

  it('ignores a reclassification before there is a draft', () => {
    const s = initialState();
    expect(reduce(s, { type: 'set-type', reportType: 'chore' }).state).toBe(s);
  });
});

// ── Similar issues ──────────────────────────────────────────────────────────

describe('similar-issue card', () => {
  const similar = draft({
    similarIssues: [
      { number: 42, title: 'Tray icon disappears', reason: 'same symptom' },
      { number: 38, title: 'Hotkey silently fails', reason: 'also a tray bug' },
      { number: 31, title: 'Paste freezes input', reason: 'same window' },
      { number: 27, title: 'Remember window position', reason: 'unrelated-ish' },
    ],
  });

  it('defaults to filing a new issue — ignoring the card is the default path', () => {
    const state = atDraft(similar);
    expect(state.target).toEqual({ kind: 'new-issue' });
    expect(isCommenting(state)).toBe(false);
  });

  it('shows at most three candidates', () => {
    expect(similarCandidates(atDraft(similar)).map((s) => s.number)).toEqual([42, 38, 31]);
  });

  it('switches submit semantics to Comment on #n, and one action switches back', () => {
    const commenting = run([{ type: 'choose-similar', issueNumber: 38 }], atDraft(similar));
    expect(commenting.target).toEqual({ kind: 'comment', issueNumber: 38 });
    expect(isCommenting(commenting)).toBe(true);

    const backToNew = reduce(commenting, { type: 'choose-similar', issueNumber: 38 });
    expect(backToNew.state.target).toEqual({ kind: 'new-issue' });
    expect(isCommenting(backToNew.state)).toBe(false);
  });

  it('moves the comment target when a different candidate is chosen', () => {
    const state = run(
      [{ type: 'choose-similar', issueNumber: 38 }, { type: 'choose-similar', issueNumber: 42 }],
      atDraft(similar),
    );
    expect(state.target).toEqual({ kind: 'comment', issueNumber: 42 });
  });

  it('carries the comment target into the submit', () => {
    const sending = run(
      [{ type: 'choose-similar', issueNumber: 42 }, { type: 'submit' }],
      atDraft(similar),
    );
    expect(sending.stage).toBe('submitting');
    expect(sending.target).toEqual({ kind: 'comment', issueNumber: 42 });
  });

  it('resets the target when a fresh refine lands', () => {
    const rerefined = run(
      [
        { type: 'choose-similar', issueNumber: 42 },
        { type: 'back-to-input' },
        { type: 'refine' },
        { type: 'refine-ok', draft: similar },
      ],
      atDraft(similar),
    );
    expect(rerefined.target).toEqual({ kind: 'new-issue' });
  });
});

// ── Annotation morph ────────────────────────────────────────────────────────

describe('annotation morph', () => {
  const withImages = run([
    { type: 'add-image', image: image('img_1') },
    { type: 'add-image', image: image('img_2') },
  ]);

  it('morphs the body into the editor and widens the window', () => {
    const editing = reduce(withImages, { type: 'open-image', index: 1 });

    expect(editing.state.editing).toEqual({ index: 1 });
    expect(editing.state.width).toBe(ANNOTATE_WIDTH);
    expect(editing.effects).toEqual([]);
  });

  it('narrows back to rest width on Done', () => {
    const done = run(
      [{ type: 'open-image', index: 0 }, { type: 'annotate-done', bytes: new Uint8Array([9, 9]) }],
      withImages,
    );

    expect(done.editing).toBeNull();
    expect(done.width).toBe(PALETTE_WIDTH);
  });

  it('narrows back to rest width on Cancel', () => {
    const cancelled = run(
      [{ type: 'open-image', index: 0 }, { type: 'annotate-cancel' }],
      withImages,
    );

    expect(cancelled.editing).toBeNull();
    expect(cancelled.width).toBe(PALETTE_WIDTH);
  });

  it('ignores opening an image that is not there', () => {
    const next = reduce(withImages, { type: 'open-image', index: 9 });
    expect(next.state).toBe(withImages);
  });

  // Tool selection (P / O / C) is NOT tested here because the reducer does not
  // own it: AnnotateEditor does, and `ui/annotate/model.test.ts` covers keyIntent
  // including modifiers and shifted keys. There is one owner, so there is one test.

  it('Done flattens the annotation onto the image and badges it as marked', () => {
    const flattened = run(
      [{ type: 'open-image', index: 1 }, { type: 'annotate-done', bytes: new Uint8Array([7, 7, 7]) }],
      withImages,
    );

    expect(flattened.images[1]?.bytes).toEqual(new Uint8Array([7, 7, 7]));
    expect(flattened.images[1]?.annotated).toBe(true);
    expect(flattened.images[1]?.id).toBe('img_2');

    // The untouched image keeps its bytes and stays unbadged.
    expect(flattened.images[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(flattened.images[0]?.annotated).toBe(false);
  });

  it('re-types a flattened JPEG as PNG, because the editor re-encodes to PNG', () => {
    // AnnotateEditor flattens through a canvas with toBlob(..., 'image/png'), so
    // the bytes coming back are ALWAYS PNG. Keeping mediaType 'image/jpeg' would
    // ship PNG bytes named .jpg to GitHub and base64 them to the model as JPEG.
    const jpeg = run([{ type: 'add-image', image: image('img_1', { mediaType: 'image/jpeg' }) }]);

    const flattened = run(
      [{ type: 'open-image', index: 0 }, { type: 'annotate-done', bytes: new Uint8Array([137, 80]) }],
      jpeg,
    );

    expect(flattened.images[0]?.mediaType).toBe('image/png');
    expect(flattened.images[0]?.bytes).toEqual(new Uint8Array([137, 80]));
  });

  it('Cancel discards the edits — the image is untouched', () => {
    const cancelled = run(
      [{ type: 'open-image', index: 0 }, { type: 'annotate-cancel' }],
      withImages,
    );

    expect(cancelled.images[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(cancelled.images[0]?.annotated).toBe(false);
  });

  it('Esc cancels the edit instead of hiding the window', () => {
    const editing = run([{ type: 'open-image', index: 0 }], withImages);
    const next = reduce(editing, { type: 'esc' });

    expect(next.state.hidden).toBe(false);
    expect(next.state.editing).toBeNull();
    expect(next.state.width).toBe(PALETTE_WIDTH);
    expect(next.effects).toEqual([]);
  });

  it('Esc hides the window once the editor is closed', () => {
    const closed = run([{ type: 'open-image', index: 0 }, { type: 'esc' }], withImages);
    const next = reduce(closed, { type: 'esc' });

    expect(next.state.hidden).toBe(true);
    expect(next.effects).toEqual([{ type: 'hide' }]);
  });

  it('removes an image with Del', () => {
    const removed = run([{ type: 'remove-image', index: 0 }], withImages);
    expect(removed.images.map((i) => i.id)).toEqual(['img_2']);
  });

  it('keeps an already-annotated image marked', () => {
    const state = run([{ type: 'add-image', image: image('img_9', { annotated: true }) }]);
    expect(state.images[0]?.annotated).toBe(true);
  });
});

// ── Discard ─────────────────────────────────────────────────────────────────

describe('discard is the only deliberate way to lose work', () => {
  it('offers itself once there is something to lose', () => {
    expect(canDiscard(initialState())).toBe(false);
    expect(canDiscard(run([{ type: 'edit-raw', raw: 'tray icon gone' }]))).toBe(true);
    expect(canDiscard(run([{ type: 'add-image', image: image('img_1') }]))).toBe(true);
    expect(canDiscard(atDraft())).toBe(true);
  });

  it('does not count whitespace as a draft worth keeping', () => {
    expect(hasDraft(run([{ type: 'edit-raw', raw: '   \n  ' }]))).toBe(false);
    expect(canDiscard(run([{ type: 'edit-raw', raw: '   \n  ' }]))).toBe(false);
  });

  it('deletes the draft folder and resets the machine', () => {
    const next = reduce(atDraft(), { type: 'discard' });

    expect(next.effects).toEqual([{ type: 'discard-draft' }]);
    expect(next.state.raw).toBe('');
    expect(next.state.images).toEqual([]);
    expect(next.state.refined).toBeNull();
    expect(next.state.stage).toBe('input');
  });

  it('leaves the window exactly as it was — discarding is not hiding', () => {
    const hidden = run([{ type: 'edit-raw', raw: 'x' }, { type: 'esc' }]);
    expect(reduce(hidden, { type: 'discard' }).state.hidden).toBe(true);
  });

  it('is the ONLY action in the whole machine that deletes the draft', () => {
    // The inverse guarantee, and the one that actually protects the user: if any
    // other action can reach `discard-draft`, a draft can be lost by accident.
    const everything: Action[] = [
      { type: 'summon' },
      { type: 'esc' },
      { type: 'edit-raw', raw: '' },
      { type: 'add-image', image: image('img_9') },
      { type: 'remove-image', index: 0 },
      { type: 'open-image', index: 0 },
      { type: 'annotate-done', bytes: new Uint8Array([1]) },
      { type: 'annotate-cancel' },
      { type: 'refine' },
      { type: 'refine-ok', draft: draft() },
      { type: 'refine-failed', error: { kind: 'timeout', message: 'slow' } },
      { type: 'file-as-is' },
      { type: 'set-type', reportType: 'bug' },
      { type: 'edit-title', title: 't' },
      { type: 'edit-section', index: 0, body: 'b' },
      { type: 'answer', index: 0, text: 'a' },
      { type: 'choose-similar', issueNumber: 1 },
      { type: 'back-to-input' },
      { type: 'submit' },
      { type: 'submit-ok', result: { url: 'u', issueNumber: 1 } },
      { type: 'submit-failed', error: { kind: 'create_failed', message: 'x' } },
      { type: 'file-without-images' },
      { type: 'new-report' },
    ];

    for (const state of [initialState(), run([{ type: 'edit-raw', raw: 'x' }]), atDraft()]) {
      for (const action of everything) {
        expect(reduce(state, action).effects).not.toContainEqual({ type: 'discard-draft' });
      }
    }
  });

  it('keeps its hands off a submit in flight', () => {
    // The store is mid-bracket on that folder; yanking it would race the outcome.
    const sending = run([{ type: 'submit' }], atDraft());
    expect(canDiscard(sending)).toBe(false);
    expect(reduce(sending, { type: 'discard' }).effects).toEqual([]);
    expect(reduce(sending, { type: 'discard' }).state.stage).toBe('submitting');
  });

  it('does nothing when there is nothing to discard', () => {
    expect(reduce(initialState(), { type: 'discard' }).effects).toEqual([]);
  });
});

// ── The recovery matrix is keyed on the leg that died ───────────────────────

describe('recovery is offered per leg, not per error kind', () => {
  it('never offers to overwrite a refined draft with raw text on the submit leg', () => {
    // `not_authenticated` is a GitHubErrorKind AND an ErrorKind: a dead `gh` and a
    // dead CLI login are the same kind. Keyed on kind, this submit failure offered
    // [File my raw text instead], which destroys the draft the user is standing on.
    const failed = run(
      [{ type: 'submit' }, { type: 'submit-failed', error: { kind: 'not_authenticated', message: 'gh auth expired' } }],
      atDraft(),
    );

    expect(failed.stage).toBe('draft');
    expect(recoveryOptions(failed.failure!, failed.stage)).toEqual(['retry']);
    expect(recoveryOptions(failed.failure!, failed.stage)).not.toContain('file-as-is');
  });

  it('still offers the escape hatch when the same kind kills a refine', () => {
    const failed = run(
      [{ type: 'edit-raw', raw: 'x' }, { type: 'refine' }, { type: 'refine-failed', error: { kind: 'not_authenticated', message: 'claude logged out' } }],
    );

    expect(failed.stage).toBe('input');
    expect(recoveryOptions(failed.failure!, failed.stage)).toEqual(['retry', 'file-as-is']);
  });

  it('clears a dead submit’s failure when the user goes back to edit', () => {
    // Otherwise the submit error is rendered against the refine matrix, where
    // [Try again] silently means "re-refine" — and `session.ts` can no longer
    // tell a persisted refine failure from a persisted submit failure.
    const failed = run(
      [{ type: 'submit' }, { type: 'submit-failed', error: { kind: 'create_failed', message: 'gh 502' } }],
      atDraft(),
    );
    expect(failed.failure).not.toBeNull();

    expect(reduce(failed, { type: 'back-to-input' }).state.failure).toBeNull();
  });
});

// ── file-as-is asserts nothing ──────────────────────────────────────────────

describe('file-as-is claims no classification it does not have', () => {
  it('does not stamp a real `bug` label on a report nothing classified', () => {
    // github.ts maps bug -> `bug`, feature -> `enhancement`, chore -> no label.
    // This is the one path where the classifier is exactly what failed, so the
    // only honest type is the one that applies no label at all.
    const filed = run([{ type: 'edit-raw', raw: 'something is off' }, { type: 'file-as-is' }]);

    expect(filed.refined?.type).toBe('chore');
  });

  it('still lets the user classify it themselves in one click', () => {
    const filed = run([
      { type: 'edit-raw', raw: 'something is off' },
      { type: 'file-as-is' },
      { type: 'set-type', reportType: 'bug' },
    ]);

    expect(filed.refined?.type).toBe('bug');
  });
});

// ── Startup recovery ────────────────────────────────────────────────────────

describe('a report recovered after a crash', () => {
  const result = { url: 'https://github.com/c3lew/Quacket/issues/42', issueNumber: 42 };

  it('lands on Done, the same screen a live submit reaches', () => {
    const state = run([{ type: 'recovered', result }]);

    expect(state.stage).toBe('done');
    expect(state.result).toEqual(result);
  });

  it('leaves a report the user is already typing exactly where it is', () => {
    // Recovery races the user: a slow lookup can resolve minutes later, and
    // replacing what they are writing with a done screen is the interruption
    // Quacket exists to avoid.
    const typing = run([{ type: 'edit-raw', raw: 'the next thing that broke' }]);
    const state = run([{ type: 'recovered', result }], typing);

    expect(state.stage).toBe('input');
    expect(state.raw).toBe('the next thing that broke');
    expect(state.result).toBeNull();
  });

  it('never overwrites a report mid-flight or already on screen', () => {
    for (const busy of [atDraft(), run([{ type: 'submit' }], atDraft())]) {
      expect(run([{ type: 'recovered', result }], busy).stage).toBe(busy.stage);
    }
  });
});
