import { describe, expect, it } from 'vitest';

import type { Repo } from '../../core/types.ts';
import { fuzzyRepos, highlight, matchRepo } from './fuzzy.ts';

const repo = (nameWithOwner: string, isPrivate = false): Repo => ({ nameWithOwner, isPrivate });

const REPOS: Repo[] = [
  repo('c3lew/Quacket'),
  repo('c3lew/dotfiles'),
  repo('c3lew/blog-engine'),
  repo('c3lew/side-scraper'),
  repo('c3lew/recipe-box'),
];

const names = (query: string): string[] =>
  fuzzyRepos(REPOS, query).map((m) => m.repo.nameWithOwner);

describe('matching', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(matchRepo(repo('c3lew/Quacket'), 'qkt')).not.toBeNull();
  });

  it('is case-insensitive both ways', () => {
    expect(names('QUACKET')).toContain('c3lew/Quacket');
    expect(names('quacket')).toContain('c3lew/Quacket');
  });

  it('rejects a query whose characters are out of order', () => {
    expect(matchRepo(repo('c3lew/Quacket'), 'tq')).toBeNull();
  });

  it('rejects a character that is not there at all', () => {
    expect(matchRepo(repo('c3lew/Quacket'), 'quz')).toBeNull();
  });

  it('needs every character, not most of them', () => {
    expect(matchRepo(repo('c3lew/Quacket'), 'quacketz')).toBeNull();
  });
});

describe('ranking', () => {
  it('surfaces the repo the user meant first', () => {
    expect(names('quack')[0]).toBe('c3lew/Quacket');
    expect(names('dot')[0]).toBe('c3lew/dotfiles');
    expect(names('recipe')[0]).toBe('c3lew/recipe-box');
  });

  it('beats a scattered subsequence with a contiguous run', () => {
    // 'sce' hits side-scraper contiguously ("sc...e" in scraper) and blog-engine
    // only by scattering across the whole string.
    const ranked = fuzzyRepos([repo('c3lew/blog-engine'), repo('c3lew/side-scraper')], 'scra');
    expect(ranked[0]?.repo.nameWithOwner).toBe('c3lew/side-scraper');
  });

  it('prefers a word-boundary hit over one buried mid-word', () => {
    const ranked = fuzzyRepos([repo('acme/xxboxxx'), repo('acme/recipe-box')], 'box');
    expect(ranked[0]?.repo.nameWithOwner).toBe('acme/recipe-box');
  });

  it('prefers a hit in the repo name over the same hit in the owner', () => {
    const ranked = fuzzyRepos([repo('quacket/other'), repo('someone/quacket')], 'quacket');
    expect(ranked[0]?.repo.nameWithOwner).toBe('someone/quacket');
  });

  it('orders ties deterministically, so the list cannot reshuffle between keystrokes', () => {
    const candidates = [repo('a/zzz-thing'), repo('a/aaa-thing'), repo('a/thing')];
    expect(fuzzyRepos(candidates, 'thing').map((m) => m.repo.nameWithOwner)).toEqual(
      fuzzyRepos([...candidates].reverse(), 'thing').map((m) => m.repo.nameWithOwner),
    );
  });
});

describe('empty query', () => {
  it('shows every repo, in the order given', () => {
    expect(names('')).toEqual(REPOS.map((r) => r.nameWithOwner));
  });

  it('does not reorder on whitespace alone', () => {
    expect(names('   ')).toEqual(REPOS.map((r) => r.nameWithOwner));
  });
});

describe('no matches', () => {
  it('returns nothing rather than falling back to everything', () => {
    expect(names('zzzzz')).toEqual([]);
  });
});

describe('highlight', () => {
  it('splits a name into plain and matched runs', () => {
    const match = matchRepo(repo('c3lew/Quacket'), 'quack');
    expect(highlight('c3lew/Quacket', match?.hits ?? [])).toEqual([
      { text: 'c3lew/', hit: false },
      { text: 'Quack', hit: true },
      { text: 'et', hit: false },
    ]);
  });

  it('reassembles into the original name exactly', () => {
    const name = 'c3lew/side-scraper';
    const match = matchRepo(repo(name), 'scrap');
    expect(
      highlight(name, match?.hits ?? [])
        .map((run) => run.text)
        .join(''),
    ).toBe(name);
  });

  it('marks nothing when the query is empty', () => {
    expect(highlight('c3lew/Quacket', [])).toEqual([{ text: 'c3lew/Quacket', hit: false }]);
  });
});
