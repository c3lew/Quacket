import { describe, expect, it } from 'vitest';

import type { FilingReceipt } from '../../core/filing/filing.ts';
import type { Draft, ImageAttachment, OpenIssue, RefinedDraft } from '../../core/types.ts';
import { initialState, reduce, type UiState } from '../../core/ui/reducer.ts';
import {
  dropInventedIssues,
  NO_REPO,
  pushRecent,
  shouldFoldAnswers,
  shouldSaveDraft,
  receiptEntry,
  restoreActions,
  toDraft,
  type SentEntry,
} from './session.ts';

const image = (id: string, extra: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png',
  annotated: false,
  ...extra,
});

const refined = (extra: Partial<RefinedDraft> = {}): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after explorer restarts',
  sections: [{ heading: 'Actual', body: 'The icon is gone.' }],
  followUps: ['Which Windows build?', 'Every time?'],
  similarIssues: [{ number: 42, title: 'Tray icon vanishes', reason: 'Same symptom.' }],
  ...extra,
});

/** Replays a restore the way the App does: through the real reducer. */
const restore = (draft: Draft): UiState =>
  restoreActions(draft).reduce((state, action) => reduce(state, action).state, initialState());

describe('toDraft', () => {
  it('carries the report across', () => {
    const state = { ...initialState(), raw: 'it broke' };
    expect(toDraft(state, 'd1', 'c3lew/Quacket')).toMatchObject({
      id: 'd1',
      repo: 'c3lew/Quacket',
      raw: 'it broke',
      target: { kind: 'new-issue' },
    });
  });

  it('omits the optional fields rather than writing undefined into them', () => {
    const draft = toDraft(initialState(), 'd1', 'r');
    expect('refined' in draft).toBe(false);
    expect('answers' in draft).toBe(false);
    expect('lastError' in draft).toBe(false);
  });

  it('includes refined, answers and the failure once they exist', () => {
    // Stage 'draft' because that is the only stage a submit failure can land on —
    // `toDraft` reads it to tell a submit failure from a refine one.
    const state: UiState = {
      ...initialState(),
      stage: 'draft',
      refined: refined(),
      answers: ['26100', ''],
      failure: { kind: 'create_failed', message: 'Could not create the issue.' },
    };
    const draft = toDraft(state, 'd1', 'r');
    expect(draft.refined).toEqual(refined());
    expect(draft.answers).toEqual(['26100', '']);
    expect(draft.lastError).toEqual({ kind: 'create_failed', message: 'Could not create the issue.' });
  });

  it('COPIES images, so nothing downstream can mutate React state through them', () => {
    const original = image('img_1');
    const state = { ...initialState(), images: [original] };
    const draft = toDraft(state, 'd1', 'r');

    // This object crosses into the store and then into Filing.
    (draft.images[0] as ImageAttachment).annotated = true;

    expect(original.annotated).toBe(false);
    expect(state.images[0]?.annotated).toBe(false);
  });
});

describe('restoreActions', () => {
  const base: Draft = { id: 'd1', repo: 'c3lew/Quacket', raw: 'it broke', images: [], target: { kind: 'new-issue' } };

  it('restores an unrefined draft to the input stage with its text', () => {
    const state = restore(base);
    expect(state.stage).toBe('input');
    expect(state.raw).toBe('it broke');
  });

  it('restores images in attachment order — the ids the model saw depend on it', () => {
    const state = restore({ ...base, images: [image('img_1'), image('img_2'), image('img_3')] });
    expect(state.images.map((i) => i.id)).toEqual(['img_1', 'img_2', 'img_3']);
  });

  it('restores a refined draft to the draft stage', () => {
    const state = restore({ ...base, refined: refined() });
    expect(state.stage).toBe('draft');
    expect(state.refined).toEqual(refined());
  });

  it('restores answers against the right questions', () => {
    const state = restore({ ...base, refined: refined(), answers: ['26100', ''] });
    expect(state.answers).toEqual(['26100', '']);
  });

  it('restores a comment target, so the submit button still says "Comment on #42"', () => {
    const state = restore({ ...base, refined: refined(), target: { kind: 'comment', issueNumber: 42 } });
    expect(state.target).toEqual({ kind: 'comment', issueNumber: 42 });
  });

  it('lands the next summon on the error card', () => {
    const state = restore({
      ...base,
      refined: refined(),
      lastError: { kind: 'upload_failed', message: 'Upload died.' },
    });
    expect(state.stage).toBe('draft');
    expect(state.failure).toEqual({ kind: 'upload_failed', message: 'Upload died.' });
  });

  it('restores silently — a restore is not a fresh failure, so it must not notify', () => {
    const draft: Draft = {
      ...base,
      refined: refined(),
      lastError: { kind: 'create_failed', message: 'Crashed mid-submit.' },
    };
    const effects = restoreActions(draft).flatMap(
      (action, i) =>
        reduce(
          restoreActions(draft)
            .slice(0, i)
            .reduce((s, a) => reduce(s, a).state, initialState()),
          action,
        ).effects,
    );
    expect(effects).toEqual([]);
  });

  it('leaves a pristine draft producing nothing to replay', () => {
    expect(restoreActions({ ...base, raw: '' })).toEqual([]);
  });

  it('round-trips a full draft through toDraft and back unchanged', () => {
    const before: UiState = {
      ...initialState(),
      stage: 'draft',
      raw: 'it broke',
      images: [image('img_1', { annotated: true })],
      refined: refined(),
      answers: ['26100', 'every time'],
      target: { kind: 'comment', issueNumber: 42 },
      failure: { kind: 'create_failed', message: 'Could not create the issue.' },
    };
    const after = restore(toDraft(before, 'd1', 'c3lew/Quacket'));

    expect(after.raw).toBe(before.raw);
    expect(after.images).toEqual(before.images);
    expect(after.refined).toEqual(before.refined);
    expect(after.answers).toEqual(before.answers);
    expect(after.target).toEqual(before.target);
    expect(after.failure).toEqual(before.failure);
    expect(after.stage).toBe('draft');
  });
});

