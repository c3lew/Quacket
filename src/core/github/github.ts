/**
 * The GitHub submission pipeline.
 *
 * Everything here is a `gh` spawn across the ProcessRunner seam — no process API
 * is imported, no token is ever handled: `gh` owns the credential.
 *
 * Images cannot use GitHub's drag-and-drop attachment flow (that endpoint is
 * cookie-only; a `gh` token is rejected — see docs/research/github-issue-image-
 * attachment.md). Instead each image is committed to an orphan `quacket-assets`
 * branch in the target repo via the Contents API and referenced by a SHA-pinned
 * URL, so the link is immutable and asset visibility is exactly repo visibility.
 */

import type { ProcessRunner, ProcSpec } from '../runner.ts';
import {
  IMAGE_REF_SCHEME,
  type Draft,
  type ImageAttachment,
  type OpenIssue,
  type RefinedDraft,
  type Repo,
  type ReportType,
  type SubmitResult,
  type SubmitTarget,
} from '../types.ts';

/** Subset of Draft.lastError['kind'] that this module can produce. */
export type GitHubErrorKind = 'not_authenticated' | 'upload_failed' | 'create_failed';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    /** Plain language; the UI shows this as-is. */
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const ASSETS_BRANCH = 'quacket-assets';
const ASSETS_DIR = '.quacket/assets';

/** Push access. Anything less cannot commit assets or reliably open issues. */
const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** bug -> `bug`, feature -> `enhancement`, chore -> nothing. */
const LABEL_FOR: Record<ReportType, string | null> = {
  bug: 'bug',
  feature: 'enhancement',
  chore: null,
};

const READ_TIMEOUT_MS = 30_000;
/** Uploads carry megabytes of base64, so they get a longer leash. */
const WRITE_TIMEOUT_MS = 120_000;

const ASSETS_README = [
  '# Quacket assets',
  '',
  'Images embedded in issues filed from this repo. Each file is referenced by',
  'commit SHA, so deleting this branch breaks the images in those issues.',
  '',
].join('\n');

/**
 * `![alt](quacket-image:img_1)` — refine runs before upload and cannot know the
 * final URL, so it emits ids and we rewrite them here. Built from the shared
 * constant so the scheme has exactly one definition.
 */
const imageRefPattern = (): RegExp =>
  new RegExp(`!?\\[([^\\]]*)\\]\\(${IMAGE_REF_SCHEME}([^)\\s]+)\\)`, 'g');

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
 * Belt and braces, and the braces are the real ones.
 *
 * This used to claim `gh <cmd> --json` prints empty stdout rather than `[]` on an
 * empty listing, "verified against gh 2.90.0". That was checked against live gh
 * 2.90.0 in round 4 and is FALSE: an empty listing prints `[]\n`, which parses to
 * `[]` and never reaches the fallback. The claim was wrong; the code is not, so
 * nothing here changed but the sentence.
 *
 * The guard stays because it is cheap and the honest reason is a better one than
 * the invented one: stdout we did not get to see (a killed child, a gh that
 * writes nothing on some path we have not hit) must not become a `JSON.parse('')`
 * throw miles from the cause.
 */
const parseJson = <T>(stdout: string, fallback: T): T => {
  const text = stdout.trim();
  return text === '' ? fallback : (JSON.parse(text) as T);
};

const lastLine = (stdout: string): string =>
  stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop() ?? '';

export interface GitHubOptions {
  /** Injected so asset filenames — and therefore argv — are deterministic in tests. */
  now?: () => Date;
}

