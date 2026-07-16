/**
 * Subsequence matching for the Ctrl+R repo switcher.
 *
 * Command-palette semantics: the typed characters must appear in order, not
 * adjacently, so "qk" finds "Quacket". Ranking favours what a human means by a
 * good match — a run of adjacent hits, a hit at a word boundary, a hit in the
 * repo name rather than the owner.
 */

import type { Repo } from '../../core/types.ts';

export interface RepoMatch {
  repo: Repo;
  /** Indices of `nameWithOwner` the query matched, for highlighting. */
  hits: number[];
  score: number;
}

const BOUNDARY = /[/\-_. ]/;

/** Scores one candidate, or null when the query is not a subsequence of it. */
export function matchRepo(repo: Repo, query: string): RepoMatch | null {
  const name = repo.nameWithOwner;
  const hay = name.toLowerCase();
  const needle = query.toLowerCase();

  if (needle === '') return { repo, hits: [], score: 0 };

  const hits: number[] = [];
  let at = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    hits.push(found);
    at = found + 1;
  }

  const slash = hay.indexOf('/');
  let score = 0;
  for (let i = 0; i < hits.length; i++) {
    const index = hits[i] as number;
    // Adjacency is the strongest signal that this is the word they meant.
    if (i > 0 && index === (hits[i - 1] as number) + 1) score += 8;
    // Starting a word counts for nearly as much.
    if (index === 0 || BOUNDARY.test(hay[index - 1] as string)) score += 6;
    // The repo name is what people think in; the owner is boilerplate.
    if (slash !== -1 && index > slash) score += 2;
  }
  // All else equal, an earlier and tighter match wins.
  score -= (hits[0] as number) * 0.5;
  score -= ((hits[hits.length - 1] as number) - (hits[0] as number)) * 0.25;

  return { repo, hits, score };
}

/**
 * Best first. Ties break on the shorter name, then alphabetically, so the list
 * never reshuffles between two keystrokes that score the same.
 */
export function fuzzyRepos(repos: Repo[], query: string): RepoMatch[] {
  // Trimmed, because no repo name contains a space: an accidental leading one
  // would otherwise match nothing and blank the list mid-type.
  const trimmed = query.trim();

  const matches: RepoMatch[] = [];
  for (const repo of repos) {
    const match = matchRepo(repo, trimmed);
    if (match !== null) matches.push(match);
  }
  if (trimmed === '') return matches;

  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.repo.nameWithOwner.length - b.repo.nameWithOwner.length ||
      a.repo.nameWithOwner.localeCompare(b.repo.nameWithOwner),
  );
}

/** Splits a name into alternating plain/highlighted runs for rendering. */
export function highlight(name: string, hits: number[]): Array<{ text: string; hit: boolean }> {
  const marked = new Set(hits);
  const out: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < name.length; i++) {
    const hit = marked.has(i);
    const last = out[out.length - 1];
    if (last !== undefined && last.hit === hit) last.text += name[i] as string;
    else out.push({ text: name[i] as string, hit });
  }
  return out;
}