describe('recent-sent list', () => {
  const entry = (n: number, url = `https://example.test/${n}`): SentEntry => ({
    issueNumber: n,
    title: `Issue ${n}`,
    url,
    kind: 'new-issue',
    repo: 'c3lew/Quacket',
  });

  it('puts the newest at the top', () => {
    const list = pushRecent(pushRecent([], entry(1)), entry(2));
    expect(list.map((e) => e.issueNumber)).toEqual([2, 1]);
  });

  it('caps the list so it stays a glance', () => {
    let list: SentEntry[] = [];
    for (let n = 1; n <= 9; n++) list = pushRecent(list, entry(n));
    expect(list).toHaveLength(5);
    expect(list.map((e) => e.issueNumber)).toEqual([9, 8, 7, 6, 5]);
  });

  it('does not list the same issue twice when a retry finally succeeds', () => {
    const first = pushRecent([], entry(7));
    const retried = pushRecent(first, entry(7));
    expect(retried).toHaveLength(1);
  });

  it('does not mutate the list it was given', () => {
    const before = pushRecent([], entry(1));
    pushRecent(before, entry(2));
    expect(before).toHaveLength(1);
  });
});

describe('shouldFoldAnswers', () => {
  const drafted = (over: Partial<UiState> = {}): UiState => ({
    ...initialState(),
    stage: 'draft',
    refined: refined(),
    answers: ['', ''],
    ...over,
  });

  it('folds when an answer was actually given', () => {
    expect(shouldFoldAnswers(drafted({ answers: ['26100', ''] }), refined())).toBe(true);
  });

  it('does not spend a turn when every question was skipped', () => {
    expect(shouldFoldAnswers(drafted(), refined())).toBe(false);
  });

  it('treats whitespace as a skip', () => {
    expect(shouldFoldAnswers(drafted({ answers: ['   ', '\t'] }), refined())).toBe(false);
  });

  it('lets a hand-edited body win — turn 2 would overwrite the user', () => {
    const edited = refined({ sections: [{ heading: 'Actual', body: 'I rewrote this myself.' }] });
    expect(shouldFoldAnswers(drafted({ refined: edited, answers: ['26100', ''] }), refined())).toBe(false);
  });

  it('counts an edited title as a hand-edit', () => {
    const edited = refined({ title: 'My own title' });
    expect(shouldFoldAnswers(drafted({ refined: edited, answers: ['26100', ''] }), refined())).toBe(false);
  });

  it('counts a reclassified type as a hand-edit', () => {
    const edited = refined({ type: 'feature' });
    expect(shouldFoldAnswers(drafted({ refined: edited, answers: ['26100', ''] }), refined())).toBe(false);
  });

  it('still folds after choosing a similar issue — that is not an edit to the draft', () => {
    const state = drafted({ answers: ['26100', ''] });
    const chosen = reduce(state, { type: 'choose-similar', issueNumber: 42 }).state;
    expect(shouldFoldAnswers(chosen, refined())).toBe(true);
  });

  it('still folds after answering — typing an answer is not an edit to the draft', () => {
    const answered = reduce(drafted(), { type: 'answer', index: 0, text: '26100' }).state;
    expect(shouldFoldAnswers(answered, refined())).toBe(true);
  });

  it('does not fold with no pristine draft to compare against, e.g. after file-as-is', () => {
    expect(shouldFoldAnswers(drafted({ answers: ['26100', ''] }), null)).toBe(false);
  });
});

