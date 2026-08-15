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
 *   3. TERMINAL SUCCESS. The instant GitHub accepts the report, the submit is
 *      over. Everything after that — writing the receipt, deleting the workspace
 *      — is bookkeeping, and NO bookkeeping failure can turn a filed report back
 *      into a retryable one. A retry after acceptance is a second issue, so a
 *      local disk problem reported as "filing failed" would hand the user a
 *      button that duplicates their report. The receipt is written durably so a
 *      later process can still see the outcome; when that write fails we have
 *      lost the memory, not the fact, and the fact is what the caller is told.
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
import { findFiling } from './lookup.ts';
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

/**
 * What a terminal Filing resolved to. Durable before the caller ever sees it.
 *
 * It carries the facts a Done screen is built from — where the report went, what
 * it was called, whether it became an issue or a comment — and not because the
 * caller could not look them up: after a crash there is nowhere left to look.
 * The workspace holding the report is deleted the moment cleanup succeeds, so a
 * receipt that only said "issue 42" would restore a Done screen with no title,
 * no repo and no link. A recovered success has to read exactly like a live one,
 * and that is only possible if the receipt is self-sufficient.
 */
export interface FilingReceipt extends SubmitResult {
  filingId: string;
  repo: string;
  target: SubmitTarget;
  /** The filed title. Empty only if the frozen report was unreadable by then. */
  title: string;
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
 * One screenshot GitHub already has, recorded the instant it landed.
 *
 * Keyed by (repo, media type, byte fingerprint) and deliberately NOT by image
 * id: the id survives annotation, and annotation rewrites the bytes. Reusing by
 * id would file the report with the screenshot the user drew ON but not the
 * drawing — a stale image nobody can tell is stale. So the key is the content.
 *
 * The repo is part of the key because the URL points into ONE repo's assets
 * branch, and the media type because it decides the uploaded filename's
 * extension — two identical PNGs filed as `.png` and `.jpg` are two assets.
 *
 * ponytail: receipts live in the Filing that earned them, so today the repo can
 * only ever match. It is in the key anyway because the record has to stay true
 * if receipts are ever shared between Filings — a URL that leaked into the wrong
 * repo is a broken image nobody would think to look for.
 */
interface AssetReceipt {
  repo: string;
  mediaType: ImageAttachment['mediaType'];
  /** SHA-256 of the exact bytes, lowercase hex. */
  fingerprint: string;
  /** SHA-pinned and immutable, so it stays valid for as long as the branch does. */
  url: string;
}

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
 * What recovery has to say about one interrupted Filing, in the caller's terms.
 *
 * Four states and no fifth, because the palette has to be able to say exactly
 * one true sentence about a report it did not finish filing:
 *
 *   checking  we are asking GitHub right now.
 *   filed     it is on GitHub. Here is the receipt; it is over.
 *   pending   we do not know. NOT a failure, and never a Retry — offering one
 *             while duplicate safety is unknown is how a report gets filed twice.
 *   failed    we know nothing was created. Retry is safe.
 *
 * Deliberately absent: which endpoint was read, how many pages, which asset
 * uploaded, whether cleanup ran. Those are how recovery works, not what
 * happened, and a caller that learned them would end up deciding with them.
 */
export type RecoveryEvent =
  | { state: 'checking'; filingId: string }
  | { state: 'filed'; filingId: string; receipt: FilingReceipt }
  /** Plain language, shown as-is: why we still cannot say. */
  | { state: 'pending'; filingId: string; message: string }
  | { state: 'failed'; filingId: string; kind: GitHubErrorKind; message: string };

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
  /**
   * Every screenshot this Filing has already got into the repo. Append-only:
   * an entry is written the moment one upload is confirmed, so a crash after
   * the first of several leaves the finished ones on disk for the next run.
   */
  assets: AssetReceipt[];
  receipt?: FilingReceipt;
  /** A REMOTE failure. Sanitized: plain-language message only, never stderr. */
  lastFailure?: { kind: GitHubErrorKind; message: string };
  /**
   * A LOCAL failure, kept apart from `lastFailure` on purpose. Squeezing a
   * failed `remove` into a `GitHubErrorKind` would make one field mean two
   * unrelated things, and make a disk problem read as a GitHub one.
   *
   * `at` and `attempts` are here because the message alone could not answer the
   * two questions a stuck cleanup actually raises (#33): when did this start,
   * and is it still happening? `updatedAt` cannot stand in — every write moves
   * it, so it cannot tell the first failure from the fifth.
   */
  cleanupFailure?: { message: string; at: string; attempts: number };
  /**
   * The last time reconciliation asked GitHub about this Filing and could not
   * get an answer. A third failure field rather than a reused one for the same
   * reason as the second: a lookup we could not complete is neither a create
   * that failed nor a `remove` that failed, and a pending Filing that has been
   * unreachable for a week should say so from disk alone.
   */
  lastCheck?: { message: string; at: string };
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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * What "the same screenshot" means, in one line.
 *
 * `crypto.subtle` exists in the WebView and in Node, and unlike
 * `crypto.randomUUID` its secure-context gate is satisfied here either way: dev
 * serves from `http://localhost:1420` and the bundle from `http://
 * tauri.localhost`, both of which Chromium treats as potentially trustworthy.
 */
const fingerprint = async (bytes: Uint8Array): Promise<string> =>
  // The cast is TypeScript's typed-array generics, not a real possibility: a
  // bare `Uint8Array` is `ArrayBufferLike`-backed, and `BufferSource` insists on
  // `ArrayBuffer`. Nothing here ever produces a SharedArrayBuffer.
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));

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
  return `fil_${toHex(bytes)}`;
};

