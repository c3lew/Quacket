import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../testing/fake-runner.ts';
import { createGitHub } from './github.ts';

/**
 * Discovery only. Every WRITE — upload, body rendering, issue and comment
 * creation — moved to `core/filing/filing.test.ts` with the code, so nothing
 * here duplicates a test below the Filing interface.
 */

const github = (runner: FakeRunner) => createGitHub(runner);

const scriptedRunner = () =>
  new FakeRunner().on({ cmd: 'gh', argsContain: ['auth', 'status'] }, { stdout: 'github.com ✓ Logged in' });

const ghCalls = (runner: FakeRunner) => runner.calls.filter((c) => c.cmd === 'gh');

describe('checkAuth', () => {
  it('runs `gh auth status` and reports ok when signed in', async () => {
    const runner = scriptedRunner();
    const result = await github(runner).checkAuth();

    expect(result).toEqual({ ok: true });
    expect(ghCalls(runner)[0]?.args).toEqual(['auth', 'status']);
  });

  it('reports not-ok with a plain-language message when gh exits non-zero', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['auth', 'status'] },
      { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' },
    );
    const result = await github(runner).checkAuth();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('gh auth login');
  });
});

describe('listRepos', () => {
  it('asks for the fields it needs and keeps only push-access repos', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['repo', 'list'] },
      {
        stdout: JSON.stringify([
          { isPrivate: true, nameWithOwner: 'c3lew/Quacket', viewerPermission: 'ADMIN' },
          { isPrivate: false, nameWithOwner: 'c3lew/Pushy', viewerPermission: 'WRITE' },
          { isPrivate: false, nameWithOwner: 'c3lew/Kept', viewerPermission: 'MAINTAIN' },
          { isPrivate: false, nameWithOwner: 'other/ReadOnly', viewerPermission: 'READ' },
          { isPrivate: false, nameWithOwner: 'other/Triage', viewerPermission: 'TRIAGE' },
          { isPrivate: false, nameWithOwner: 'other/None', viewerPermission: null },
        ]),
      },
    );

    const repos = await github(runner).listRepos();

    expect(ghCalls(runner)[0]?.args).toEqual([
      'repo',
      'list',
      '--limit',
      '100',
      '--json',
      'nameWithOwner,isPrivate,viewerPermission',
    ]);
    expect(repos).toEqual([
      { nameWithOwner: 'c3lew/Quacket', isPrivate: true },
      { nameWithOwner: 'c3lew/Pushy', isPrivate: false },
      { nameWithOwner: 'c3lew/Kept', isPrivate: false },
    ]);
  });
});

describe('listOpenIssues', () => {
  it('runs the exact gh argv and returns issues newest-updated first', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'list'] },
      {
        // Shape captured from gh 2.90.0 against cli/cli.
        stdout: JSON.stringify([
          { labels: [{ name: 'needs-triage' }], number: 13881, title: 'older', updatedAt: '2026-07-14T21:31:40Z' },
          { labels: [], number: 13880, title: 'newest', updatedAt: '2026-07-14T22:34:35Z' },
          { labels: [{ name: 'bug' }], number: 13876, title: 'oldest', updatedAt: '2026-07-14T11:41:07Z' },
        ]),
      },
    );

    const issues = await github(runner).listOpenIssues('cli/cli');

    expect(ghCalls(runner)[0]?.args).toEqual([
      'issue',
      'list',
      '--repo',
      'cli/cli',
      '--limit',
      '100',
      '--json',
      'number,title,labels,updatedAt',
    ]);
    expect(issues.map((i) => i.title)).toEqual(['newest', 'older', 'oldest']);
    expect(issues[0]).toEqual({ number: 13880, title: 'newest', labels: [], updatedAt: '2026-07-14T22:34:35Z' });
    expect(issues[2]?.labels).toEqual(['bug']);
  });
});
