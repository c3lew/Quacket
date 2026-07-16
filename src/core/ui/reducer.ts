/**
 * The Palette's stage machine, as a pure reducer.
 *
 * No DOM, no React, no IO. Every side effect the machine wants — spawning a
 * refine, spawning a submit, firing an OS notification, hiding to tray — comes
 * back as DATA in `effects`, so the whole thing is testable with zero mocks.
 * The React layer is a dumb renderer that dispatches actions and performs the
 * effects it is handed.
 */

import { TITLE_MAX_CHARS } from '../refine/schema.ts';
import { imageRefPattern } from '../types.ts';
import type {
  Draft,
  ImageAttachment,
  RefinedDraft,
  ReportType,
  SimilarIssue,
  Stage,
  SubmitResult,
  SubmitTarget,
} from '../types.ts';

// ── Constants the prototype pinned ──────────────────────────────────────────

/** Palette width at rest. */
export const PALETTE_WIDTH = 620;
/** Widened while the body has morphed into the annotation editor. */
export const ANNOTATE_WIDTH = 820;
/** The similar-issue card stays glanceable; the refiner may offer more. */
export const MAX_SIMILAR = 3;

// ── State ───────────────────────────────────────────────────────────────────

/**
 * Present exactly while the body has morphed into the annotation editor.
 *
 * Deliberately just the index. The editor owns tool selection and its own
 * keyboard (`ui/annotate/model.ts`), because only it can turn a keypress into
 * flattened bytes. Mirroring `tool` here would be a second copy of state the
 * reducer cannot act on and nothing reads.
 */
export interface Editing {
  /** Index into `images`. */
  index: number;
}

/**
 * Reuses the persisted shape so a restored draft's `lastError` IS a Failure —
 * the error card after a crash and after a live failure are the same card.
 */
export type Failure = NonNullable<Draft['lastError']>;

/** The recovery buttons a failure offers. The failure matrix, as a value. */
export type Recovery = 'retry' | 'file-as-is' | 'file-without-images';

export interface UiState {
  stage: Stage;
  /** Hidden to tray. Work continues regardless — Esc never cancels. */
  hidden: boolean;
  width: number;
  raw: string;
  images: ImageAttachment[];
  refined: RefinedDraft | null;
  /** Index-aligned with `refined.followUps`; blanks are skipped questions. */
  answers: string[];
  target: SubmitTarget;
  editing: Editing | null;
  failure: Failure | null;
  result: SubmitResult | null;
}

export const initialState = (): UiState => ({
  stage: 'input',
  hidden: false,
  width: PALETTE_WIDTH,
  raw: '',
  images: [],
  refined: null,
  answers: [],
  target: { kind: 'new-issue' },
  editing: null,
  failure: null,
  result: null,
});

// ── Actions & effects ───────────────────────────────────────────────────────

export type Action =
  | { type: 'summon' }
  | { type: 'esc' }
  | { type: 'edit-raw'; raw: string }
  | { type: 'add-image'; image: ImageAttachment }
  | { type: 'remove-image'; index: number }
  | { type: 'open-image'; index: number }
  | { type: 'annotate-done'; bytes: Uint8Array }
  | { type: 'annotate-cancel' }
  | { type: 'refine' }
  | { type: 'refine-ok'; draft: RefinedDraft }
  | { type: 'refine-failed'; error: Failure }
  | { type: 'file-as-is' }
  | { type: 'set-type'; reportType: ReportType }
  | { type: 'edit-title'; title: string }
  | { type: 'edit-section'; index: number; body: string }
  | { type: 'answer'; index: number; text: string }
  | { type: 'choose-similar'; issueNumber: number }
  | { type: 'back-to-input' }
  | { type: 'submit' }
  | { type: 'images-uploaded'; uploaded: Array<{ id: string; url: string }> }
  | { type: 'submit-ok'; result: SubmitResult }
  | { type: 'submit-failed'; error: Failure }
  | { type: 'file-without-images' }
  | { type: 'discard' }
  | { type: 'new-report' };

export type Effect =
  | { type: 'refine' }
  | { type: 'submit' }
  | { type: 'notify'; message: string }
  | { type: 'hide' }
  /** Deletes the draft folder. The ONLY thing in the app that may. */
  | { type: 'discard-draft' };

export interface Next {
  state: UiState;
  effects: Effect[];
}

// ── Derivations ─────────────────────────────────────────────────────────────

