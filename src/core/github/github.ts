/**
 * GitHub discovery: authentication and the read-only lookups the palette needs
 * before a report exists — am I signed in, which repos can I file against, which
 * issues are already open.
 *
 * Everything that WRITES to GitHub — asset upload, body rendering, issue and
 * comment creation, submission error mapping — lives in `core/filing/filing.ts`
 * instead, because those steps are only correct as part of one Filing
 * transaction that owns a durable receipt. Splitting them out is what stops a
 * caller from re-assembling that transaction in the wrong order.
 *
 * Every call here is a `gh` spawn across the ProcessRunner seam — no process API
 * is imported, no token is ever handled: `gh` owns the credential.
 */

import type { ProcessRunner } from '../runner.ts';
import type { OpenIssue, Repo } from '../types.ts';
import { createGh, parseJson } from './gh.ts';

export { GitHubError, type GitHubErrorKind } from './gh.ts';

/** Push access. Anything less cannot commit assets or reliably open issues. */
const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

export function createGitHub(runner: ProcessRunner) {
  const gh = createGh(runner);

  return {
    /** Probed at app start; `gh` exits non-zero when no account is logged in. */
    async checkAuth(): Promise<{ ok: boolean; message?: string }> {
      const result = await gh.run(['auth', 'status']);
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
      const result = await gh.ok(
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
      const result = await gh.ok(
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
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
