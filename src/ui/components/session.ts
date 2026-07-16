/**
 * The bridge between the reducer's `UiState` and the two things it deliberately
 * does not own: the persisted `Draft`, and the recent-sent list.
 *
 * Kept pure and out of the components so both directions are testable.
 */

import type {
  Draft,
  ImageAttachment,
  OpenIssue,
  RefinedDraft,
  SubmitResult,
} from '../../core/types.ts';
import type { Action, UiState } from '../../core/ui/reducer.ts';

// ── Similar-issue hygiene ───────────────────────────────────────────────────

/**
 * The last fabrication vector, closed where both halves are in scope.
 *
 * `parseRefined` never sees the candidate list, so it cannot tell an invented
 * issue number from a real one — refine-contract flagged this as the caller's
 * job. Only the composition root has both, so it belongs here.
 *
 * Titles are re-read from the real issue rather than trusted from the model: a
 * number the model got right and a title it got wrong would otherwise render a
 * confident lie on the card the user is deciding against.
 */
export function dropInventedIssues(draft: RefinedDraft, shown: OpenIssue[]): RefinedDraft {
  const real = new Map(shown.map((issue) => [issue.number, issue]));
  return {
    ...draft,
    similarIssues: draft.similarIssues.flatMap((similar) => {
      const actual = real.get(similar.number);
      return actual === undefined ? [] : [{ ...similar, title: actual.title }];
    }),
  };
}

// ── UiState → Draft ─────────────────────────────────────────────────────────

/**
 * Which failures belong on disk.
 *
 * `Draft.lastError` exists for ONE job: land the next summon on a failed
 * SUBMIT's error card (stories 27/28) — including after a crash, which the store
 * materialises into the same shape. A refine failure is live, transient feedback
 * that the user answers by pressing Refine again; persisting it buys nothing and
 * costs the one thing `Draft` cannot express — the stage the failure happened in.
 *
 * Only `UiState` knows that stage, and the machine makes it unambiguous:
 * `refine-failed` always lands on 'input' and `submit-failed` always lands on
 * 'draft', and leaving either stage clears `failure`. So a failure sitting on the
 * draft stage IS a submit failure, and nothing else can be.
 *
 * Sniffing `lastError.kind` instead would look like it worked and quietly not:
 * `GitHubErrorKind` includes `not_authenticated`, so a submit that died on broken
 * `gh` auth is indistinguishable BY KIND from a refine that died on broken CLI
 * auth. Restoring that one to the wrong stage puts [Try again] on the wrong verb
 * and offers [File my raw text instead], which overwrites the refined draft.
 */
const isSubmitFailure = (state: UiState): boolean => state.stage === 'draft';

/**
 * `images` are COPIED: `github.uploadImages` sets `uploadedUrl` in place, and
 * React state must never be mutated behind the reducer's back. The URLs it lands
 * come back through the `images-uploaded` action instead.
 *
 * `repo` is where the draft is GOING, not what it is — pass `NO_REPO` when the
 * user has not chosen one yet. See `shouldSaveDraft`.
 */
export function toDraft(state: UiState, id: string, repo: string): Draft {
  const draft: Draft = {
    id,
    repo,
    raw: state.raw,
    images: state.images.map((image) => ({ ...image })),
    target: state.target,
  };
  if (state.refined !== null) draft.refined = state.refined;
  if (state.answers.length > 0) draft.answers = state.answers;
  if (state.failure !== null && isSubmitFailure(state)) draft.lastError = state.failure;
  return draft;
}

/**
 * A draft with no target chosen yet. `Draft.repo` is a submit-time address, and
 * the empty string is "not addressed yet" — nothing reads it before a submit, and
 * a submit cannot start without a `Repo` in hand anyway.
 */
export const NO_REPO = '';

/**
 * Whether the auto-save should write.
 *
 * From `submit` until its outcome, `DraftStore` owns the draft's fate: `beginSubmit`
 * opens the in-flight bracket and `finishSubmit` records the outcome, so an
 * auto-save in between has nothing to add and does not write.
 *
 * That clause is NOT what keeps the in-flight mark alive, and must never be read
 * as such — it used to be, and that is precisely how the mark got cleared anyway.
 * Stating an invariant about draft.json in a caller that merely CHOOSES not to
 * write protects nothing from the writers that choose to: an image attached
 * mid-flight (paste listens on the document at every stage) went through the
 * store's attach path, which never consults this, and wrote `inFlight: false`
 * straight over it. The rule now lives at the single writer — `DraftStore.write`
 * derives `inFlight` from its own bracket — where a writer cannot fail to consult
 * it. Deleting this line would cost churn, not correctness.
 *
 * 'done' is excluded for a reason of its own, and this one IS load-bearing here
 * because the store cannot see it: a confirmed success already
 * discarded the draft, and re-saving would resurrect the folder the submit just
 * earned the right to delete.
 *
 * So: the auto-save owns the file exactly while the USER owns the draft.
 *
 * The repo is deliberately NOT part of this question, and used to be — a null one
 * skipped the save entirely. But a draft is the user's words; the repo is only
 * where they are eventually sent, and drafts are stored under `<baseDir>/drafts/
 * <id>/`, which never needed one. So "we don't know the address yet" was answered
 * by throwing the letter away: with the repo list unavailable, the user typed into
 * a fully live capture box and NOTHING was persisted — no crash recovery, and no
 * Discard button either, because as far as the app knew there was no draft. That
 * is story 29 ("auto-saved locally FROM THE FIRST KEYSTROKE") inverted, and it
 * bit hardest in #35's gh-auth-lapsed case, where the box is deliberately kept
 * live precisely so the work is not lost.
 */