/**
 * The failure matrix.
 *
 * Keyed on the STAGE the failure landed on, not on its kind. The spec's matrix
 * is written per leg — "LLM refine failure -> [Retry] / [File as-is]", "image
 * upload failure -> [Retry] / [File without images]", "issue creation failure ->
 * [Retry]" — and only the stage says which leg died.
 *
 * Kind alone cannot: `GitHubErrorKind` includes `not_authenticated`, so a submit
 * that died on broken `gh` auth carries the same kind as a refine that died on
 * broken CLI auth. Keying on kind offered that submit [File my raw text
 * instead], which OVERWRITES the refined draft the user is standing on — a
 * destructive button on a card whose whole job is to be a safe way out.
 *
 * So: the input stage is the refine leg and gets the escape hatch; the draft
 * stage is the submit leg, where a refined draft already exists and "file my raw
 * text instead" is never an offer worth making.
 */
export const recoveryOptions = (failure: Failure, stage: Stage): Recovery[] => {
  // The LLM is an enhancement, never a gatekeeper.
  if (stage === 'input') return ['retry', 'file-as-is'];
  return failure.kind === 'upload_failed' ? ['retry', 'file-without-images'] : ['retry'];
};

/** Something the user would mind losing — i.e. something Discard has to exist for. */
export const hasDraft = (state: UiState): boolean =>
  state.raw.trim() !== '' || state.images.length > 0 || state.refined !== null;

/**
 * Discard is offered exactly where the draft is at rest and the user owns it.
 * Mid-refine and mid-flight it is not: a submit in flight is already going to
 * write its own outcome, and yanking the folder out from under it would race the
 * store for the file. Esc-then-discard once it settles costs one keystroke.
 */
export const canDiscard = (state: UiState): boolean =>
  (state.stage === 'input' || state.stage === 'draft') && hasDraft(state);

/** Non-blocking, inline, never a modal, and never more than a glance. */
export const similarCandidates = (state: UiState): SimilarIssue[] =>
  (state.refined?.similarIssues ?? []).slice(0, MAX_SIMILAR);

/** "Comment on #n" vs "Submit issue" — the submit button's own semantics. */
export const isCommenting = (state: UiState): boolean => state.target.kind === 'comment';

/** New report is gated on the done screen: the draft slot frees only on success. */
export const canStartNewReport = (state: UiState): boolean => state.stage === 'done';

// ── Reducer ─────────────────────────────────────────────────────────────────

const only = (state: UiState): Next => ({ state, effects: [] });

/** Bad news reaches the user even when the window is hidden. Success is silent. */
const withNotice = (state: UiState, failure: Failure): Next => ({
  state,
  effects: state.hidden ? [{ type: 'notify', message: failure.message }] : [],
});

const closeEditor = (state: UiState): UiState => ({
  ...state,
  editing: null,
  width: PALETTE_WIDTH,
});

/**
 * What an image BECOMES when the editor flattens annotations onto it.
 *
 * The editor re-encodes through a canvas and always hands back PNG, so a
 * flattened JPEG stops being a JPEG. Keeping the old mediaType would make it a
 * lie that spreads: the asset gets named .jpg on GitHub, base64'd to the model
 * as image/jpeg, and — the one that destroys work — named `img_1.jpg` in the
 * draft manifest while `DraftStore.fileFor` derives the name from mediaType.
 *
 * Exported because the rule has TWO callers and may only have one definition.
 * The reducer applies it to state; `App.tsx` needs the identical attachment
 * BEFORE dispatching, because the bytes must reach the disk first — the same
 * ordering intake obeys. Restating "annotated => PNG + annotated:true" in the
 * .tsx would be two sources of truth for one rule, and the copy that drifts is
 * the one that silently renames a file out from under the manifest.
 */
export const flattenedImage = (image: ImageAttachment, bytes: Uint8Array): ImageAttachment => ({
  ...image,
  bytes,
  mediaType: 'image/png',
  annotated: true,
});

/**
 * `TITLE_MAX_CHARS` is imported rather than restated. It is one rule — types.ts's
 * "prefix-free single line, <= ~70 chars" — and it was living as two constants
 * that happened to agree: the number the schema ASKS the model for, and the
 * number file-as-is enforces when there is no model. Two constants for one rule
 * is a rule that is one careless edit away from silently becoming two.
 */
