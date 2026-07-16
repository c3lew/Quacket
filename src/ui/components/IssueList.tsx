/**
 * The read-only open-issue list — the palette's second view.
 *
 * Read-only on purpose: this is orientation ("has someone already filed this?"),
 * not a triage tool. Enter or a click opens the real issue in the browser, which
 * is where anything beyond reading actually happens.
 */

import { useEffect, useRef, useState } from 'react';

import type { OpenIssue } from '../../core/types.ts';
import { relativeTime } from './format.ts';
import { Icon, Spinner } from './icons.tsx';

export interface IssueListProps {
  issues: OpenIssue[];
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (issue: OpenIssue) => void;
}

export function IssueList({ issues, loading, error, now, onOpen }: IssueListProps) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const active = Math.min(cursor, Math.max(0, issues.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  if (loading) {
    return (
      <div className="status">
        <Spinner />
        <span>Loading open issues…</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="errorcard">
        <span className="warn-icon">
          <Icon name="warning" size={14} />
        </span>
        <div className="warn-main">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (issues.length === 0) {
    return <p className="empty">No open issues in this repo.</p>;
  }

  return (
    <div
      className="issues"
      ref={listRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCursor((c) => Math.min(issues.length - 1, c + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCursor((c) => Math.max(0, c - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const issue = issues[active];
          if (issue !== undefined) onOpen(issue);
        }
      }}
    >
      {issues.map((issue, i) => (
        <button
          key={issue.number}
          className={i === active ? 'issue-row on' : 'issue-row'}
          data-active={i === active}
          onMouseMove={() => setCursor(i)}
          onClick={() => onOpen(issue)}
        >
          <span className="num">#{issue.number}</span>
          <span className="issue-title">{issue.title}</span>
          {issue.labels.slice(0, 2).map((label) => (
            <span className="tag" key={label}>
              {label}
            </span>
          ))}
          <span className="issue-when">{relativeTime(issue.updatedAt, now)}</span>
          <Icon name="external" size={12} />
        </button>
      ))}
    </div>
  );
}
