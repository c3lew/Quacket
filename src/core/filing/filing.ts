/**
 * The Filing transaction: everything between a final report and a durable
 * receipt, in one module.
 *
 * A submit used to be a pipeline the CALLER assembled — open a bracket on the
 * draft store, upload images, mutate the draft with their URLs, create the
 * issue, close the bracket, delete the folder — and every caller had to know
 * that order. It only had to be got wrong once for GitHub to accept a report
 * that Quacket then reported as failed, which is the one failure a user cannot
 * recover from without opening GitHub themselves.
 *
 * So the order lives here, and the interface is one verb:
 *
 *   file({ kind: 'new', draft, repo })                 file this report
 *   file({ kind: 'resume', filingId, decision })       finish that one
 *
 * The guarantees it buys, in the order they happen:
 *
 *   1. IDENTITY FIRST. A Filing gets a stable, opaque id before GitHub is asked
 *      to write anything, and that id rides along in the remote body as a hidden
 *      HTML comment. Nothing visible, no branding, no footer — but enough for a
 *      later run to find the exact report it created rather than guess from a
 *      title. (Reconciliation itself is the next ticket; the marker it needs has
 *      to be written by every filing from now on, so it lands here.)
 *   2. OWNERSHIP. The draft directory is MOVED into the Filing workspace by one
 *      rename. The report is frozen at that instant: later typing and later
 *      screenshots cannot change what is already being written.
 *   3. TERMINAL SUCCESS. `file` resolves only after the receipt is durable on
 *      disk. Local cleanup runs afterwards and can fail as loudly as it likes —
 *      it can never turn a filed report back into a retryable failure, because
 *      by then success is a fact on disk rather than a value in flight.
 *
 * Layout, one folder per Filing:
 *
 *   <baseDir>/filings/<id>/filing.json   versioned snapshot, atomically rewritten
 *   <baseDir>/filings/<id>/draft/        the whole draft directory, renamed in
 *
 * These folders are NOT drafts and do not consume the single-draft slot: a
 * report whose cleanup failed, or whose outcome is still unknown, sits here
 * while the user captures the next one.
 *
 * Images cannot use GitHub's drag-and-drop attachment flow (that endpoint is
 * cookie-only; a `gh` token is rejected — see docs/research/github-issue-image-
 * attachment.md). Instead each image is committed to an orphan `quacket-assets`
 * branch in the target repo via the Contents API and referenced by a SHA-pinned
 * URL, so the link is immutable and asset visibility is exactly repo visibility.
 */

import { readDraftDir, type DraftStore } from '../drafts/store.ts';
import { joinPath, type FileStore } from '../files.ts';
import { createGh, GitHubError, lastLine, parseJson, type GitHubErrorKind } from '../github/gh.ts';
import type { ProcessRunner } from '../runner.ts';
import {
  imageRefPattern,
  type Draft,
  type ImageAttachment,
  type RefinedDraft,
  type Repo,
  type ReportType,
  type SubmitResult,
  type SubmitTarget,
} from '../types.ts';

// ── The interface ───────────────────────────────────────────────────────────

/** What a terminal Filing resolved to. Durable before the caller ever sees it. */
export interface FilingReceipt extends SubmitResult {
  filingId: string;
}

/**
 * A user-level decision, and deliberately nothing lower.
 *
 * The caller may say "file what I captured" or "file it without the
 * screenshots". It may not say "re-upload image 2" or "skip the label lookup":
 * which steps to redo is Filing's judgment, and exposing it would put the
 * ordering back in the caller where it started.
 */
export type FilingDecision = 'as-captured' | 'without-images';

/**
 * BOTH variants carry the decision, and that is not symmetry for its own sake.
 * [File without images] is offered on an upload failure, which normally means a
 * Filing already exists — but "normally" is the word defects hide behind. A
 * `new` command that could not express the decision would quietly file WITH
 * images the moment that assumption broke, and neither side of the joint would
 * have a test.
 */
