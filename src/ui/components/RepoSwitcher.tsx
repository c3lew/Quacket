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
import { Icon, Spinner } from './icons.tsx';
import { chordOf } from './keymap.ts';

export interface RepoSwitcherProps {
  repos: Repo[];
  current: Repo | null;
  /** A refresh is in flight: the button spins and cannot start another (#25). */
  refreshing: boolean;
  /** A refresh that failed. The list on screen is the previous, still-good one. */
  refreshError: string | null;
  onRefresh: () => void;
  onPick: (repo: Repo) => void;
  onClose: () => void;
}

export function RepoSwitcher({
  repos,
  current,
  refreshing,
  refreshError,
  onRefresh,
  onPick,
  onClose,
}: RepoSwitcherProps) {
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

  /*
   * Ctrl+R opened this modal, so with it open the same chord refreshes the list
   * instead — the keymap hands a modal its whole keyboard (`overlay ⇒ null`), and
   * this listens on `document` so the chord works wherever focus sits, with
   * `preventDefault` keeping the webview's own reload out of it. Exactly Ctrl+R:
   * an extra modifier is a different chord, same rule as the keymap. Filter query
   * and cursor are deliberately untouched — a refresh changes the DATA, not where
   * the user was looking.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = chordOf(event);
      if (!chord.ctrl || chord.shift || chord.alt || chord.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      if (!refreshing) onRefresh();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onRefresh, refreshing]);

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
          {/* Labelled, not icon-only: "Refresh" says what it does at rest. */}
          <button className="btn ghost switcher-refresh" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
            Refresh
            <kbd>Ctrl+R</kbd>
          </button>
        </div>

        {/* The failure is news, not a wipe: the previous list stays below, and
            the Refresh button above is the retry. */}
        {refreshError !== null && (
          <p className="switcher-error">
            <Icon name="warning" size={13} />
            <span>Your repo list could not be refreshed. {refreshError}</span>
          </p>
        )}

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