const firstLine = (raw: string): string =>
  (raw.trim().split('\n')[0] ?? '').trim().slice(0, TITLE_MAX_CHARS);

export function reduce(state: UiState, action: Action): Next {
  switch (action.type) {
    // ── Window ──────────────────────────────────────────────────────────────

    /** Re-summoning shows whatever is live — mid-flight submits included. */
    case 'summon':
      return only({ ...state, hidden: false });

    /**
     * Esc hides to tray at every stage and cancels NOTHING: a submit in flight
     * keeps going and the machine stays in 'submitting'. The one nested surface
     * with its own Esc is the annotation editor, where Esc means Cancel.
     */
    case 'esc':
      return state.editing !== null
        ? only(closeEditor(state))
        : { state: { ...state, hidden: true }, effects: [{ type: 'hide' }] };

    // ── Input ───────────────────────────────────────────────────────────────

    case 'edit-raw':
      return only({ ...state, raw: action.raw });

    case 'add-image':
      return only({ ...state, images: [...state.images, action.image] });

    case 'remove-image':
      return only({
        ...state,
        images: state.images.filter((_, i) => i !== action.index),
      });

    // ── Annotation morph ────────────────────────────────────────────────────

    /** Clicking a thumbnail morphs the body into the editor and widens the window. */
    case 'open-image':
      return state.images[action.index] === undefined
        ? only(state)
        : only({
            ...state,
            editing: { index: action.index },
            width: ANNOTATE_WIDTH,
          });

    /** Done FLATTENS the annotation onto the image — destructive in v1. */
    case 'annotate-done': {
      const editing = state.editing;
      if (editing === null) return only(state);
      return only(
        closeEditor({
          ...state,
          images: state.images.map((img, i) =>
            i === editing.index ? flattenedImage(img, action.bytes) : img,
          ),
        }),
      );
    }

    /** Cancel discards the edits: the image is untouched. */
    case 'annotate-cancel':
      return only(closeEditor(state));

    // ── Refine ──────────────────────────────────────────────────────────────

    case 'refine':
      return state.stage !== 'input' || state.raw.trim() === ''
        ? only(state)
        : {
            state: { ...state, stage: 'refining', failure: null },
            effects: [{ type: 'refine' }],
          };

    case 'refine-ok':
      return only({
        ...state,
        stage: 'draft',
        refined: action.draft,
        answers: action.draft.followUps.map(() => ''),
        target: { kind: 'new-issue' },
        failure: null,
      });

    /** Banner over the input, offering [Retry] / [File as-is]. */
    case 'refine-failed':
      return withNotice({ ...state, stage: 'input', failure: action.error }, action.error);

    /**
     * The escape hatch: the LLM is an enhancement, never a gatekeeper. Raw text
     * becomes the body verbatim and the first line becomes an editable title.
     * The section carries no heading because nothing here was classified — a
     * heading would be the fabrication the no-fabrication rule forbids.
     *
     * `chore` for the same reason, one level up. This is the ONE path where the
     * tool knows for a fact it has no classification — the classifier is exactly
     * what failed — so it must not assert one. Type is not free-floating
     * metadata: `github.ts` turns it into a real repo label, and 'bug' would
     * stamp `bug` on a report nothing ever read. `chore` is the only member of
     * ReportType that applies no label, so it is how "I don't know" is spelled in
     * a type that cannot say null. The user reclassifies in one click if they do
     * know; until then Quacket asserts nothing to their repo.
     */
    case 'file-as-is':
      return state.raw.trim() === ''
        ? only(state)
        : only({
            ...state,
            stage: 'draft',
            refined: {
              type: 'chore',
              title: firstLine(state.raw),
              sections: [{ heading: '', body: state.raw.trim() }],
              followUps: [],
              similarIssues: [],
            },
            answers: [],
            failure: null,
          });

    // ── Draft ───────────────────────────────────────────────────────────────

    /** One-keystroke reclassification: a misclassification costs nothing. */
    case 'set-type':
      return state.refined === null
        ? only(state)
        : only({ ...state, refined: { ...state.refined, type: action.reportType } });

    case 'edit-title':
      return state.refined === null
        ? only(state)
        : only({ ...state, refined: { ...state.refined, title: action.title } });

    case 'edit-section': {
      const refined = state.refined;
      if (refined === null || refined.sections[action.index] === undefined) return only(state);
      return only({
        ...state,
        refined: {
          ...refined,
          sections: refined.sections.map((s, i) =>
            i === action.index ? { ...s, body: action.body } : s,
          ),
        },
      });
    }

    case 'answer':
      return only({
        ...state,
        answers: state.answers.map((a, i) => (i === action.index ? action.text : a)),
      });

    /**
     * Choosing a candidate switches submit semantics to "Comment on #n";
     * choosing the selected one again switches back. Ignoring it files a new
     * issue — the card never blocks.
     */
    case 'choose-similar':
      return only({
        ...state,
        target:
          state.target.kind === 'comment' && state.target.issueNumber === action.issueNumber
            ? { kind: 'new-issue' }
            : { kind: 'comment', issueNumber: action.issueNumber },
      });

    /**
     * `failure` is cleared because a failure BELONGS to the stage that produced
     * it. Carrying a dead submit's error back to the input stage renders it
     * against the refine recovery matrix, so [Try again] would silently mean
     * "re-refine" on a card the user read as "re-submit" — and it is what lets a
     * submit failure and a refine failure occupy the same shape, which is the
     * ambiguity `session.ts` relies on being impossible.
     */
    case 'back-to-input':
      return only({ ...state, stage: 'input', failure: null });

    // ── Submit ──────────────────────────────────────────────────────────────

    /** Also the [Retry] action: uploaded URLs already live on the images. */
    case 'submit':
      return state.stage !== 'draft'
        ? only(state)
        : {
            state: { ...state, stage: 'submitting', failure: null },
            effects: [{ type: 'submit' }],
          };

    /** Recorded mid-flight so a later [Retry] reuses the blobs instead of re-uploading. */
    case 'images-uploaded': {
      const urls = new Map(action.uploaded.map((u) => [u.id, u.url]));
      return only({
        ...state,
        images: state.images.map((img) => {
          const url = urls.get(img.id);
          return url === undefined ? img : { ...img, uploadedUrl: url };
        }),
      });
    }

    /** The done screen IS the confirmation. Silent even when hidden. */
    case 'submit-ok':
      return only({ ...state, stage: 'done', result: action.result, failure: null });

    /** The error card. The next summon lands here whether or not we notified. */
    case 'submit-failed':
      return withNotice({ ...state, stage: 'draft', failure: action.error }, action.error);

    /**
     * Dropping the images can drop the whole report: a section whose only
     * content was an image ref renders to nothing (github.ts judges emptiness
     * AFTER stripping), so a draft where EVERY section was image-only would file
     * as a title over an empty body — the user's actual words thrown away.
     *
     * The floor is the raw dump. It is the user's own writing, so putting it in
     * the body cannot violate the no-fabrication rule — that rule forbids
     * INVENTING, not shipping unpolished — and it is the same escape-hatch
     * semantics file-as-is already has (empty heading, verbatim body). The
     * refined title and type survive: they were derived from real input and the
     * user has already seen and could edit them.
     *
     * Decided here and not in renderBody because the renderer dropping empty
     * sections is CORRECT — this is a product floor, and floors belong in the
     * reducer (it is also the only place that still knows `raw`).
     */
    case 'file-without-images': {
      const refined = state.refined;
      const allImageOnly =
        refined !== null &&
        refined.sections.every((s) => s.body.replace(imageRefPattern(), '').trim() === '');
      return {
        state: {
          ...state,
          images: [],
          stage: 'submitting',
          failure: null,
          ...(allImageOnly
            ? { refined: { ...refined, sections: [{ heading: '', body: state.raw.trim() }] } }
            : {}),
        },
        effects: [{ type: 'submit' }],
      };
    }

    /**
     * The ONLY deliberate way to lose work, and the only thing in the machine
     * that emits `discard-draft`.
     *
     * The inverse is the guarantee that matters: nothing else — not Esc, not
     * clearing the textarea, not a crash, not a failed submit — may reach this
     * effect. That is why the reset is spelled out here rather than routed
     * through `new-report`, which is gated on the done screen precisely because
     * a successful submit has already freed the slot.
     */
    case 'discard':
      return canDiscard(state)
        ? {
            state: { ...initialState(), hidden: state.hidden },
            effects: [{ type: 'discard-draft' }],
          }
        : only(state);

    /** Gated on the done screen — the draft slot frees only on confirmed success. */
    case 'new-report':
      return state.stage !== 'done'
        ? only(state)
        : only({ ...initialState(), hidden: state.hidden });
  }
}