export type FilingCommand =
  | { kind: 'new'; draft: Draft; repo: Repo; decision: FilingDecision }
  | { kind: 'resume'; filingId: string; decision: FilingDecision };

/**
 * A PRE-terminal failure. It carries the Filing id, because the only safe way to
 * try again is to resume the same Filing — a fresh one would be a second report.
 *
 * Nothing that happens after the receipt is durable can escape as one of these.
 */
export class FilingError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    /** Plain language; the UI shows this as-is. */
    message: string,
    readonly filingId: string,
  ) {
    super(message);
    this.name = 'FilingError';
  }
}

// ── Durable state ───────────────────────────────────────────────────────────

/**
 * The diagnostic surface: what a Filing is, where it was going, and what last
 * went wrong — enough to explain an interrupted submission from disk alone.
 *
 * What it deliberately does NOT hold: any `gh` stderr detail, any process
 * environment, any token. `sanitize` below is the only way a failure gets in.
 */
interface Snapshot {
  version: 1;
  id: string;
  state: 'filing' | 'filed' | 'failed';
  /** Where it is going. `isPrivate` too: it decides how screenshots render. */
  repo: string;
  isPrivate: boolean;
  target: SubmitTarget;
  createdAt: string;
  updatedAt: string;
  /**
   * Only ever `'pending'`, and deliberately not a two-valued flag: a Filing
   * whose cleanup finished has no snapshot at all, because the snapshot lived in
   * the directory cleanup removed. So a snapshot ON DISK that carries a receipt
   * IS the cleanup queue, and this names that rather than leaving it implied.
   */
  cleanup: 'pending';
  receipt?: FilingReceipt;
  /** A REMOTE failure. Sanitized: plain-language message only, never stderr. */
  lastFailure?: { kind: GitHubErrorKind; message: string };
  /**
   * A LOCAL failure, kept apart from `lastFailure` on purpose. Squeezing a
   * failed `remove` into a `GitHubErrorKind` would make one field mean two
   * unrelated things, and make a disk problem read as a GitHub one.
   */
  cleanupFailure?: { message: string };
}

type FiledSnapshot = Snapshot & { receipt: FilingReceipt };

const SNAPSHOT_JSON = 'filing.json';
const DRAFT_SUBDIR = 'draft';

// ── GitHub write constants ──────────────────────────────────────────────────

const ASSETS_BRANCH = 'quacket-assets';
const ASSETS_DIR = '.quacket/assets';

/** bug -> `bug`, feature -> `enhancement`, chore -> nothing. */
const LABEL_FOR: Record<ReportType, string | null> = {
  bug: 'bug',
  feature: 'enhancement',
  chore: null,
};

const ASSETS_README = [
  '# Quacket assets',
  '',
  'Images embedded in issues filed from this repo. Each file is referenced by',
  'commit SHA, so deleting this branch breaks the images in those issues.',
  '',
].join('\n');

/**
 * The Filing identity, as it appears in the remote body.
 *
 * An HTML comment renders as nothing at all on GitHub, which is the whole
 * requirement: the report has to read as the user's, not as tool output. It is
 * still exact text, so a later lookup can match it rather than fuzzily
 * comparing titles — the difference between "this is the report I filed" and "a
 * report that looks like mine".
 */
export const FILING_MARKER = 'quacket-filing';

export const filingMarker = (id: string): string => `<!-- ${FILING_MARKER}: ${id} -->`;

/** Chunked because `String.fromCharCode(...bytes)` blows the stack on real PNGs. */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/**
 * An opaque Filing identity: 128 random bits, hex.
 *
 * Deliberately NOT `crypto.randomUUID()`, which Chromium gates behind a secure
 * context. Quacket's renderer is served from `tauri.localhost`, which *should*
 * qualify — and "should, per the docs" is exactly the class of assumption this
 * codebase keeps getting caught by live. `getRandomValues` carries no such gate,
 * exists in both the WebView and Node, and this is one line.
 */
