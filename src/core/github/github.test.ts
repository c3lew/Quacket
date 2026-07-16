import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../testing/fake-runner.ts';
import { initialState, reduce, type Action, type UiState } from '../ui/reducer.ts';
import type { Draft, ImageAttachment, RefinedDraft, Repo } from '../types.ts';
import { createGitHub } from './github.ts';

// Fixed clock so asset paths — and therefore argv — are deterministic.
const NOW = () => new Date('2026-07-16T09:30:00.000Z');
const STAMP = '2026-07-16T09-30-00-000Z';

const PUBLIC_REPO: Repo = { nameWithOwner: 'c3lew/Quacket', isPrivate: false };
const PRIVATE_REPO: Repo = { nameWithOwner: 'c3lew/Vouch', isPrivate: true };

const github = (runner: FakeRunner) => createGitHub(runner, { now: NOW });

const image = (id: string, over: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id,
  bytes: new Uint8Array([137, 80, 78, 71]),
  mediaType: 'image/png',
  annotated: false,
  ...over,
});

const refined = (over: Partial<RefinedDraft> = {}): RefinedDraft => ({
  type: 'bug',
  title: 'Tray icon disappears after unlocking Windows',
  sections: [{ heading: 'Actual', body: 'The icon is gone.' }],
  followUps: [],
  similarIssues: [],
  ...over,
});

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'draft_1',
  repo: 'c3lew/Quacket',
  raw: 'tray icon vanished',
  images: [],
  refined: refined(),
  target: { kind: 'new-issue' },
  ...over,
});

/** Every happy-path spawn the pipeline can make, scripted as verified fixtures. */
const scriptedRunner = () =>
  new FakeRunner()
    .on({ cmd: 'gh', argsContain: ['auth', 'status'] }, { stdout: 'github.com\n  ✓ Logged in' })
    // gh 2.90.0: a missing ref exits 1 with the 404 body on stdout.
    .on(
      { cmd: 'gh', argsContain: ['api'] },
      { exitCode: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)' },
    )
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/trees'] }, { stdout: '{"sha":"tree1"}' })
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/commits'] }, { stdout: '{"sha":"commit1"}' })
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/refs'] }, { stdout: '{"ref":"refs/heads/quacket-assets"}' })
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Vouch/git/trees'] }, { stdout: '{"sha":"tree1"}' })
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Vouch/git/commits'] }, { stdout: '{"sha":"commit1"}' })
    .on({ cmd: 'gh', argsContain: ['repos/c3lew/Vouch/git/refs'] }, { stdout: '{"ref":"refs/heads/quacket-assets"}' })
    .on({ cmd: 'gh', argsContain: ['--method', 'PUT'] }, { stdout: '{"commit":{"sha":"abc123def"}}' })
    .on({ cmd: 'gh', argsContain: ['label', 'list'] }, { stdout: '[{"name":"bug"},{"name":"enhancement"}]' })
    .on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { stdout: 'https://github.com/c3lew/Quacket/issues/42\n' },
    )
    .on(
      { cmd: 'gh', argsContain: ['issue', 'comment'] },
      { stdout: 'https://github.com/c3lew/Quacket/issues/7#issuecomment-991\n' },
    );

/**
 * Drives the REAL reducer, then hands the REAL resulting state to submit(). The
 * no-fabrication rule is a property of what reaches GitHub, so these cases refuse
 * to hand-build the RefinedDraft the recovery path produces — a hand-built one
 * would only prove renderBody agrees with the test author.
 */
const driveReducer = (over: Partial<UiState>, actions: Action[]): UiState =>
  actions.reduce((s, a) => reduce(s, a).state, { ...initialState(), ...over });

const draftFrom = (state: UiState): Draft => ({
  id: 'draft_1',
  repo: 'c3lew/Quacket',
  raw: state.raw,
  images: state.images,
  ...(state.refined === null ? {} : { refined: state.refined }),
  target: state.target,
});

/**
 * The no-fabrication rule as a structural property of the finished body: every
 * heading is followed by real content, and no heading is bare. Returns the
 * offending lines so a failure names them.
 */
const emptyHeadings = (body: string): string[] => {
  const lines = body.split('\n');
  return lines.filter((line, i) => {
    if (!line.trimEnd().startsWith('##')) return false;
    if (line.trim() === '##') return true; // a bare `##` the user never typed
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    return next === undefined || next.trimEnd().startsWith('##');
  });
};