describe('dropInventedIssues', () => {
  const shown: OpenIssue[] = [
    { number: 42, title: 'Tray icon disappears after explorer restarts', labels: ['bug'], updatedAt: '2026-07-14T12:00:00Z' },
    { number: 38, title: 'Global hotkey silently fails', labels: ['bug'], updatedAt: '2026-07-11T12:00:00Z' },
  ];

  it('keeps a candidate the model was actually shown', () => {
    const draft = refined({
      similarIssues: [{ number: 42, title: 'Tray icon disappears after explorer restarts', reason: 'Same symptom.' }],
    });
    expect(dropInventedIssues(draft, shown).similarIssues).toHaveLength(1);
  });

  it('drops an issue number the model was never shown', () => {
    const draft = refined({
      similarIssues: [{ number: 999, title: 'A plausible-looking issue', reason: 'Looks related.' }],
    });
    expect(dropInventedIssues(draft, shown).similarIssues).toEqual([]);
  });

  it('keeps the real ones while dropping the invented one', () => {
    const draft = refined({
      similarIssues: [
        { number: 999, title: 'Invented', reason: 'Nope.' },
        { number: 38, title: 'Global hotkey silently fails', reason: 'Also about the hotkey.' },
      ],
    });
    expect(dropInventedIssues(draft, shown).similarIssues.map((s) => s.number)).toEqual([38]);
  });

  it('re-reads the title from the real issue, so a right number with a wrong title cannot lie', () => {
    const draft = refined({
      similarIssues: [{ number: 42, title: 'A title the model made up', reason: 'Same symptom.' }],
    });
    expect(dropInventedIssues(draft, shown).similarIssues[0]).toEqual({
      number: 42,
      title: 'Tray icon disappears after explorer restarts',
      reason: 'Same symptom.',
    });
  });

  it('drops everything when no issues were shown at all', () => {
    const draft = refined({ similarIssues: [{ number: 42, title: 'x', reason: 'y' }] });
    expect(dropInventedIssues(draft, []).similarIssues).toEqual([]);
  });

  it('leaves the rest of the draft alone', () => {
    const draft = refined();
    const cleaned = dropInventedIssues(draft, shown);
    expect(cleaned.title).toBe(draft.title);
    expect(cleaned.sections).toEqual(draft.sections);
    expect(cleaned.followUps).toEqual(draft.followUps);
  });
});

describe('receiptEntry', () => {
  const receipt: FilingReceipt = {
    url: 'https://github.com/c3lew/Quacket/issues/123',
    issueNumber: 123,
    filingId: 'fil_1',
    repo: 'c3lew/Quacket',
    target: { kind: 'new-issue' },
    title: refined().title,
  };

  it('takes every fact from the receipt, so a recovered report has a row too', () => {
    expect(receiptEntry(receipt)).toEqual({
      issueNumber: 123,
      title: refined().title,
      url: receipt.url,
      kind: 'new-issue',
      repo: 'c3lew/Quacket',
    });
  });

  it('records a comment as a comment, so the row does not claim a new issue', () => {
    expect(receiptEntry({ ...receipt, target: { kind: 'comment', issueNumber: 42 } }).kind).toBe(
      'comment',
    );
  });
});

// ── What may be persisted, and when ─────────────────────────────────────────

/** Parked on the draft screen, the way a real refine gets there. */
const atDraft = (): UiState => ({
  ...initialState(),
  stage: 'draft',
  raw: 'tray icon vanished',
  refined: refined(),
});

