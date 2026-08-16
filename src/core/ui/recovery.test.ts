/**
 * What the palette says about an unfinished report — checked as SENTENCES,
 * because that is the whole deliverable here. The reducer test next door pins
 * when a notice appears; this one pins what it reads like when it does.
 */

import { describe, expect, it } from 'vitest';

import type { FilingReceipt, RecoveryEvent } from '../filing/filing.ts';
import { recoveryAlert, recoveryNotice, upsertRecovery } from './recovery.ts';

const receipt = (over: Partial<FilingReceipt> = {}): FilingReceipt => ({
  url: 'https://github.com/c3lew/Quacket/issues/42',
  issueNumber: 42,
  filingId: 'fil_1',
  repo: 'c3lew/Quacket',
  target: { kind: 'new-issue' },
  title: 'Tray icon disappears',
  ...over,
});

const EVENTS: RecoveryEvent[] = [
  { state: 'checking', filingId: 'fil_1' },
  { state: 'pending', filingId: 'fil_1', message: 'Could not check GitHub for this report.' },
  { state: 'filed', filingId: 'fil_1', receipt: receipt() },
  { state: 'failed', filingId: 'fil_1', kind: 'upload_failed', message: 'Could not upload a screenshot.' },
];

describe('the four things recovery can say', () => {
  it('says a different, plain sentence for each one', () => {
    const texts = EVENTS.map((e) => recoveryNotice(e).text);

    expect(new Set(texts).size).toBe(4);
    expect(texts[0]).toBe('Still checking your report from last time…');
    expect(texts[1]).toContain('still pending');
    expect(texts[2]).toBe('Your report from last time was filed as issue #42.');
    expect(texts[3]).toContain('safe to try again');
  });

  it('offers at most one action, and never a blind send while duplicate safety is unknown', () => {
    const [checking, pending, filed, failed] = EVENTS.map((e) => recoveryNotice(e).action);

    // A lookup is already in flight; the honest next action is to keep working.
    expect(checking).toBeNull();
    // Pending means we do not know, so the only offer is another LOOK — and it
    // names the report it is about, so it cannot reach any other one.
    expect(pending).toEqual({ kind: 'check', label: 'Check again', filingId: 'fil_1' });
    // The url rides along, so acting on it never goes back to the event.
    expect(filed).toEqual({
      kind: 'open',
      label: 'View on GitHub',
      url: 'https://github.com/c3lew/Quacket/issues/42',
    });
    // Failed is the one state with durable evidence nothing was created — and it
    // still goes through the same re-proving pass rather than a blind resume.
    expect(failed).toEqual({ kind: 'check', label: 'Try again', filingId: 'fil_1' });
  });

  it('never dresses good news in the colours of a problem', () => {
    expect(EVENTS.map((e) => recoveryNotice(e).tone)).toEqual(['busy', 'info', 'good', 'warn']);
  });

  it('says where a comment landed, not where an issue did', () => {
    const notice = recoveryNotice({
      state: 'filed',
      filingId: 'fil_1',
      receipt: receipt({ target: { kind: 'comment', issueNumber: 7 }, issueNumber: 7 }),
    });

    expect(notice.text).toBe('Your report from last time was added to issue #7.');
  });

  /*
   * The rule that has no other enforcement: everything the user reads about
   * recovery is written here, so a term from the machinery leaking into the UI
   * has to pass through this list first.
   */
  it('never names anything from inside the machine', () => {
    // The lookup's own message is deliberately excluded: it is written plainly
    // at its source and shown verbatim, so what is under test here is the
    // sentence Quacket wraps around it.
    const OURS: RecoveryEvent[] = [
      { state: 'checking', filingId: 'fil_1' },
      { state: 'pending', filingId: 'fil_1', message: '' },
      { state: 'filed', filingId: 'fil_1', receipt: receipt() },
      { state: 'failed', filingId: 'fil_1', kind: 'upload_failed', message: '' },
    ];
    const INTERNAL = [
      'marker',
      'journal',
      'receipt',
      'atomic',
      'handoff',
      'snapshot',
      'workspace',
      'filing',
      'reconcil',
      'pagination',
      'upload',
      'appdata',
      'quacket-filing',
      '\\',
      '/filings/',
    ];
    // Buttons are read too, and are written here like every other sentence, so
    // the guard covers them rather than trusting today's labels to stay clean.
    const words = [
      ...OURS.map((e) => recoveryNotice(e).text),
      ...OURS.map((e) => recoveryNotice(e).action?.label ?? ''),
      ...OURS.map((e) => recoveryAlert(e) ?? ''),
    ].join(' | ');

    for (const term of INTERNAL) expect(words.toLowerCase()).not.toContain(term);
  });
});

describe('the tray notification', () => {
  it('fires for a conclusion and for nothing else', () => {
    expect(EVENTS.map((e) => recoveryAlert(e))).toEqual([
      null,
      null,
      'Your report from last time was filed as issue #42.',
      'Your report from last time was not sent. Open Quacket to try again.',
    ]);
  });
});

describe('the status list', () => {
  it('replaces the earlier word on one report and keeps the others in place', () => {
    const list = upsertRecovery(
      upsertRecovery([], { state: 'checking', filingId: 'a' }),
      { state: 'checking', filingId: 'b' },
    );
    const next = upsertRecovery(list, { state: 'pending', filingId: 'a', message: 'x' });

    expect(next.map((e) => [e.filingId, e.state])).toEqual([
      ['a', 'pending'],
      ['b', 'checking'],
    ]);
  });
});