const randomFilingId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `fil_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const kindOf = (error: unknown): GitHubErrorKind =>
  error instanceof GitHubError ? error.kind : 'create_failed';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not file this report.';

// ── The module ──────────────────────────────────────────────────────────────

export interface FilingDeps {
  runner: ProcessRunner;
  files: FileStore;
  /** Filing takes ownership from it; nothing else here touches drafts. */
  drafts: DraftStore;
  baseDir: string;
  /** Injected so asset filenames — and therefore argv — are deterministic in tests. */
  now?: () => Date;
  /** Injected so the Filing identity is deterministic in tests. */
  newId?: () => string;
}

export function createFiling({ runner, files, drafts, baseDir, ...options }: FilingDeps) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomFilingId;
  const gh = createGh(runner);

  const root = joinPath(baseDir, 'filings');
  const dirFor = (id: string): string => joinPath(root, id);
  const draftDir = (id: string): string => joinPath(dirFor(id), DRAFT_SUBDIR);
  const stamp = (): string => now().toISOString();

  // ── Durable snapshot ──────────────────────────────────────────────────────

  /**
   * Rename over the previous snapshot, exactly like `DraftStore.write`: a crash
   * mid-write can leave a stale snapshot but never a torn one, so there is no
   * state in which the Filing's own record of itself is unreadable.
   */
  const persist = async (snapshot: Snapshot): Promise<void> => {
    const file = joinPath(dirFor(snapshot.id), SNAPSHOT_JSON);
    const tmp = `${file}.tmp`;
    await files.writeText(tmp, JSON.stringify(snapshot));
    await files.rename(tmp, file);
  };

  const loadSnapshot = async (id: string): Promise<Snapshot> => {
    const text = await files.readText(joinPath(dirFor(id), SNAPSHOT_JSON));
    const gone = () =>
      new FilingError('create_failed', 'This report is no longer on this computer.', id);
    if (text === null) throw gone();
    try {
      return JSON.parse(text) as Snapshot;
    } catch {
      // Unreadable is not the same as absent, but the safe action is: report the
      // Filing, and never create remotely on a guess about what it said.
      throw gone();
    }
  };

  /**
   * Identity, then a durable record of it, then ownership — and only then the
   * first byte to GitHub.
   *
   * The snapshot is written BEFORE the handoff rather than after, so that every
   * failure in here leaves the draft exactly where it was: in the draft slot,
   * with its screenshots, still the user's. Nothing has reached GitHub yet, so
   * there is no ambiguity worth preserving.
   *
   * Which is why a failure here throws a plain `GitHubError` and NOT a
   * `FilingError`: a `FilingError` names a Filing worth resuming, and there is
   * not one. The caller retries as a new Filing, which is correct.
   */
  const begin = async (draft: Draft, repo: Repo): Promise<Snapshot> => {
    const id = newId();
    const snapshot: Snapshot = {
      version: 1,
      id,
      state: 'filing',
      repo: repo.nameWithOwner,
      isPrivate: repo.isPrivate,
      target: draft.target,
      createdAt: stamp(),
      updatedAt: stamp(),
      cleanup: 'pending',
    };

    try {
      await files.mkdirp(dirFor(id));
      await persist(snapshot);
      await drafts.handoff(draft, draftDir(id));
    } catch {
      // Best effort: an abandoned workspace holds no receipt and never reached
      // GitHub, so it is debris rather than evidence.
      try {
        await files.remove(dirFor(id));
      } catch {
        // Leaving debris beats masking the real failure below.
      }
      throw new GitHubError('create_failed', 'Could not start filing this report.');
    }
    return snapshot;
  };

  // ── Assets ────────────────────────────────────────────────────────────────

  const assetPath = (image: ImageAttachment): string => {
    const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const time = now().toISOString().replace(/[:.]/g, '-');
    return `${ASSETS_DIR}/${time}-${image.id}.${ext}`;
  };

  /**
   * Public repos: raw URLs are anonymous, so camo proxies them and the image
   * renders inline. Private repos: camo has no credentials, so an inline embed
   * would render broken for everyone — a blob link is the only honest option.
   */
  const assetUrl = (repo: Repo, sha: string, path: string): string =>
    repo.isPrivate
      ? `https://github.com/${repo.nameWithOwner}/blob/${sha}/${path}`
      : `https://raw.githubusercontent.com/${repo.nameWithOwner}/${sha}/${path}`;

  /** Creates the orphan branch (a commit with no parents) the first time only. */
  const ensureAssetsBranch = async (nameWithOwner: string): Promise<void> => {
    const existing = await gh.run(['api', `repos/${nameWithOwner}/git/ref/heads/${ASSETS_BRANCH}`]);
    if (existing.exitCode === 0) return;

    const failed = 'Could not create the image branch in this repo.';
    // The trees API inlines text blobs, so the README needs no separate blob call.
    const tree = await gh.run(
      ['api', '--method', 'POST', `repos/${nameWithOwner}/git/trees`, '--input', '-'],
      JSON.stringify({
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: ASSETS_README }],
      }),
    );
    /*
     * A repo with no commits refuses the whole Git Data API with this 409 (live:
     * `gh: Git Repository is empty. (HTTP 409)`). The Contents API would work —
     * verified — but on an empty repo the branch it creates becomes the repo's
     * DEFAULT branch, leaving the user's brand-new project fronted by a Quacket
     * assets README. That is exactly the pollution the label rules forbid, so
     * the honest move is to not attach: this error routes to the failure matrix,
     * where [File without images] still files the report.
     */
    if (tree.exitCode !== 0 && /repository is empty/i.test(tree.stderr)) {
      throw new GitHubError(
        'upload_failed',
        'This repo has no commits yet, so images cannot be attached. File without images, or push a first commit and retry.',
      );
    }
    if (tree.timedOut) {
      throw new GitHubError('upload_failed', `${failed} GitHub took too long to respond.`);
    }
    if (tree.exitCode !== 0) throw new GitHubError('upload_failed', failed, tree.stderr.trim());

    const commit = await gh.ok(
      'upload_failed',
      failed,
      ['api', '--method', 'POST', `repos/${nameWithOwner}/git/commits`, '--input', '-'],
      JSON.stringify({
        message: 'Create Quacket assets branch',
        tree: (JSON.parse(tree.stdout) as { sha: string }).sha,
        parents: [],
      }),
    );
    await gh.ok(
      'upload_failed',
      failed,
      ['api', '--method', 'POST', `repos/${nameWithOwner}/git/refs`, '--input', '-'],
      JSON.stringify({
        ref: `refs/heads/${ASSETS_BRANCH}`,
        sha: (JSON.parse(commit.stdout) as { sha: string }).sha,
      }),
    );
  };

  /**
   * Uploads every screenshot and returns id -> URL for the body renderer.
   *
   * Per-attempt for now: a retry re-uploads. Durable Asset receipts — which make
   * an uploaded screenshot survive a failed create — are the next ticket, and
   * the URLs deliberately do NOT go back onto the ImageAttachment, because a
   * mutable field on a shared object is exactly the representation that ticket
   * replaces.
   */
  const uploadImages = async (
    repo: Repo,
    images: ImageAttachment[],
  ): Promise<Map<string, string>> => {
    const urls = new Map<string, string>();
    if (images.length === 0) return urls;

    await ensureAssetsBranch(repo.nameWithOwner);

    for (const image of images) {
      const path = assetPath(image);
      const result = await gh.ok(
        'upload_failed',
        'Could not upload an image to this repo.',
        ['api', '--method', 'PUT', `repos/${repo.nameWithOwner}/contents/${path}`, '--input', '-'],
        // Base64 goes over stdin: a screenshot exceeds the Windows argv limit.
        JSON.stringify({
          message: `Add ${path}`,
          content: toBase64(image.bytes),
          branch: ASSETS_BRANCH,
        }),
      );
      const { commit } = JSON.parse(result.stdout) as { commit: { sha: string } };
      // Pinned to the commit SHA, so the URL survives a force-push of the branch.
      urls.set(image.id, assetUrl(repo, commit.sha, path));
    }
    return urls;
  };

  // ── Body ──────────────────────────────────────────────────────────────────

  const listLabels = async (repo: string): Promise<string[]> => {
    const result = await gh.ok(
      'create_failed',
      'Could not read this repo’s labels.',
      ['label', 'list', '--repo', repo, '--limit', '100', '--json', 'name'],
    );
    return parseJson<Array<{ name: string }>>(result.stdout, []).map((l) => l.name);
  };

  /** Only labels the repo already has: never create one, never touch its scheme. */
  const labelsFor = async (repo: string, type: ReportType): Promise<string[]> => {
    const wanted = LABEL_FOR[type];
    if (wanted === null) return [];
    const existing = await listLabels(repo);
    return existing.includes(wanted) ? [wanted] : [];
  };

  /**
   * An id with no uploaded image — "file without images", or a hallucinated ref
   * — is stripped rather than left pointing at a scheme nothing resolves.
   */
  const rewriteRefs = (body: string, urls: Map<string, string>, isPrivate: boolean): string =>
    body.replace(imageRefPattern(), (_match, alt: string, id: string) => {
      const url = urls.get(id);
      if (url === undefined) return '';
      return isPrivate ? `[${alt || 'View screenshot'}](${url})` : `![${alt}](${url})`;
    });

  const tidy = (markdown: string): string =>
    markdown.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  /**
   * The one place section markdown is produced, and therefore the one place the
   * no-fabrication rule has to hold. Stripping refs can empty a section whose
   * only content was an image, so emptiness is judged AFTER the rewrite — a
   * heading standing over nothing is exactly the empty scaffolding the rule
   * forbids (types.ts DraftSection; parse.ts rejects it upstream too).
   *
   * `heading` is empty on the file-as-is path, where nothing was classified: a
   * bare `##` is a heading the user never typed, and reads as tool output.
   */
  const renderSection = (
    section: RefinedDraft['sections'][number],
    urls: Map<string, string>,
    isPrivate: boolean,
  ): string | null => {
    const body = tidy(rewriteRefs(section.body, urls, isPrivate));
    if (body === '') return null;
    const heading = section.heading.trim();
    return heading === '' ? body : `## ${heading}\n\n${body}`;
  };

  /**
   * The finished report, plus the floor under it.
   *
   * Dropping the images can drop the whole report: a draft where EVERY section
   * was image-only renders to nothing, and would file as a title over an empty
   * body — the user's actual words thrown away. So when nothing survives, the
   * raw dump does. It is the user's own writing, so it cannot violate the
   * no-fabrication rule (that rule forbids INVENTING, not shipping unpolished),
   * and it is the same escape-hatch shape file-as-is already has.
   *
   * This lives with the renderer rather than in the reducer because it is a
   * property of the FILED body, and the filed body is decided from the frozen
   * report on disk — a caller that rewrote its own state would be editing a
   * report Filing had already taken ownership of.
   */
  const renderBody = (
    refined: RefinedDraft,
    raw: string,
    urls: Map<string, string>,
    isPrivate: boolean,
  ): string => {
    const blocks = refined.sections
      .map((s) => renderSection(s, urls, isPrivate))
      .filter((s): s is string => s !== null);

    if (blocks.length > 0) return `${blocks.join('\n\n')}\n`;
    const floor = raw.trim();
    return floor === '' ? '' : `${floor}\n`;
  };

  /** The identity rides in the body itself, invisibly. Nothing else is appended. */
  const withMarker = (body: string, id: string): string => `${body}\n${filingMarker(id)}\n`;

  // ── Remote write ──────────────────────────────────────────────────────────

  const create = async (
    repo: Repo,
    target: SubmitTarget,
    refined: RefinedDraft,
    body: string,
  ): Promise<SubmitResult> => {
    if (target.kind === 'comment') {
      const result = await gh.ok(
        'create_failed',
        `Could not comment on issue #${target.issueNumber}.`,
        ['issue', 'comment', String(target.issueNumber), '--repo', repo.nameWithOwner, '--body-file', '-'],
        body,
      );
      return { url: lastLine(result.stdout), issueNumber: target.issueNumber };
    }

    const args = ['issue', 'create', '--repo', repo.nameWithOwner, '--title', refined.title, '--body-file', '-'];
    for (const label of await labelsFor(repo.nameWithOwner, refined.type)) {
      args.push('--label', label);
    }
    const result = await gh.ok('create_failed', 'Could not create the issue.', args, body);
    const url = lastLine(result.stdout);
    return { url, issueNumber: Number(url.split('/').pop()) };
  };

  /**
   * One attempt at the remote write, ending in a durable receipt.
   *
   * Everything it files comes from the FROZEN report in the Filing workspace,
   * never from a caller's live state. That is what makes "edits after Submit
   * cannot change this report" a structural fact rather than a rule someone has
   * to remember.
   */
  const attempt = async (snapshot: Snapshot, decision: FilingDecision): Promise<FiledSnapshot> => {
    // Already terminal: a resumed Filing that got its receipt never asks GitHub
    // to create anything a second time.
    const done = snapshot.receipt;
    if (done !== undefined) return { ...snapshot, receipt: done };

    const frozen = await readDraftDir(files, draftDir(snapshot.id));
    const refined = frozen?.refined;
    if (frozen === null || refined === undefined) {
      throw new FilingError(
        'create_failed',
        'This report is no longer on this computer.',
        snapshot.id,
      );
    }

    const repo: Repo = { nameWithOwner: snapshot.repo, isPrivate: snapshot.isPrivate };
    const images = decision === 'without-images' ? [] : frozen.images;

    let result: SubmitResult;
    try {
      const urls = await uploadImages(repo, images);
      const body = withMarker(renderBody(refined, frozen.raw, urls, repo.isPrivate), snapshot.id);
      result = await create(repo, snapshot.target, refined, body);
    } catch (error) {
      await persist({
        ...snapshot,
        state: 'failed',
        updatedAt: stamp(),
        // Sanitized on purpose: the message is the plain-language one the user
        // already sees. `gh` stderr never lands on disk.
        lastFailure: { kind: kindOf(error), message: messageOf(error) },
      });
      throw new FilingError(kindOf(error), messageOf(error), snapshot.id);
    }

    const filed: FiledSnapshot = {
      ...snapshot,
      state: 'filed',
      updatedAt: stamp(),
      receipt: { ...result, filingId: snapshot.id },
    };
    // THE line. Everything before it is retryable; nothing after it is.
    await persist(filed);
    return filed;
  };

  /**
   * Deletes what this Filing owns, and only what this Filing owns.
   *
   * Scoped by construction rather than by care: it removes one directory keyed
   * by the Filing id, so it cannot reach a newer draft, and two Filings whose
   * cleanup failed do not know about each other.
   *
   * It never throws. By the time it runs the receipt is durable, and a report
   * GitHub has accepted must never be presented as a failure the user could
   * "retry" — that retry would file it twice. A failure is recorded in the
   * snapshot instead, where a later run can drain it.
   */
  const cleanup = async (filed: FiledSnapshot): Promise<void> => {
    try {
      await files.remove(dirFor(filed.id));
    } catch (error) {
      try {
        await persist({
          ...filed,
          updatedAt: stamp(),
          cleanup: 'pending',
          cleanupFailure: { message: messageOf(error) },
        });
      } catch {
        // Nothing left to record it in. The receipt is still terminal.
      }
    }
  };

  return {
    /**
     * Files a report, or finishes filing one. Resolves only with a durable
     * receipt; rejects only with a `FilingError` that is safe to act on.
     */
    async file(command: FilingCommand): Promise<FilingReceipt> {
      const snapshot =
        command.kind === 'new'
          ? await begin(command.draft, command.repo)
          : await loadSnapshot(command.filingId);

      const filed = await attempt(snapshot, command.decision);
      await cleanup(filed);
      return filed.receipt;
    },
  };
}

export type Filing = ReturnType<typeof createFiling>;