describe('shouldSaveDraft', () => {
  it('saves from the first keystroke', () => {
    expect(shouldSaveDraft(initialState())).toBe(false);
    expect(shouldSaveDraft({ ...initialState(), raw: 't' })).toBe(true);
  });

  it('saves a screenshot pasted before a single character is typed', () => {
    expect(shouldSaveDraft({ ...initialState(), images: [image('img_1')] })).toBe(true);
  });

  it('stops writing the moment a Filing owns the report', () => {
    /*
     * Not a nicety: after the handoff there is no folder to write to. The draft
     * directory MOVED into the Filing workspace, so a save under the old id
     * would recreate it with a manifest listing screenshots whose bytes are now
     * elsewhere — corruption `readDraftDir` throws on, i.e. a bricked next boot.
     * The report is safe regardless; it is durable in the Filing workspace.
     */
    expect(shouldSaveDraft({ ...atDraft(), filingId: 'fil_1' })).toBe(false);
    // Even standing on the error card, where the stage is back to 'draft'.
    expect(
      shouldSaveDraft({
        ...atDraft(),
        filingId: 'fil_1',
        failure: { kind: 'create_failed', message: 'gh 502' },
      }),
    ).toBe(false);
  });

  it('keeps its hands off between Submit and the handoff', () => {
    // The same window, before the Filing has an id to name it by.
    expect(shouldSaveDraft({ ...atDraft(), stage: 'submitting' })).toBe(false);
  });

  it('does not resurrect the folder a confirmed success just earned the right to delete', () => {
    expect(shouldSaveDraft({ ...atDraft(), stage: 'done' })).toBe(false);
  });

  it('picks back up when a submit fails before any Filing started', () => {
    // No repo, nothing reached Filing: the draft is still the user's, so the
    // auto-save owns it again.
    expect(
      shouldSaveDraft({ ...atDraft(), failure: { kind: 'create_failed', message: 'gh 502' } }),
    ).toBe(true);
  });

  it('does not wait for a repo — the repo is where a draft GOES, not what it is', () => {
    /*
     * This assertion used to read `.toBe(false)` under the title "has nowhere to
     * save a draft to before a repo is chosen". That title was simply false:
     * drafts are stored at `<baseDir>/drafts/<id>/` and have never needed a repo.
     * The test was written from the code rather than from story 29, so it locked
     * in the very data loss the story forbids — "everything I've typed and pasted
     * auto-saved locally FROM THE FIRST KEYSTROKE".
     *
     * `toDraft` addresses a repo-less draft with `NO_REPO`; nothing reads
     * `Draft.repo` before a submit, and a submit cannot begin without a `Repo` in
     * hand regardless.
     */
    expect(shouldSaveDraft({ ...initialState(), raw: 'typed' })).toBe(true);
    expect(toDraft({ ...initialState(), raw: 'typed' }, 'd1', NO_REPO).raw).toBe('typed');
  });
});

describe('toDraft persists only failures that can be restored correctly', () => {
  it('persists a submit failure, so the next summon lands on its error card', () => {
    const state: UiState = {
      ...atDraft(),
      failure: { kind: 'create_failed', message: 'Could not create the issue.' },
    };
    expect(toDraft(state, 'd1', 'r').lastError).toEqual({
      kind: 'create_failed',
      message: 'Could not create the issue.',
    });
  });

  it('does NOT persist a refine failure', () => {
    // A refine failure lives on the input stage. Persisting it puts a value in
    // `lastError` that restore can only replay as `submit-failed` — landing the
    // card on the draft stage, where [Try again] FILES THE ISSUE instead of
    // re-refining and [File my raw text instead] overwrites the refined draft.
    const state: UiState = {
      ...initialState(),
      stage: 'input',
      raw: 'tray icon vanished',
      refined: refined(),
      failure: { kind: 'provider_error', message: 'Claude returned an unusable draft.' },
    };

    expect(toDraft(state, 'd1', 'r').lastError).toBeUndefined();
  });

  it('does not persist a refine failure that shares a kind with a gh failure', () => {
    // `not_authenticated` is both an ErrorKind and a GitHubErrorKind, so kind
    // alone could never have told these two apart. The stage always can.
    const state: UiState = {
      ...initialState(),
      stage: 'input',
      raw: 'x',
      refined: refined(),
      failure: { kind: 'not_authenticated', message: 'claude is logged out' },
    };
    expect(toDraft(state, 'd1', 'r').lastError).toBeUndefined();

    const submit: UiState = { ...atDraft(), failure: { kind: 'not_authenticated', message: 'gh is logged out' } };
    expect(toDraft(submit, 'd1', 'r').lastError).toEqual({
      kind: 'not_authenticated',
      message: 'gh is logged out',
    });
  });

  it('restores a refine failure as an ordinary draft, not a failed submit', () => {
    // End to end: the failure the app was showing when it died must not come back
    // wearing the submit stage's buttons.
    const state: UiState = {
      ...initialState(),
      stage: 'input',
      raw: 'tray icon vanished',
      refined: refined(),
      failure: { kind: 'timeout', message: 'Claude took too long' },
    };
    const after = restore(toDraft(state, 'd1', 'c3lew/Quacket'));

    expect(after.failure).toBeNull();
    expect(after.raw).toBe('tray icon vanished');
  });
});
