import { describe, expect, it } from 'vitest';

import type { RefinedDraft } from '../../core/types.ts';
import { drain, hostReduce, initialHost, type Host, type HostAction } from './host.ts';

const draft = (): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after explorer.exe restarts',
  sections: [{ heading: 'Actual', body: 'The icon is gone.' }],
  followUps: [],
  similarIssues: [],
});

const run = (actions: HostAction[], from: Host = initialHost()): Host =>
  actions.reduce(hostReduce, from);

/** A hidden machine parked on the draft screen, mid-submit — where story 27 lives. */
const submittingWhileHidden = (): Host =>
  run([
    { type: 'edit-raw', raw: 'tray icon vanished after explorer restart' },
    { type: 'refine' },
    { type: 'refine-ok', draft: draft() },
    { type: 'submit' },
    { type: 'esc' },
    drain(3), // the refine, the submit and the hide have all been performed
  ]);

describe('the effect queue', () => {
  it('keeps a batch of dispatches from swallowing each other’s effects', () => {
    // Exactly what runSubmit does on the failure path: dispatch the failure, then
    // record the uploaded blobs in a `finally`. React commits both as ONE state.
    const host = run(
      [
        { type: 'submit-failed', error: { kind: 'create_failed', message: 'gh exploded' } },
        { type: 'images-uploaded', uploaded: [] },
      ],
      submittingWhileHidden(),
    );

    expect(host.pending).toEqual([{ type: 'notify', message: 'gh exploded' }]);
  });

  it('preserves effects from several dispatches in order', () => {
    const host = run([{ type: 'refine' }, { type: 'esc' }], run([{ type: 'edit-raw', raw: 'x' }]));

    expect(host.pending).toEqual([{ type: 'refine' }, { type: 'hide' }]);
  });

  it('drains only what the host says it performed', () => {
    const host = run([{ type: 'refine' }, { type: 'esc' }], run([{ type: 'edit-raw', raw: 'x' }]));
    const drained = hostReduce(host, drain(1));

    expect(drained.pending).toEqual([{ type: 'hide' }]);
  });

  it('empties the queue once everything in it has been performed', () => {
    const host = run([{ type: 'refine' }], run([{ type: 'edit-raw', raw: 'x' }]));

    expect(hostReduce(host, drain(host.pending.length)).pending).toEqual([]);
  });

  it('does not grow the queue over a long-lived session of effect-free edits', () => {
    // The window lives for days; a queue that only ever appended would leak.
    const host = run([
      { type: 'edit-raw', raw: 'a' },
      { type: 'edit-raw', raw: 'ab' },
      { type: 'edit-raw', raw: 'abc' },
    ]);

    expect(host.pending).toEqual([]);
  });

  it('leaves the machine’s own state exactly as the reducer decided', () => {
    const host = run([{ type: 'edit-raw', raw: 'tray icon gone' }, { type: 'refine' }]);

    expect(host.state.stage).toBe('refining');
    expect(host.state.raw).toBe('tray icon gone');
  });
});
