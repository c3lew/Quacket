/**
 * The three in-place stages of the capture view. Every one of them is a pure
 * render over `UiState` plus a dispatch — no stage logic lives here.
 */

import { useEffect, useState } from 'react';

import type { ImageAttachment, RefinedDraft, ReportType, SimilarIssue, Stage } from '../../core/types.ts';
import { recoveryOptions, type Failure, type Recovery } from '../../core/ui/reducer.ts';
import { Icon, Spinner, type IconName } from './icons.tsx';
import type { SentEntry } from './session.ts';

// ── Images ──────────────────────────────────────────────────────────────────

/** Bytes are the source of truth; the object URL is a render detail we clean up. */
function useObjectUrl(image: ImageAttachment): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const blob = new Blob([image.bytes as unknown as BlobPart], { type: image.mediaType });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image.bytes, image.mediaType]);
  return url;
}

/**
 * A thumbnail is a button that opens the editor, and it says so at rest: the
 * "Edit" bar is always visible, not revealed on hover. Hover-only affordances
 * fail the moment someone is looking rather than pointing.
 */
function Thumb({
  image,
  index,
  onOpen,
  onRemove,
}: {
  image: ImageAttachment;
  index: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const url = useObjectUrl(image);

  return (
    <div className="thumb">
      <button
        className="thumb-open"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onRemove();
          }
        }}
        aria-label={`Edit screenshot ${index + 1}`}
      >
        {url !== '' && <img src={url} alt="" />}
        <span className="thumb-bar">
          <Icon name="pencil" size={11} />
          Edit
        </span>
        {image.annotated && (
          <span className="thumb-marked">
            <Icon name="check" size={10} />
            Marked
          </span>
        )}
      </button>
      <button className="thumb-remove" onClick={onRemove} aria-label={`Remove screenshot ${index + 1}`}>
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

export function Thumbs({
  images,
  onOpen,
  onRemove,
}: {
  images: ImageAttachment[];
  onOpen: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="thumbs">
      {images.map((image, index) => (
        <Thumb
          key={image.id}
          image={image}
          index={index}
          onOpen={() => onOpen(index)}
          onRemove={() => onRemove(index)}
        />
      ))}
    </div>
  );
}

// ── Capture ─────────────────────────────────────────────────────────────────

export interface CaptureProps {
  raw: string;
  images: ImageAttachment[];
  busy: boolean;
  onEdit: (raw: string) => void;
  onOpenImage: (index: number) => void;
  onRemoveImage: (index: number) => void;
  onAddImage: () => void;
}

export function Capture({ raw, images, busy, onEdit, onOpenImage, onRemoveImage, onAddImage }: CaptureProps) {
  return (
    <>
      <textarea
        className="raw-input"
        autoFocus
        readOnly={busy}
        value={raw}
        placeholder="What broke? Type it however it comes out."
        onChange={(e) => onEdit(e.target.value)}
      />

      <div className="capture-images">
        {/*
          Paste and drag-drop both work, but neither is visible, and a sentence in
          the placeholder teaching them would be the smell rather than the fix.
          This button is the affordance; those two stay as accelerators.
        */}
        <button className="btn ghost add-image" onClick={onAddImage} disabled={busy}>
          <Icon name="image" size={14} />
          Add screenshot
        </button>
        <Thumbs images={images} onOpen={onOpenImage} onRemove={onRemoveImage} />
      </div>
    </>
  );
}

export const Refining = () => (
  <div className="status">
    <Spinner />
    <span>Refining your report…</span>
  </div>
);

// ── Draft ───────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<ReportType, IconName> = { bug: 'bug', feature: 'feature', chore: 'chore' };
const TYPES: ReportType[] = ['bug', 'feature', 'chore'];

/**
 * Reclassifying is one click and costs nothing, which is what makes a
 * misclassification a non-event rather than a reason to start over.
 */
