/** Shared vocabulary. Every core module speaks these types and nothing wider. */

// ── Report ──────────────────────────────────────────────────────────────────

export type ReportType = 'bug' | 'feature' | 'chore';

/**
 * A section the refiner actually had information for.
 *
 * The no-fabrication rule is structural, not stylistic: a section with no real
 * information is ABSENT from this array. There is deliberately no empty-body or
 * "unknown" representation to fall back on — you cannot express a fabricated
 * section in this type.
 */
export interface DraftSection {
  /** e.g. 'Repro steps', 'Expected', 'Actual', 'Environment', 'Problem', 'What'. */
  heading: string;
  /** Markdown. May contain image placeholders (see IMAGE_REF_SCHEME). */
  body: string;
}

export interface SimilarIssue {
  number: number;
  title: string;
  /** One line, from the refiner, on why it looks similar. */
  reason: string;
}

export interface RefinedDraft {
  type: ReportType;
  /** Prefix-free single line, <= ~70 chars, English. */
  title: string;
  sections: DraftSection[];
  /** One batch, all skippable. */
  followUps: string[];
  /** Up to a few; never blocking. */
  similarIssues: SimilarIssue[];
}

/**
 * Refine happens before upload, so the model cannot know an image's final URL.
 * It references images by the id we handed it; the submission pipeline rewrites
 * these to SHA-pinned URLs once upload succeeds, and "File without images"
 * strips them. Markdown-shaped so an un-rewritten draft still renders sanely.
 *
 *   ![screenshot](quacket-image:img_1)
 */
export const IMAGE_REF_SCHEME = 'quacket-image:';

export const imageRef = (id: string): string => `${IMAGE_REF_SCHEME}${id}`;

// ── Attachments ─────────────────────────────────────────────────────────────

export interface ImageAttachment {
  /** Stable across annotation and retries; what IMAGE_REF_SCHEME points at. */
  id: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg';
  /** True once the user has flattened annotations onto it (v1 is destructive). */
  annotated: boolean;
  /**
   * Set once committed to the assets branch. Survives a failed submit so a retry
   * reuses the blob instead of re-uploading it.
   */
  uploadedUrl?: string;
}

// ── Providers ───────────────────────────────────────────────────────────────

export type ProviderId = 'claude' | 'codex';

export interface ModelInfo {
  /** Passed verbatim to --model / -m. */
  id: string;
  label: string;
  /** Per-model, never per-provider. Empty means the model takes no effort flag. */
  efforts: string[];
}

export interface ProviderCapabilities {
  provider: ProviderId;
  /** Part of the cache key — a CLI upgrade invalidates the enumeration. */
  cliVersion: string;
  /** Part of the cache key; null when unauthenticated. */
  account: string | null;
  models: ModelInfo[];
}

/** The whole error surface the UI has to speak. Nothing leaks past this. */
export type ErrorKind =
  | 'not_authenticated'
  | 'model_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    /** Plain language, shown to the user as-is. */
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

export interface Repo {
  /** 'owner/name'. */
  nameWithOwner: string;
  isPrivate: boolean;
}

export interface OpenIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
}

/** What a submit resolves to. */
export type SubmitTarget =
  | { kind: 'new-issue' }
  | { kind: 'comment'; issueNumber: number };

export interface SubmitResult {
  url: string;
  issueNumber: number;
}

// ── Draft ───────────────────────────────────────────────────────────────────

/** Auto-saved from the first keystroke; deleted only on confirmed success. */
export interface Draft {
  id: string;
  repo: string;
  raw: string;
  images: ImageAttachment[];
  refined?: RefinedDraft;
  /** Answers to followUps, index-aligned; blanks are skipped questions. */
  answers?: string[];
  target: SubmitTarget;
  /** Set when a submit failed, so the next summon lands on the error card. */
  lastError?: { kind: ErrorKind | 'upload_failed' | 'create_failed'; message: string };
}

// ── UI stages ───────────────────────────────────────────────────────────────

/** Matches the winning capture-window prototype. */
export type Stage = 'input' | 'refining' | 'draft' | 'submitting' | 'done';

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * Exactly five, and autostart is NOT one of them: the HKCU Run key is the single
 * source of truth for that and is read live. Output language is hardcoded English.
 */
export interface Settings {
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  hotkey: string;
  lastRepo: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'claude',
  model: null,
  effort: null,
  hotkey: 'CmdOrCtrl+Shift+Q',
  lastRepo: null,
};
