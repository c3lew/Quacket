// @vitest-environment jsdom
/**
 * The draft screen tests.
 *
 * Written from what the user is being asked to DO, not from the components: the
 * similar-issue card asks someone to redirect their report into an existing
 * issue, so the tests are about whether that decision is actually makeable —
 * can they read the candidate, can they choose it, can they ignore it.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RefinedDraft, SimilarIssue } from '../../core/types.ts';
import { DraftView, type DraftViewProps } from './Stages.tsx';

afterEach(cleanup);

const REFINED: RefinedDraft = {
  type: 'bug',
  title: 'Palette forgets the last repo after an update',
  sections: [{ heading: 'Repro steps', body: '1. Update\n2. Summon' }],
  followUps: [],
  similarIssues: [],
};

const CANDIDATES: SimilarIssue[] = [
  { number: 12, title: 'Last repo is not restored on launch', reason: 'Same symptom after an update.' },
  { number: 31, title: 'Repo pill shows "Choose a repo"', reason: 'Also about the remembered repo.' },
];

function show(props: Partial<DraftViewProps> = {}) {
  const spies = {
    onChooseSimilar: vi.fn(),
    onOpenIssue: vi.fn(),
  };
  render(
    <DraftView
      raw="repo keeps forgetting itself"
      refined={REFINED}
      answers={[]}
      candidates={CANDIDATES}
      selected={null}
      failure={null}
      stage="draft"
      onSetType={vi.fn()}
      onEditTitle={vi.fn()}
      onEditSection={vi.fn()}
      onAnswer={vi.fn()}
      onRecover={vi.fn()}
      {...spies}
      {...props}
    />,
  );
  return spies;
}

describe('the similar-issue card', () => {
  /**
   * The blocker: you cannot judge "is my report the same as #12?" from a title.
   * Every candidate must be readable BEFORE it is chosen, from the card itself.
   */
  it('every candidate can be opened in the browser without choosing it first', () => {
    const { onOpenIssue, onChooseSimilar } = show();

    fireEvent.click(screen.getByRole('button', { name: /open issue #12 in browser/i }));
    expect(onOpenIssue).toHaveBeenCalledWith(12);

    fireEvent.click(screen.getByRole('button', { name: /open issue #31 in browser/i }));
    expect(onOpenIssue).toHaveBeenNthCalledWith(2, 31);

    // Reading is not choosing: the submit target must not have moved.
    expect(onChooseSimilar).not.toHaveBeenCalled();
  });

  it('choosing a candidate is still one click, and reading has not replaced it', () => {
    const { onChooseSimilar } = show();

    fireEvent.click(screen.getByRole('button', { name: /Last repo is not restored on launch/ }));
    expect(onChooseSimilar).toHaveBeenCalledWith(12);
  });

  it('a chosen candidate is the one shown as chosen', () => {
    show({ selected: 31 });

    expect(screen.getByRole('button', { name: /Repo pill shows/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Last repo is not restored/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching back to a new issue stays one click away from a chosen candidate', () => {
    const { onChooseSimilar } = show({ selected: 12 });

    fireEvent.click(screen.getByRole('button', { name: /Last repo is not restored on launch/ }));
    expect(onChooseSimilar).toHaveBeenCalledWith(12);
  });

  it('stays inline and ignorable: no dialog, and the draft is still editable behind it', () => {
    show();

    expect(screen.queryByRole('dialog')).toBeNull();
    // The card sits below the draft rather than over it — the title is still there to edit.
    expect(screen.getByDisplayValue('Palette forgets the last repo after an update')).toBeInTheDocument();
  });

  it('no card at all when the refiner found nothing similar', () => {
    show({ candidates: [] });

    expect(screen.queryByText('Similar open issues')).toBeNull();
    expect(screen.queryByRole('button', { name: /open issue/i })).toBeNull();
  });

  it('the reason for each candidate is on screen, not behind a hover', () => {
    show();

    expect(screen.getByText('Same symptom after an update.')).toBeInTheDocument();
    expect(screen.getByText('Also about the remembered repo.')).toBeInTheDocument();
  });
});