const kindOf = (error: unknown): GitHubErrorKind =>
  error instanceof GitHubError ? error.kind : 'create_failed';

/**
 * The last stop before an error leaves the module.
 *
 * A `FilingError` passes through untouched — it was raised on purpose, with a
 * message written for the user. Anything else is a surprise, and its message is
 * dropped rather than shown: a surprise here is a filesystem or runtime error
 * whose text (`EBUSY`, `ENOSPC`) tells the user nothing they can act on and
 * reads like a crash.
 */
const asFilingError =
  (filingId: string) =>
  (error: unknown): never => {
    if (error instanceof FilingError) throw error;
    throw new FilingError('create_failed', UNKNOWN_FAILURE, filingId);
  };

const UNKNOWN_FAILURE = 'Could not file this report.';

/** A workspace whose own record will not open. It stays; we cannot judge it. */
const UNREADABLE = 'Could not read this report on this computer.';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : UNKNOWN_FAILURE;

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

  /**
   * Receipts this process earned, whether or not they reached the disk.
   *
   * The snapshot is how a receipt survives a RESTART. This is how it survives a
   * broken disk, and the two are not the same failure: the write that records
   * acceptance can fail, and so can the cleanup that would have removed the
   * stale snapshot behind it — one full disk, one locked directory, both at
   * once. What is left on disk then says `filing` with no receipt, and resuming
   * it would file the report a second time.
   *
   * So the fact lives here too. As long as the process that filed the report is
   * still running, no resume of that identity can reach GitHub again — without
   * asking GitHub anything, which is reconciliation's job (#24) and is what
   * covers the case where the process is NOT still running.
   */
  const earned = new Map<string, FilingReceipt>();

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

  /**
   * A snapshot write that cannot change the outcome.
   *
   * Used everywhere the write is a RECORD of something already decided — the
   * receipt for a report GitHub accepted, the failure that is about to be thrown
   * anyway, the cleanup that did not finish. In all three the decision is
   * already made, so letting the write throw could only replace a true outcome
   * with a false one: a filed report reported as failed, or a GitHub failure
   * replaced by a filesystem one the user can do nothing about.
   *
   * `persist` itself still throws, and `begin` still uses it: there, the write
   * IS the decision — nothing has reached GitHub, so a Filing whose own record
   * failed must not proceed.
   */
  const record = async (snapshot: Snapshot): Promise<void> => {
    try {
      await persist(snapshot);
    } catch {
      // Nowhere left to write it down. The outcome stands regardless.
    }
  };

  const loadSnapshot = async (id: string): Promise<Snapshot> => {
    const text = await files.readText(joinPath(dirFor(id), SNAPSHOT_JSON));
    const gone = () =>
      new FilingError('create_failed', 'This report is no longer on this computer.', id);
    if (text === null) throw gone();
    try {
      const parsed = JSON.parse(text) as Snapshot;
      // A snapshot written before Asset receipts existed simply has none.
      return { ...parsed, assets: parsed.assets ?? [] };
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
      assets: [],
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
   * Uploads whatever GitHub does not already have, and returns id -> URL for the
   * body renderer.
   *
   * The URLs deliberately do NOT go back onto the `ImageAttachment`: a mutable
   * `uploadedUrl` on a shared object is what this replaces. It said nothing
   * about WHICH bytes were uploaded or WHERE, so it survived annotation (stale
   * image) and a repo switch (URL into the wrong repo), and it lived on the
   * draft — the one thing a Filing has already taken away from the caller.
   *
   * `assets` is the caller's live ledger and is appended to IN PLACE, so a throw
   * partway through still leaves every receipt earned before it in the caller's
   * hands. Each append is persisted before the next upload starts.
   *
   * The map is built in `images` order, and lookups are by image id, so the
   * order receipts happen to sit in the ledger cannot reach the filed body.
   */
  const uploadImages = async (
    repo: Repo,
    images: ImageAttachment[],
    assets: AssetReceipt[],
    onReceipt: () => Promise<void>,
  ): Promise<Map<string, string>> => {
    const urls = new Map<string, string>();
    let branchReady = false;

    for (const image of images) {
      // The key is written ONCE and both compared and stored, so "same asset"
      // cannot come to mean two different things in two places.
      const key: Omit<AssetReceipt, 'url'> = {
        repo: repo.nameWithOwner,
        mediaType: image.mediaType,
        fingerprint: await fingerprint(image.bytes),
      };
      const reuse = assets.find(
        (a) =>
          a.repo === key.repo &&
          a.mediaType === key.mediaType &&
          a.fingerprint === key.fingerprint,
      );
      if (reuse !== undefined) {
        urls.set(image.id, reuse.url);
        continue;
      }

      // Deferred to the first upload that actually has to happen: a resume where
      // every screenshot already landed must not touch GitHub for images at all.
      if (!branchReady) {
        await ensureAssetsBranch(repo.nameWithOwner);
        branchReady = true;
      }

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
      const receipt: AssetReceipt = { ...key, url: assetUrl(repo, commit.sha, path) };
      assets.push(receipt);
      /*
       * Durable before the NEXT upload starts — that ordering is the point.
       *
       * A `record` and not a `persist`: the bytes are already in the repo, so a
       * failed write costs only that a later retry re-uploads them, leaving one
       * orphan blob on the assets branch. Throwing would cost the user the whole
       * report because their disk was full, which is much the worse trade.
       */
      await onReceipt();
      urls.set(image.id, receipt.url);
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
    // to create anything a second time. The snapshot is the durable answer;
    // `earned` covers the one case it cannot — a receipt this process holds that
    // never made it to disk (see the map's own note).
    const done = snapshot.receipt ?? earned.get(snapshot.id);
    // `state` is set alongside the receipt, never left as the loaded one: a
    // snapshot carrying a receipt while still calling itself `filing` would be a
    // record that contradicts itself, and cleanup writes this back to disk.
    if (done !== undefined) return { ...snapshot, state: 'filed', receipt: done };

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

    /*
     * The live ledger for this attempt. `uploadImages` appends to it as receipts
     * are earned, so both exits below write whatever it holds at that moment:
     * a failed attempt keeps the uploads that DID land, and [File without
     * images] — which uploads nothing — carries the existing ones through
     * untouched rather than dropping them.
     */
    const assets = [...snapshot.assets];

    /*
     * A resumed Filing carries the previous attempt's failure, and that failure
     * is history the moment this attempt starts. An in-flight write must not
     * restate it as current: a snapshot on disk saying `failed` while an upload
     * is actually running is a record that contradicts itself, exactly like the
     * `filing`-with-a-receipt one the terminal path above refuses to write.
     *
     * The failure is not lost — the catch below writes this attempt's own.
     */
    const { lastFailure: _previous, ...restarted } = snapshot;

    let result: SubmitResult;
    try {
      const urls = await uploadImages(repo, images, assets, () =>
        record({ ...restarted, assets, state: 'filing', updatedAt: stamp() }),
      );
      const body = withMarker(renderBody(refined, frozen.raw, urls, repo.isPrivate), snapshot.id);
      result = await create(repo, snapshot.target, refined, body);
    } catch (error) {
      await record({
        ...snapshot,
        assets,
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
      assets,
      state: 'filed',
      updatedAt: stamp(),
      receipt: {
        ...result,
        filingId: snapshot.id,
        repo: snapshot.repo,
        target: snapshot.target,
        title: refined.title,
      },
    };
    earned.set(snapshot.id, filed.receipt);
    /*
     * THE line was the `create` above, not this one. This write is how the
     * receipt outlives the process; it is not what makes the report filed.
     *
     * So it is a `record`: if the disk is full, locked, or gone, the report is
     * still on GitHub and the caller still gets the receipt it just earned.
     * Throwing here would report a filed report as failed and offer a [Try
     * again] that files it a second time — the one failure the whole module
     * exists to prevent.
     *
     * What is lost is the memory across a restart — a snapshot left saying
     * `filing` with no receipt. That is exactly the state `recover` below is
     * for: the next launch asks GitHub whether this identity is already there,
     * reading the same marker this attempt wrote into the body.
     */
    await record(filed);
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
      await record({
        ...filed,
        updatedAt: stamp(),
        cleanup: 'pending',
        cleanupFailure: {
          message: messageOf(error),
          // The FIRST failure's time, kept across retries: "stuck since Tuesday"
          // is the diagnosis, and overwriting it every startup would erase it.
          at: filed.cleanupFailure?.at ?? stamp(),
          attempts: (filed.cleanupFailure?.attempts ?? 0) + 1,
        },
      });
    }
  };

  /**
   * Files a report, or finishes filing one. Resolves with the receipt for a
   * report GitHub has accepted; rejects only with an error that is safe to act
   * on — a `FilingError` naming the Filing to resume, or, from `begin`, a
   * `GitHubError` for a Filing that never came into existence.
   *
   * "Safe to act on" is what `asFilingError` buys, and it is not a formality:
   * the app reads `filingId` off the error to decide whether [Try again]
   * RESUMES this Filing or starts a new one, and shows the message verbatim. An
   * untyped error that escaped here would take the id with it — and a [Try
   * again] with no id files the report a second time.
   *
   * `recover` calls this directly, to resume a Filing GitHub has provably never
   * seen.
   */
  const file = async (command: FilingCommand): Promise<FilingReceipt> => {
    const snapshot =
      command.kind === 'new'
        ? await begin(command.draft, command.repo)
        : await loadSnapshot(command.filingId).catch(asFilingError(command.filingId));

    const filed = await attempt(snapshot, command.decision).catch(asFilingError(snapshot.id));
    await cleanup(filed);
    return filed.receipt;
  };

  // ── Recovery ──────────────────────────────────────────────────────────────

  /** The title the frozen report was filed under, for a receipt rebuilt from GitHub. */
  const frozenTitle = async (id: string): Promise<string> => {
    try {
      return (await readDraftDir(files, draftDir(id)))?.refined?.title ?? '';
    } catch {
      return '';
    }
  };

  /**
   * Everything one interrupted Filing can turn into, as a stream of one to three
   * events. Split out of the generator so the walk over the workspaces stays
   * readable, and so the fixed matrix below is one function you can read top to
   * bottom.
   */
  const reconcile = async function* (id: string): AsyncGenerator<RecoveryEvent> {
    let snapshot: Snapshot;
    try {
      snapshot = await loadSnapshot(id);
    } catch {
      // Unreadable is not absent, and not failed either: this workspace may hold
      // a report GitHub already has, and nothing here can tell. It stays exactly
      // where it is, and says so.
      yield { state: 'pending', filingId: id, message: UNREADABLE };
      return;
    }

    /*
     * Already terminal. This is the cleanup queue draining: the receipt is the
     * answer, GitHub is not asked anything, and the workspace goes away.
     */
    const done = snapshot.receipt ?? earned.get(id);
    if (done !== undefined) {
      yield { state: 'filed', filingId: id, receipt: done };
      await cleanup({ ...snapshot, state: 'filed', receipt: done });
      return;
    }

    yield { state: 'checking', filingId: id };
    const found = await findFiling(gh, snapshot.repo, snapshot.target, filingMarker(id));

    if (found.kind === 'inconclusive') {
      await record({
        ...snapshot,
        updatedAt: stamp(),
        lastCheck: { message: found.message, at: stamp() },
      });
      yield { state: 'pending', filingId: id, message: found.message };
      return;
    }

    if (found.kind === 'match') {
      // The report is on GitHub, and this is the receipt it never got to write.
      // No create call is made — this path exists precisely to not make one.
      const receipt: FilingReceipt = {
        url: found.url,
        issueNumber: found.issueNumber,
        filingId: id,
        repo: snapshot.repo,
        target: snapshot.target,
        title: await frozenTitle(id),
      };
      const filed: FiledSnapshot = { ...snapshot, state: 'filed', updatedAt: stamp(), receipt };
      earned.set(id, receipt);
      await record(filed);
      yield { state: 'filed', filingId: id, receipt };
      await cleanup(filed);
      return;
    }

    /*
     * An authoritative no-match: GitHub was listed to the end and this identity
     * is not there. The user already pressed Submit, so finishing what they
     * asked for needs no second decision — and because the marker is absent,
     * this create is the first one, not a duplicate.
     */
    try {
      const receipt = await file({ kind: 'resume', filingId: id, decision: 'as-captured' });
      yield { state: 'filed', filingId: id, receipt };
    } catch (error) {
      /*
       * The fixed matrix, and the only place `failed` is emitted.
       *
       * `upload_failed` is durable evidence: uploads run strictly before the
       * create, so a Filing that died there never asked GitHub to create
       * anything — and the lookup above just proved nothing was there before.
       * Retry is safe, and the caller may offer it.
       *
       * Everything else — including a create that timed out — leaves the remote
       * outcome unknown all over again, so the Filing goes back to `pending`
       * and the next startup asks GitHub rather than the user.
       */
      const kind = error instanceof FilingError ? error.kind : 'create_failed';
      const message = messageOf(error);
      yield kind === 'upload_failed'
        ? { state: 'failed', filingId: id, kind, message }
        : { state: 'pending', filingId: id, message };
    }
  };

  // Two verbs, and deliberately no third: `file` for a report the user is
  // filing now, `recover` for the ones a previous run did not finish.
  return {
    file,

    /**
     * Every interrupted Filing on this computer, walked once and reported as it
     * resolves.
     *
     * A STREAM rather than a summary, because the slow part is GitHub and the
     * caller has a window to keep usable: it renders `checking` while a lookup
     * is in flight and replaces it the moment there is an answer, instead of
     * waiting for the whole pass. Nothing here is awaited by capture — the
     * caller iterates on its own — so a GitHub that never responds costs a
     * status line, not a capture box.
     *
     * It never rejects. Every expected failure — offline, signed out, rate
     * limited, a half-read listing, a resume that failed again — is an EVENT,
     * because a throw would take the rest of the queue down with it and turn a
     * network blip into an app that cannot start.
     */
    async *recover(): AsyncGenerator<RecoveryEvent> {
      // No folder, or a folder we cannot read: nothing to recover, and nothing
      // worth reporting — there is no Filing here to be uncertain about.
      const ids = await files.list(root).catch(() => null);
      for (const id of ids ?? []) {
        yield* reconcile(id);
      }
    },
  };
}

export type Filing = ReturnType<typeof createFiling>;
