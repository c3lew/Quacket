/**
 * The reconciliation READ: is a Filing's exact identity already on GitHub?
 *
 * Split out of `filing.ts` because it answers one question with no knowledge of
 * snapshots, workspaces or cleanup — and because the question has exactly three
 * honest answers, which is the whole design:
 *
 *   match         the exact marker was found. Reconstruct the receipt.
 *   absent        a COMPLETE listing was read and parsed, and it is not there.
 *   inconclusive  anything else. We do not know, and must not guess.
 *
 * The asymmetry is deliberate and load-bearing. A match is proof; a no-match is
 * only proof when every page was read. So a rate limit, a lost connection, a
 * malformed page, a half-finished pagination or an actor lookup that failed all
 * collapse into `inconclusive` — never into `absent`. Treating "I could not
 * look" as "it is not there" is what would file the user's report twice.
 *
 * That is also why the pages come from the repository and issue-comments
 * endpoints rather than GitHub's search index: search can FIND a report, but its
 * index lags a create by seconds to minutes, so an empty search result says
 * nothing at all about whether the report exists.
 *
 * Pagination is walked explicitly rather than with `gh api --paginate`, so
 * "complete" is something this file can prove: every page exited 0, parsed, and
 * the walk ended on a short page rather than on a cap.
 */

import { parseJson, type Gh } from '../github/gh.ts';
import type { SubmitTarget } from '../types.ts';

/** The three facts, and nothing between them. */
export type Lookup =
  | { kind: 'match'; url: string; issueNumber: number }
  | { kind: 'absent' }
  /** Plain language: this is what the palette shows beside a pending report. */
  | { kind: 'inconclusive'; message: string };

const UNAVAILABLE = 'Could not check GitHub for this report.';

const inconclusive = (message = UNAVAILABLE): Lookup => ({ kind: 'inconclusive', message });

/** GitHub's own maximum. Fewer requests is fewer chances to be interrupted. */
const PER_PAGE = 100;

/**
 * A backstop, not a budget: 10 000 issues is far past any repo a person files
 * bug reports into by hotkey. Hitting it means the walk did not finish, which is
 * `inconclusive` — the cap can never manufacture an `absent`.
 */
const MAX_PAGES = 100;

/** Only the fields a match needs. GitHub sends dozens more; none are our business. */
interface Row {
  body?: string | null;
  html_url?: string;
  number?: number;
}

/**
 * One page, or `null` for "we did not get to read it".
 *
 * Every failure mode lands on that same `null` on purpose: a non-zero exit
 * (offline, 401, 403 rate limit, 404), a timeout, a body that is not JSON, and a
 * body that is JSON but not an array. None of them is evidence of absence.
 *
 * EMPTY STDOUT IS ONE OF THEM, and it is the dangerous one. `parseJson` treats
 * empty output as its fallback, and a fallback of `[]` here would read as "the
 * listing is complete and this report is not in it" — an authoritative no-match
 * conjured out of output nobody ever saw, which auto-resumes and files the
 * report twice. `gh api` exiting 0 with nothing on stdout should be impossible;
 * this is the line that makes it not matter.
 */
const readPage = async (gh: Gh, path: string, page: number): Promise<Row[] | null> => {
  const sep = path.includes('?') ? '&' : '?';
  const result = await gh.run(['api', `${path}${sep}per_page=${PER_PAGE}&page=${page}`]);
  if (result.timedOut || result.exitCode !== 0 || result.stdout.trim() === '') return null;
  try {
    const rows = parseJson<Row[]>(result.stdout, []);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
};

/**
 * Walks pages until the marker turns up or the listing is provably exhausted.
 *
 * `numberOf` is how the issue number is recovered, and it differs by endpoint:
 * an issue row carries its own, while a comment row does not — the number is the
 * issue the comment was posted to, which the caller already knows.
 */
const scan = async (
  gh: Gh,
  path: string,
  marker: string,
  numberOf: (row: Row) => number | undefined,
): Promise<Lookup> => {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await readPage(gh, path, page);
    if (rows === null) return inconclusive();

    for (const row of rows) {
      if (!(row.body ?? '').includes(marker)) continue;
      const url = row.html_url;
      const issueNumber = numberOf(row);
      // Found, but the row cannot say WHERE. That is not a no-match either.
      if (url === undefined || issueNumber === undefined) return inconclusive();
      return { kind: 'match', url, issueNumber };
    }

    // A short page is the end of the listing — the one thing that proves absence.
    if (rows.length < PER_PAGE) return { kind: 'absent' };
  }
  return inconclusive();
};

/** Who `gh` is signed in as, or `null` — which makes the whole lookup inconclusive. */
const actor = async (gh: Gh): Promise<string | null> => {
  const result = await gh.run(['api', 'user']);
  if (result.timedOut || result.exitCode !== 0) return null;
  try {
    const login = (parseJson<{ login?: string }>(result.stdout, {})).login;
    return typeof login === 'string' && login !== '' ? login : null;
  } catch {
    return null;
  }
};

/**
 * `state=all` because the report may already have been closed by the time we
 * look, and `creator` because the listing that has to be walked to the end
 * should be as short as it can honestly be — the report was filed by whoever
 * `gh` is signed in as, so nobody else's issues can hold this marker.
 */
export const findFiling = async (
  gh: Gh,
  repo: string,
  target: SubmitTarget,
  marker: string,
): Promise<Lookup> => {
  if (target.kind === 'comment') {
    const path = `repos/${repo}/issues/${target.issueNumber}/comments`;
    return scan(gh, path, marker, () => target.issueNumber);
  }

  const login = await actor(gh);
  if (login === null) {
    return inconclusive('Could not confirm which GitHub account is signed in.');
  }
  const path = `repos/${repo}/issues?state=all&creator=${encodeURIComponent(login)}`;
  return scan(gh, path, marker, (row) => row.number);
};
