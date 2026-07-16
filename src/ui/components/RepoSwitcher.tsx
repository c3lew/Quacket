/**
 * The Ctrl+R fuzzy switcher.
 *
 * Only push-access repos are listed at all. The prototype greyed the rest out
 * with a tooltip explaining why they were unusable — but a control that exists
 * only to explain why it cannot be used is a control that should not exist. The
 * core already filters `listRepos` to push access; this just shows what is left.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Repo } from '../../core/types.ts';
import { fuzzyRepos, highlight } from './fuzzy.ts';
import { Icon } from './icons.tsx';

export interface RepoSwitcherProps {
  repos: Repo[];
  current: Repo | null;
  onPick: (repo: Repo) => void;
  onClose: () => void;
}

export function RepoSwitcher({ repos, current, onPick, onClose }: RepoSwitcherProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => fuzzyRepos(repos, query), [repos, query]);
  const active = Math.min(cursor, Math.max(0, matches.length - 1));

  // Keeps the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, matches.length]);

  const move = (delta: number) => setCursor((c) => Math.max(0, Math.min(matches.length - 1, c + delta)));

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher">
        <div className="switcher-search">
          <Icon name="repo" size={14} />
          <input
            autoFocus
            value={query}
            placeholder="Switch repo — type to filter"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const picked = matches[active]?.repo;
                if (picked !== undefined) onPick(picked);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
        </div>

        <div className="switcher-list" ref={listRef}>
          {matches.length === 0 ? (
            <p className="empty">No repo matches “{query}”</p>
          ) : (
            matches.map((match, i) => (
              <button
                key={match.repo.nameWithOwner}
                className={i === active ? 'repo-row on' : 'repo-row'}
                data-active={i === active}
                onMouseMove={() => setCursor(i)}
                onClick={() => onPick(match.repo)}
              >
                <Icon name="repo" size={13} />
                <span className="repo-label">
                  {highlight(match.repo.nameWithOwner, match.hits).map((run, r) =>
                    run.hit ? <b key={r}>{run.text}</b> : <span key={r}>{run.text}</span>,
                  )}
                </span>
                {match.repo.isPrivate && <span className="tag">Private</span>}
                {match.repo.nameWithOwner === current?.nameWithOwner && (
                  <span className="tag current">
                    <Icon name="check" size={10} />
                    Current
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