const ghCalls = (runner: FakeRunner) => runner.calls.filter((c) => c.cmd === 'gh');
const uploadCalls = (runner: FakeRunner) =>
  runner.calls.filter((c) => c.args.includes('--method') && c.args.includes('PUT'));

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

describe('listLabels', () => {
  it('runs the exact gh argv and returns label names', async () => {
    const runner = scriptedRunner();
    const labels = await github(runner).listLabels('cli/cli');

    expect(ghCalls(runner)[0]?.args).toEqual([
      'label',
      'list',
      '--repo',
      'cli/cli',
      '--limit',
      '100',
      '--json',
      'name',
    ]);
    expect(labels).toEqual(['bug', 'enhancement']);
  });

  it('returns [] when gh prints empty stdout for a repo with no labels', async () => {
    // gh 2.90.0 prints zero bytes here, not `[]` — JSON.parse('') would throw.
    const runner = scriptedRunner().on({ cmd: 'gh', argsContain: ['label', 'list'] }, { stdout: '' });

    await expect(github(runner).listLabels('c3lew/Bare')).resolves.toEqual([]);
  });
});

describe('uploadImages', () => {
  it('creates the orphan assets branch, then PUTs the image and pins the raw URL', async () => {
    const runner = scriptedRunner();
    const img = image('img_1');

    const result = await github(runner).uploadImages(PUBLIC_REPO, [img]);

    const calls = ghCalls(runner);
    expect(calls[0]?.args).toEqual(['api', 'repos/c3lew/Quacket/git/ref/heads/quacket-assets']);

    // Orphan = a commit with no parents.
    expect(calls[2]?.args).toEqual([
      'api',
      '--method',
      'POST',
      'repos/c3lew/Quacket/git/commits',
      '--input',
      '-',
    ]);
    expect(JSON.parse(calls[2]?.stdin ?? '{}')).toMatchObject({ tree: 'tree1', parents: [] });

    expect(calls[3]?.args).toEqual(['api', '--method', 'POST', 'repos/c3lew/Quacket/git/refs', '--input', '-']);
    expect(JSON.parse(calls[3]?.stdin ?? '{}')).toMatchObject({ ref: 'refs/heads/quacket-assets', sha: 'commit1' });

    const path = `.quacket/assets/${STAMP}-img_1.png`;
    expect(calls[4]?.args).toEqual([
      'api',
      '--method',
      'PUT',
      `repos/c3lew/Quacket/contents/${path}`,
      '--input',
      '-',
    ]);
    // Base64 rides stdin: a real screenshot would blow the Windows argv limit.
    expect(JSON.parse(calls[4]?.stdin ?? '{}')).toEqual({
      message: `Add ${path}`,
      content: 'iVBORw==',
      branch: 'quacket-assets',
    });

    expect(result[0]?.uploadedUrl).toBe(`https://raw.githubusercontent.com/c3lew/Quacket/abc123def/${path}`);
  });

  it('emits a blob link URL for a private repo, never a raw URL', async () => {
    const runner = scriptedRunner();
    const [img] = await github(runner).uploadImages(PRIVATE_REPO, [image('img_1')]);

    expect(img?.uploadedUrl).toBe(
      `https://github.com/c3lew/Vouch/blob/abc123def/.quacket/assets/${STAMP}-img_1.png`,
    );
    expect(img?.uploadedUrl).not.toContain('raw.githubusercontent.com');
  });

  it('skips branch creation when quacket-assets already exists', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/ref/heads/quacket-assets'] },
      { stdout: '{"ref":"refs/heads/quacket-assets"}' },
    );

    await github(runner).uploadImages(PUBLIC_REPO, [image('img_1')]);

    expect(ghCalls(runner).map((c) => c.args[3])).not.toContain('repos/c3lew/Quacket/git/refs');
    expect(uploadCalls(runner)).toHaveLength(1);
  });

  it('reuses an existing uploadedUrl and spawns nothing at all', async () => {
    const runner = scriptedRunner();
    const done = image('img_1', { uploadedUrl: 'https://raw.githubusercontent.com/c3lew/Quacket/old/a.png' });

    const result = await github(runner).uploadImages(PUBLIC_REPO, [done]);

    expect(runner.calls).toHaveLength(0);
    expect(result[0]?.uploadedUrl).toBe('https://raw.githubusercontent.com/c3lew/Quacket/old/a.png');
  });

  it('uploads only the image that is missing a URL', async () => {
    const runner = scriptedRunner();
    const done = image('img_1', { uploadedUrl: 'https://raw.githubusercontent.com/c3lew/Quacket/old/a.png' });

    await github(runner).uploadImages(PUBLIC_REPO, [done, image('img_2')]);

    const uploads = uploadCalls(runner);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args[3]).toBe(`repos/c3lew/Quacket/contents/.quacket/assets/${STAMP}-img_2.png`);
  });

  it('reports upload_failed when the Contents API rejects the write', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['--method', 'PUT'] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );

    await expect(github(runner).uploadImages(PUBLIC_REPO, [image('img_1')])).rejects.toMatchObject({
      kind: 'upload_failed',
    });
  });

  /**
   * A repo with no commits refuses the whole Git Data API. Live-verified
   * 2026-07-16 against a fresh private repo — the stderr below is the real gh
   * 2.90.0 output, not a guess. The Contents API *would* work, but on an empty
   * repo the branch it creates becomes the DEFAULT branch (also live-verified),
   * fronting the user's new project with a Quacket README — so the honest move
   * is a plain-language refusal that routes to [File without images].
   */
  it('explains an empty repo in plain language instead of a generic upload error', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/trees'] },
      {
        exitCode: 1,
        stdout: '{"message":"Git Repository is empty.","documentation_url":"https://docs.github.com/rest/git/trees#create-a-tree","status":"409"}',
        stderr: 'gh: Git Repository is empty. (HTTP 409)',
      },
    );

    await expect(github(runner).uploadImages(PUBLIC_REPO, [image('img_1')])).rejects.toMatchObject({
      kind: 'upload_failed',
      message: expect.stringContaining('no commits yet'),
    });
  });
});