function TypeSwitcher({ value, onChange }: { value: ReportType; onChange: (t: ReportType) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Report type">
      {TYPES.map((type) => (
        <button
          key={type}
          className={type === value ? 'seg on' : 'seg'}
          aria-pressed={type === value}
          onClick={() => onChange(type)}
        >
          <Icon name={TYPE_ICONS[type]} size={13} />
          {type[0]?.toUpperCase()}
          {type.slice(1)}
        </button>
      ))}
    </div>
  );
}

/**
 * Non-blocking and inline, never a modal. Picking one flips the submit button to
 * "Comment on #n" — the consequence is visible on the button, so the card needs
 * no sentence explaining what picking does.
 *
 * Every row also opens: this card asks the user to redirect their report into
 * someone else's issue, and a title plus a one-line reason is not enough to make
 * that call. Without a way to read the thing, the honest answer to the card is
 * always "ignore it" — which is the card failing. #7 makes it explicit: "<= 3
 * candidates, reason each, open-in-browser link".
 *
 * The row is a div rather than one big button because a button cannot contain
 * another one: picking and reading are two different acts and need two controls.
 */
function SimilarCard({
  candidates,
  selected,
  onChoose,
  onOpenIssue,
}: {
  candidates: SimilarIssue[];
  selected: number | null;
  onChoose: (issueNumber: number) => void;
  onOpenIssue: (issueNumber: number) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <div className="similar">
      <h4>
        <Icon name="comment" size={13} />
        Similar open issues
      </h4>
      {candidates.map((issue, i) => (
        <div key={issue.number} className={selected === issue.number ? 'sim-row on' : 'sim-row'}>
          {/* A button's UA text-align is `center` and this one holds two lines of
              prose, so the row's `text-align: left` has to be restated on it. */}
          <button
            className="sim-main"
            style={{ textAlign: 'left' }}
            aria-pressed={selected === issue.number}
            onClick={() => onChoose(issue.number)}
          >
            <span className="sim-title">
              <span className="sim-radio" />
              <span className="num">#{issue.number}</span>
              {issue.title}
            </span>
            <span className="sim-reason">{issue.reason}</span>
          </button>
          <kbd>Ctrl+{i + 1}</kbd>
          {/* Labelled, not a bare icon: "Open" next to an issue title is the same
              idiom as the issue list and the done screen, and it reads at rest. */}
          <button
            className="btn ghost"
            onClick={() => onOpenIssue(issue.number)}
            aria-label={`Open issue #${issue.number} in browser`}
          >
            <Icon name="external" size={12} />
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

function FollowUps({
  questions,
  answers,
  onAnswer,
}: {
  questions: string[];
  answers: string[];
  onAnswer: (index: number, text: string) => void;
}) {
  if (questions.length === 0) return null;

  return (
    <div className="followups">
      {questions.map((question, i) => (
        <label className="qrow" key={question}>
          <span className="qlabel">
            <Icon name="question" size={13} />
            {question}
            <span className="optional">Optional</span>
          </span>
          <input value={answers[i] ?? ''} onChange={(e) => onAnswer(i, e.target.value)} />
        </label>
      ))}
    </div>
  );
}

const RECOVERY_LABELS: Record<Recovery, string> = {
  retry: 'Try again',
  'file-as-is': 'File my raw text instead',
  'file-without-images': 'File without the screenshots',
};

/**
 * The failure matrix, rendered. Which buttons appear is the reducer's call.
 *
 * `stage` is passed because the matrix is keyed on the leg that died, and only
 * the stage knows which one that was — see `recoveryOptions`.
 */
export function ErrorCard({
  failure,
  stage,
  onRecover,
}: {
  failure: Failure;
  stage: Stage;
  onRecover: (recovery: Recovery) => void;
}) {
  return (
    <div className="errorcard">
      <span className="warn-icon">
        <Icon name="warning" size={14} />
      </span>
      <div className="warn-main">
        <span>{failure.message}</span>
        <div className="err-actions">
          {recoveryOptions(failure, stage).map((recovery, i) => (
            <button
              key={recovery}
              className={i === 0 ? 'btn primary' : 'btn'}
              onClick={() => onRecover(recovery)}
            >
              {RECOVERY_LABELS[recovery]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface DraftViewProps {
  raw: string;
  refined: RefinedDraft;
  answers: string[];
  candidates: SimilarIssue[];
  selected: number | null;
  failure: Failure | null;
  stage: Stage;
  onSetType: (type: ReportType) => void;
  onEditTitle: (title: string) => void;
  onEditSection: (index: number, body: string) => void;
  onAnswer: (index: number, text: string) => void;
  onChooseSimilar: (issueNumber: number) => void;
  /**
   * Opens the candidate on GitHub. Required, and deliberately: a similar-issue
   * card whose link does nothing is the card's whole value gone, and an optional
   * prop is exactly how that ships unnoticed. The URL is built where the repo is
   * known — `App`, the same one line the read-only issue list already uses.
   */
  onOpenIssue: (issueNumber: number) => void;
  onRecover: (recovery: Recovery) => void;
}

export function DraftView(props: DraftViewProps) {
  const { refined } = props;

  return (
    <>
      {props.failure !== null && (
        <ErrorCard failure={props.failure} stage={props.stage} onRecover={props.onRecover} />
      )}

      <details className="rawchip">
        <summary>
          <Icon name="chevronRight" size={11} />
          Your original text
        </summary>
        <p>{props.raw}</p>
      </details>

      <TypeSwitcher value={refined.type} onChange={props.onSetType} />

      <label className="field">
        <span>Title</span>
        <input className="title-input" value={refined.title} onChange={(e) => props.onEditTitle(e.target.value)} />
      </label>

      {refined.sections.map((section, index) => (
        <label className="field" key={`${section.heading}-${index}`}>
          {/* file-as-is has no classification, so it has no heading to show. */}
          {section.heading !== '' && <span>{section.heading}</span>}
          <textarea
            className="body-input"
            value={section.body}
            onChange={(e) => props.onEditSection(index, e.target.value)}
          />
        </label>
      ))}

      <FollowUps questions={refined.followUps} answers={props.answers} onAnswer={props.onAnswer} />

      <SimilarCard
        candidates={props.candidates}
        selected={props.selected}
        onChoose={props.onChooseSimilar}
        onOpenIssue={props.onOpenIssue}
      />
    </>
  );
}

// ── Done ────────────────────────────────────────────────────────────────────

export function Done({
  entry,
  recent,
  onOpen,
  onNew,
}: {
  entry: SentEntry | null;
  recent: SentEntry[];
  onOpen: (url: string) => void;
  onNew: () => void;
}) {
  const older = recent.filter((r) => r.url !== entry?.url);

  return (
    <div className="done">
      <span className="done-check">
        <Icon name="check" size={22} />
      </span>
      <strong>
        {entry === null
          ? 'Sent'
          : entry.kind === 'comment'
            ? `Added to issue #${entry.issueNumber}`
            : `Issue #${entry.issueNumber} filed`}
      </strong>
      {entry !== null && (
        <span className="done-sub">
          {entry.title}
          <br />
          {entry.repo}
        </span>
      )}

      <div className="done-actions">
        {entry !== null && (
          <button className="btn" onClick={() => onOpen(entry.url)}>
            <Icon name="external" size={13} />
            Open in browser
          </button>
        )}
        <button className="btn primary" onClick={onNew}>
          <Icon name="plus" size={13} />
          New report
          <kbd>Ctrl+N</kbd>
        </button>
      </div>

      {older.length > 0 && (
        <div className="sent-list">
          <span className="sent-head">Recently sent</span>
          {older.map((sent) => (
            <button className="sent-row" key={sent.url} onClick={() => onOpen(sent.url)}>
              <Icon name={sent.kind === 'comment' ? 'comment' : 'check'} size={12} />
              <span className="num">#{sent.issueNumber}</span>
              <span className="sent-title">{sent.title}</span>
              <Icon name="external" size={12} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