export const shouldSaveDraft = (state: UiState): boolean => {
  if (state.stage === 'submitting' || state.stage === 'done') return false;
  return state.raw !== '' || state.images.length > 0;
};

/** The URLs an upload actually landed, for `images-uploaded`. */
export const uploadedFrom = (images: ImageAttachment[]): Array<{ id: string; url: string }> =>
  images.flatMap((image) =>
    image.uploadedUrl === undefined ? [] : [{ id: image.id, url: image.uploadedUrl }],
  );

// ── Draft → UiState ─────────────────────────────────────────────────────────

/**
 * Restore replays the draft as ACTIONS rather than seeding state directly.
 *
 * The reducer is the only thing allowed to build a `UiState`, so a restored
 * draft has to arrive the way a live one does. That is not a workaround: it is
 * what guarantees a restored draft can never reach a shape the machine could not
 * have produced on its own.
 */
export function restoreActions(draft: Draft): Action[] {
  const actions: Action[] = [];

  if (draft.raw !== '') actions.push({ type: 'edit-raw', raw: draft.raw });
  for (const image of draft.images) actions.push({ type: 'add-image', image });

  // Everything below only exists once a draft has been refined.
  if (draft.refined === undefined) return actions;

  actions.push({ type: 'refine-ok', draft: draft.refined });

  (draft.answers ?? []).forEach((text, index) => {
    if (text !== '') actions.push({ type: 'answer', index, text });
  });

  if (draft.target.kind === 'comment') {
    actions.push({ type: 'choose-similar', issueNumber: draft.target.issueNumber });
  }

  /*
   * Lands the next summon on the error card — including after a crash, which the
   * store materialises into the same shape as a live failure.
   *
   * `submit-failed` is the right replay for EVERY `lastError` on disk, because
   * `toDraft` only ever persists a submit failure (see `isSubmitFailure`). That
   * is what makes this line honest rather than lucky: it is guarded at the
   * writer, where the stage is still known, instead of guessed at here from a
   * `kind` that cannot tell a broken `gh` auth from a broken CLI auth.
   *
   * The `refined === undefined` return above is the same invariant from the other
   * side: nothing can have failed to submit that was never refined.
   */
  if (draft.lastError !== undefined) {
    actions.push({ type: 'submit-failed', error: draft.lastError });
  }

  return actions;
}

// ── Follow-up answers ───────────────────────────────────────────────────────

/**
 * Whether submitting should spend a second LLM turn folding the answers in.
 *
 * The reducer stores `answers` but nothing consumes them, so without this they
 * are typed and silently dropped — the trap of asking a question and ignoring
 * the reply. Folding on submit closes it with no extra control to explain.
 *
 * Hand-edits veto the fold: turn 2 rewrites the whole draft, so folding after
 * the user edited would throw their words away, and the AI never has the final
 * word. Comparing against the pristine draft is what detects that — `answer` and
 * `choose-similar` leave `refined` untouched, so only a real edit trips it.
 */
export function shouldFoldAnswers(state: UiState, pristine: RefinedDraft | null): boolean {
  if (!state.answers.some((answer) => answer.trim() !== '')) return false;
  if (pristine === null || state.refined === null) return false;
  return JSON.stringify(state.refined) === JSON.stringify(pristine);
}

// ── Recent-sent list ────────────────────────────────────────────────────────

export interface SentEntry {
  issueNumber: number;
  title: string;
  url: string;
  /** A comment and a new issue read differently on the done screen. */
  kind: 'new-issue' | 'comment';
  repo: string;
}

/** Long enough to prove "it went somewhere", short enough to stay a glance. */
export const RECENT_MAX = 5;

/**
 * Newest first, deduped by url — a retry that finally succeeds must not leave
 * the same issue in the list twice.
 */
export const pushRecent = (list: SentEntry[], entry: SentEntry): SentEntry[] =>
  [entry, ...list.filter((e) => e.url !== entry.url)].slice(0, RECENT_MAX);

export const sentEntry = (
  result: SubmitResult,
  state: UiState,
  repo: string,
): SentEntry | null => {
  if (state.refined === null) return null;
  return {
    issueNumber: result.issueNumber,
    title: state.refined.title,
    url: result.url,
    kind: state.target.kind,
    repo,
  };
};