describe('submit — new issue', () => {
  it('uploads before creating, and embeds the resulting URL in the body', async () => {
    const runner = scriptedRunner();
    const img = image('img_1');
    const d = draft({
      images: [img],
      refined: refined({
        sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![screenshot](quacket-image:img_1)' }],
      }),
    });

    const result = await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const calls = ghCalls(runner);
    const uploadAt = calls.findIndex((c) => c.args.includes('PUT'));
    const createAt = calls.findIndex((c) => c.args.includes('create'));
    expect(uploadAt).toBeGreaterThanOrEqual(0);
    expect(uploadAt).toBeLessThan(createAt);

    const create = calls[createAt];
    expect(create?.args).toEqual([
      'issue',
      'create',
      '--repo',
      'c3lew/Quacket',
      '--title',
      'Tray icon disappears after unlocking Windows',
      '--body-file',
      '-',
      '--label',
      'bug',
    ]);
    expect(create?.stdin).toBe(
      `## Actual\n\nThe icon is gone.\n\n![screenshot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n`,
    );
    expect(result).toEqual({ url: 'https://github.com/c3lew/Quacket/issues/42', issueNumber: 42 });
  });

  it('degrades an image embed to a link for a private repo', async () => {
    const runner = scriptedRunner();
    const d = draft({
      images: [image('img_1')],
      refined: refined({
        sections: [{ heading: 'Actual', body: '![annotated screenshot](quacket-image:img_1)' }],
      }),
    });

    await github(runner).submit(PRIVATE_REPO, d, { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';
    expect(body).toContain(
      `[annotated screenshot](https://github.com/c3lew/Vouch/blob/abc123def/.quacket/assets/${STAMP}-img_1.png)`,
    );
    // A private raw URL renders as a broken image, so no embed may survive.
    expect(body).not.toContain('![');
  });

  it('strips image placeholders when filing without images', async () => {
    const runner = scriptedRunner();
    const d = draft({
      images: [],
      refined: refined({
        sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![screenshot](quacket-image:img_1)' }],
      }),
    });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const calls = ghCalls(runner);
    expect(uploadCalls(runner)).toHaveLength(0);
    const body = calls.find((c) => c.args.includes('create'))?.stdin ?? '';
    expect(body).toBe('## Actual\n\nThe icon is gone.\n');
    expect(body).not.toContain('quacket-image:');
  });

  it('drops a section whose only content was an image when filing without images', async () => {
    const runner = scriptedRunner();
    const state = driveReducer(
      {
        stage: 'draft',
        raw: 'tray icon vanished',
        images: [image('img_1')],
        refined: refined({
          sections: [
            { heading: 'Repro steps', body: '1. Lock Windows\n2. Unlock' },
            // The whole section was the screenshot. Strip the ref and the
            // heading stands over nothing.
            { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
          ],
        }),
      },
      [{ type: 'file-without-images' }],
    );

    await github(runner).submit(PUBLIC_REPO, draftFrom(state), { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';

    // Exact equality: the Actual section is ABSENT, not present-and-empty.
    expect(body).toBe('## Repro steps\n\n1. Lock Windows\n2. Unlock\n');
    expect(body).not.toContain('## Actual');
    expect(emptyHeadings(body)).toEqual([]);
  });

  it('keeps a section whose text survives alongside a stripped image', async () => {
    const runner = scriptedRunner();
    const state = driveReducer(
      {
        stage: 'draft',
        raw: 'tray icon vanished',
        images: [image('img_1')],
        refined: refined({
          sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![screenshot](quacket-image:img_1)' }],
        }),
      },
      [{ type: 'file-without-images' }],
    );

    await github(runner).submit(PUBLIC_REPO, draftFrom(state), { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';
    expect(body).toBe('## Actual\n\nThe icon is gone.\n');
  });

  it('emits no heading at all on the file-as-is path', async () => {
    const runner = scriptedRunner();
    const raw = 'refine 轉圈圈 stuck forever, 每次按都一樣';
    const state = driveReducer({ raw }, [{ type: 'file-as-is' }]);

    // The reducer deliberately carries no heading: nothing here was classified.
    expect(state.refined?.sections).toEqual([{ heading: '', body: raw }]);

    await github(runner).submit(PUBLIC_REPO, draftFrom(state), { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';

    // The raw dump verbatim and nothing else — no bare `##` the user never typed.
    expect(body).toBe(`${raw}\n`);
    expect(body).not.toContain('#');
    expect(emptyHeadings(body)).toEqual([]);
  });

  it('files the raw dump, not an empty body, when every section was image-only', async () => {
    const runner = scriptedRunner();
    const state = driveReducer(
      {
        stage: 'draft',
        raw: 'look at this',
        images: [image('img_1')],
        refined: refined({ sections: [{ heading: 'Actual', body: '![screenshot](quacket-image:img_1)' }] }),
      },
      [{ type: 'file-without-images' }],
    );

    await github(runner).submit(PUBLIC_REPO, draftFrom(state), { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';
    // This assertion used to pin `''` — an honest empty body over empty
    // scaffolding. The reducer now floors that case with the raw dump instead
    // (the user's own words, so still zero fabrication), and this test drives
    // the real reducer precisely so it fails when that decision moves.
    expect(body).toBe('look at this\n');
    expect(body).not.toContain('#');
    expect(emptyHeadings(body)).toEqual([]);
  });

  it('drops an emptied section on the comment path too', async () => {
    const runner = scriptedRunner();
    const state = driveReducer(
      {
        stage: 'draft',
        raw: 'same bug again',
        images: [image('img_1')],
        target: { kind: 'comment', issueNumber: 7 },
        refined: refined({
          sections: [
            { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
            { heading: 'Expected', body: 'The icon stays.' },
          ],
        }),
      },
      [{ type: 'file-without-images' }],
    );

    await github(runner).submit(PUBLIC_REPO, draftFrom(state), { kind: 'comment', issueNumber: 7 });

    const body = ghCalls(runner).find((c) => c.args.includes('comment'))?.stdin ?? '';
    expect(body).toBe('## Expected\n\nThe icon stays.\n');
  });

  it('drops a section left empty by a hallucinated image ref', async () => {
    const runner = scriptedRunner();
    // No such image was ever attached: the model invented the ref.
    const d = draft({
      images: [],
      refined: refined({
        sections: [
          { heading: 'Actual', body: '![proof](quacket-image:img_99)' },
          { heading: 'Expected', body: 'The icon stays.' },
        ],
      }),
    });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';
    expect(body).toBe('## Expected\n\nThe icon stays.\n');
  });

  it('skips a label the repo does not have, and never creates one', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['label', 'list'] },
      { stdout: '[{"name":"bug"},{"name":"documentation"}]' },
    );
    const d = draft({ refined: refined({ type: 'feature' }) });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const calls = ghCalls(runner);
    expect(calls.find((c) => c.args.includes('create'))?.args).not.toContain('--label');
    expect(calls.some((c) => c.args.includes('label') && c.args.includes('create'))).toBe(false);
  });

  it('applies `enhancement` for a feature when the repo has it', async () => {
    const runner = scriptedRunner();
    const d = draft({ refined: refined({ type: 'feature' }) });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const args = ghCalls(runner).find((c) => c.args.includes('create'))?.args ?? [];
    expect(args.slice(-2)).toEqual(['--label', 'enhancement']);
  });

  it('applies no label for a chore, without even asking for the label list', async () => {
    const runner = scriptedRunner();
    const d = draft({ refined: refined({ type: 'chore' }) });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const calls = ghCalls(runner);
    expect(calls.find((c) => c.args.includes('create'))?.args).not.toContain('--label');
    expect(calls.some((c) => c.args.includes('label'))).toBe(false);
  });

  it('leaves no Quacket marker or footer anywhere in the body', async () => {
    const runner = scriptedRunner();
    const d = draft({
      images: [image('img_1')],
      refined: refined({
        sections: [
          { heading: 'Repro steps', body: '1. Lock Windows\n2. Unlock' },
          { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
        ],
      }),
    });

    await github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    const body = ghCalls(runner).find((c) => c.args.includes('create'))?.stdin ?? '';

    // Exact equality is the real proof: the body is the user's sections and the
    // rewritten URL, with nothing appended. (The word "quacket" does occur — in
    // the repo's own name and the asset path — so a substring check proves
    // nothing here.)
    expect(body).toBe(
      `## Repro steps\n\n1. Lock Windows\n2. Unlock\n\n## Actual\n\n![screenshot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n`,
    );
    // No hidden marker, no attribution footer, no trailing rule.
    expect(body).not.toContain('<!--');
    expect(body).not.toMatch(/filed with|generated (by|with)|powered by|created by quacket/i);
    expect(body).not.toMatch(/\n---\n/);
  });

  it('reuses an already-uploaded image on a retry after a failed create', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: Something went wrong (HTTP 502)' },
    );
    const d = draft({
      images: [image('img_1')],
      refined: refined({ sections: [{ heading: 'Actual', body: '![shot](quacket-image:img_1)' }] }),
    });

    await expect(github(runner).submit(PUBLIC_REPO, d, { kind: 'new-issue' })).rejects.toMatchObject({
      kind: 'create_failed',
    });
    expect(uploadCalls(runner)).toHaveLength(1);
    // The URL survives on the draft, which is what makes the retry duplicate-free.
    expect(d.images[0]?.uploadedUrl).toBeDefined();

    const retry = scriptedRunner();
    const result = await github(retry).submit(PUBLIC_REPO, d, { kind: 'new-issue' });

    expect(uploadCalls(retry)).toHaveLength(0);
    expect(retry.calls.some((c) => c.args.includes('repos/c3lew/Quacket/git/refs'))).toBe(false);
    expect(result.issueNumber).toBe(42);
  });
});

describe('submit — comment', () => {
  it('posts the report to an existing issue and attaches images the same way', async () => {
    const runner = scriptedRunner();
    const d = draft({
      images: [image('img_1')],
      refined: refined({ sections: [{ heading: 'Actual', body: '![shot](quacket-image:img_1)' }] }),
      target: { kind: 'comment', issueNumber: 7 },
    });

    const result = await github(runner).submit(PUBLIC_REPO, d, { kind: 'comment', issueNumber: 7 });

    const calls = ghCalls(runner);
    const uploadAt = calls.findIndex((c) => c.args.includes('PUT'));
    const commentAt = calls.findIndex((c) => c.args.includes('comment'));
    expect(uploadAt).toBeLessThan(commentAt);

    const comment = calls[commentAt];
    expect(comment?.args).toEqual(['issue', 'comment', '7', '--repo', 'c3lew/Quacket', '--body-file', '-']);
    expect(comment?.stdin).toBe(
      `## Actual\n\n![shot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n`,
    );
    // Commenting never touches labels.
    expect(calls.some((c) => c.args.includes('label'))).toBe(false);
    expect(result).toEqual({
      url: 'https://github.com/c3lew/Quacket/issues/7#issuecomment-991',
      issueNumber: 7,
    });
  });

  it('creates an issue rather than a comment when the target says new-issue', async () => {
    const runner = scriptedRunner();

    await github(runner).submit(PUBLIC_REPO, draft(), { kind: 'new-issue' });

    const calls = ghCalls(runner);
    expect(calls.some((c) => c.args.includes('create'))).toBe(true);
    expect(calls.some((c) => c.args.includes('comment'))).toBe(false);
  });
});