export function createGitHub(runner: ProcessRunner, options: GitHubOptions = {}) {
  const now = options.now ?? (() => new Date());

  const gh = async (args: string[], stdin?: string) => {
    const spec: ProcSpec = {
      cmd: 'gh',
      args,
      timeoutMs: stdin === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    };
    if (stdin !== undefined) spec.stdin = stdin;
    return runner.run(spec);
  };

  /** Runs `gh`, throwing a user-facing error unless it exited 0. */
  const ghOk = async (kind: GitHubErrorKind, message: string, args: string[], stdin?: string) => {
    const result = await gh(args, stdin);
    if (result.timedOut) throw new GitHubError(kind, `${message} GitHub took too long to respond.`);
    if (result.exitCode !== 0) throw new GitHubError(kind, message, result.stderr.trim());
    return result;
  };

  const assetPath = (image: ImageAttachment): string => {
    const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    return `${ASSETS_DIR}/${stamp}-${image.id}.${ext}`;
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
    const existing = await gh(['api', `repos/${nameWithOwner}/git/ref/heads/${ASSETS_BRANCH}`]);
    if (existing.exitCode === 0) return;

    const failed = 'Could not create the image branch in this repo.';
    // The trees API inlines text blobs, so the README needs no separate blob call.
    const tree = await ghOk(
      'upload_failed',
      failed,
      ['api', '--method', 'POST', `repos/${nameWithOwner}/git/trees`, '--input', '-'],
      JSON.stringify({
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: ASSETS_README }],
      }),
    );
    const commit = await ghOk(
      'upload_failed',
      failed,
      ['api', '--method', 'POST', `repos/${nameWithOwner}/git/commits`, '--input', '-'],
      JSON.stringify({
        message: 'Create Quacket assets branch',
        tree: (JSON.parse(tree.stdout) as { sha: string }).sha,
        parents: [],
      }),
    );
    await ghOk(
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
   * Fills in `uploadedUrl` on every image that lacks one, in place: the caller's
   * Draft holds these objects, so a create failure leaves the URLs on the draft
   * and the retry reuses the blobs instead of committing duplicates.
   */
  const uploadImages = async (repo: Repo, images: ImageAttachment[]): Promise<ImageAttachment[]> => {
    const pending = images.filter((i) => i.uploadedUrl === undefined);
    if (pending.length === 0) return images;

    await ensureAssetsBranch(repo.nameWithOwner);

    for (const image of pending) {
      const path = assetPath(image);
      const result = await ghOk(
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
      image.uploadedUrl = assetUrl(repo, commit.sha, path);
    }
    return images;
  };

  const listLabels = async (repo: string): Promise<string[]> => {
    const result = await ghOk(
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
  const rewriteRefs = (body: string, images: ImageAttachment[], isPrivate: boolean): string =>
    body.replace(imageRefPattern(), (_match, alt: string, id: string) => {
      const url = images.find((i) => i.id === id)?.uploadedUrl;
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
    images: ImageAttachment[],
    isPrivate: boolean,
  ): string | null => {
    const body = tidy(rewriteRefs(section.body, images, isPrivate));
    if (body === '') return null;
    const heading = section.heading.trim();
    return heading === '' ? body : `## ${heading}\n\n${body}`;
  };

  const renderBody = (refined: RefinedDraft, images: ImageAttachment[], isPrivate: boolean): string => {
    const blocks = refined.sections
      .map((s) => renderSection(s, images, isPrivate))
      .filter((s): s is string => s !== null);

    return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
  };

  return {
    /** Probed at app start; `gh` exits non-zero when no account is logged in. */
    async checkAuth(): Promise<{ ok: boolean; message?: string }> {
      const result = await gh(['auth', 'status']);
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        message: result.timedOut
          ? 'GitHub CLI did not respond. Check your connection and try again.'
          : 'You are not signed in to GitHub. Run `gh auth login` to connect your account.',
      };
    },

    /** Only repos you can push to: filing an issue needs push for the assets branch. */
    async listRepos(): Promise<Repo[]> {
      const result = await ghOk(
        'create_failed',
        'Could not list your GitHub repos.',
        ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,isPrivate,viewerPermission'],
      );
      type Row = { nameWithOwner: string; isPrivate: boolean; viewerPermission: string | null };
      return parseJson<Row[]>(result.stdout, [])
        .filter((r) => PUSH_PERMISSIONS.has(r.viewerPermission ?? ''))
        .map((r) => ({ nameWithOwner: r.nameWithOwner, isPrivate: r.isPrivate }));
    },

    /** Most recently touched first — `gh issue list` has no updated-sort flag. */
    async listOpenIssues(repo: string): Promise<OpenIssue[]> {
      const result = await ghOk(
        'create_failed',
        'Could not list open issues for this repo.',
        ['issue', 'list', '--repo', repo, '--limit', '100', '--json', 'number,title,labels,updatedAt'],
      );
      type Row = { number: number; title: string; labels: Array<{ name: string }>; updatedAt: string };
      return parseJson<Row[]>(result.stdout, [])
        .map((r) => ({
          number: r.number,
          title: r.title,
          labels: r.labels.map((l) => l.name),
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    listLabels,
    uploadImages,

    /** Upload first, always: the body embeds URLs that do not exist until then. */
    async submit(repo: Repo, draft: Draft, target: SubmitTarget): Promise<SubmitResult> {
      const refined = draft.refined;
      if (refined === undefined) {
        throw new GitHubError('create_failed', 'This report has not been refined yet.');
      }

      await uploadImages(repo, draft.images);
      const body = renderBody(refined, draft.images, repo.isPrivate);

      if (target.kind === 'comment') {
        const result = await ghOk(
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
      const result = await ghOk('create_failed', 'Could not create the issue.', args, body);
      const url = lastLine(result.stdout);
      return { url, issueNumber: Number(url.split('/').pop()) };
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
