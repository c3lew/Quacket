/**
 * The Filing transaction, driven through its real interface.
 *
 * Two real things and one fake: a real `DraftStore` over a real temp directory
 * (`nodeFiles`), the established `FakeRunner` behind the `gh` seam, and nothing
 * else stubbed. Every assertion is about something observable from outside —
 * what argv `gh` was handed, what is on disk afterwards, what `file` returned or
 * threw. Never a private helper, never a transition name.
 *
 * The tests that used to live in `github.test.ts` for upload and body rendering
 * moved here with the code, rather than being duplicated below the interface.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DraftStore } from '../drafts/store.ts';
import { joinPath, type FileStore } from '../files.ts';
import { FakeRunner } from '../testing/fake-runner.ts';
import { nodeFiles } from '../testing/node-files.ts';
import { initialState, reduce, type Action, type UiState } from '../ui/reducer.ts';
import type { Draft, ImageAttachment, RefinedDraft, Repo } from '../types.ts';
import {
  createFiling,
  filingMarker,
  type FilingCommand,
  type FilingDecision,
} from './filing.ts';

// Fixed clock so asset paths — and therefore argv — are deterministic.
const NOW = () => new Date('2026-07-16T09:30:00.000Z');
const STAMP = '2026-07-16T09-30-00-000Z';

const PUBLIC_REPO: Repo = { nameWithOwner: 'c3lew/Quacket', isPrivate: false };
const PRIVATE_REPO: Repo = { nameWithOwner: 'c3lew/Vouch', isPrivate: true };

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

const ghCalls = (runner: FakeRunner) => runner.calls.filter((c) => c.cmd === 'gh');
const uploadCalls = (runner: FakeRunner) =>
  runner.calls.filter((c) => c.args.includes('--method') && c.args.includes('PUT'));
const createCalls = (runner: FakeRunner) =>
  runner.calls.filter((c) => c.args.includes('create') || c.args.includes('comment'));
const sentBody = (runner: FakeRunner): string => createCalls(runner)[0]?.stdin ?? '';

/**
 * Drives the REAL reducer, then files the REAL resulting state. The
 * no-fabrication rule is a property of what reaches GitHub, so these cases refuse
 * to hand-build the RefinedDraft the recovery path produces — a hand-built one
 * would only prove the renderer agrees with the test author.
 */
const driveReducer = (over: Partial<UiState>, actions: Action[]): UiState =>
  actions.reduce((s, a) => reduce(s, a).state, { ...initialState(), ...over });

const draftFrom = (state: UiState): Draft =>
  draft({
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

/** What the user actually reads: the body with the invisible identity taken off. */
const visible = (body: string, id = 'fil_1'): string => body.replace(`\n${filingMarker(id)}\n`, '');

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  runner: FakeRunner;
  drafts: DraftStore;
  files: FileStore;
  /** Saves the draft the way the app does, then files it. */
  fileNew(
    d: Draft,
    repo?: Repo,
    decision?: FilingDecision,
  ): Promise<{ url: string; issueNumber: number; filingId: string }>;
  file(command: FilingCommand): Promise<{ url: string; issueNumber: number; filingId: string }>;
  /** Filing workspaces still on disk, i.e. cleanup that has not finished. */
  filings(): Promise<string[]>;
  snapshot(id: string): Promise<Record<string, unknown>>;
  /** Draft folders in the active slot. */
  draftDirs(): Promise<string[]>;
}

interface HarnessOptions {
  runner?: FakeRunner;
  files?: FileStore;
  /** Deterministic ids: the nth Filing is `fil_<n>`. */
  ids?: string[];
}

const withFiling = async (
  run: (h: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'quacket-filing-'));
  try {
    const runner = options.runner ?? scriptedRunner();
    const files = options.files ?? nodeFiles;
    const drafts = new DraftStore(dir, files);
    const ids = [...(options.ids ?? ['fil_1', 'fil_2', 'fil_3'])];
    const filing = createFiling({
      runner,
      files,
      drafts,
      baseDir: dir,
      now: NOW,
      newId: () => ids.shift() ?? 'fil_overflow',
    });

    await run({
      dir,
      runner,
      drafts,
      files,
      file: (command) => filing.file(command),
      fileNew: async (d, repo = PUBLIC_REPO, decision = 'as-captured') => {
        // Exactly how the app gets here: the draft is on disk before Submit.
        await drafts.save(d);
        for (const img of d.images) await drafts.attachImage(d, img);
        return filing.file({ kind: 'new', draft: d, repo, decision });
      },
      filings: async () => (await files.list(joinPath(dir, 'filings'))) ?? [],
      snapshot: async (id) =>
        JSON.parse(
          (await files.readText(joinPath(dir, 'filings', id, 'filing.json'))) ?? '{}',
        ) as Record<string, unknown>,
      draftDirs: async () => (await files.list(joinPath(dir, 'drafts'))) ?? [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** `nodeFiles` with one operation rigged to fail — deterministic fault injection. */
const breaking = (op: keyof FileStore, when: (path: string) => boolean): FileStore => ({
  ...nodeFiles,
  [op]: async (path: string, ...rest: unknown[]) => {
    if (when(path)) throw new Error(`injected ${op} failure`);
    return (nodeFiles[op] as (...a: unknown[]) => unknown)(path, ...rest);
  },
});

// ── Filing a new issue ──────────────────────────────────────────────────────

describe('filing a new issue', () => {
  it('uploads before creating, and embeds the resulting URL in the body', async () => {
    await withFiling(async (h) => {
      const receipt = await h.fileNew(
        draft({
          images: [image('img_1')],
          refined: refined({
            sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![screenshot](quacket-image:img_1)' }],
          }),
        }),
      );

      const calls = ghCalls(h.runner);
      const uploadAt = calls.findIndex((c) => c.args.includes('PUT'));
      const createAt = calls.findIndex((c) => c.args.includes('create'));
      expect(uploadAt).toBeGreaterThanOrEqual(0);
      expect(uploadAt).toBeLessThan(createAt);

      expect(calls[createAt]?.args).toEqual([
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
      expect(visible(calls[createAt]?.stdin ?? '')).toBe(
        `## Actual\n\nThe icon is gone.\n\n![screenshot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n`,
      );
      expect(receipt).toEqual({
        url: 'https://github.com/c3lew/Quacket/issues/42',
        issueNumber: 42,
        filingId: 'fil_1',
      });
    });
  });

  it('creates the orphan assets branch first, then PUTs the image over stdin', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft({ images: [image('img_1')] }));

      const calls = ghCalls(h.runner);
      expect(calls[0]?.args).toEqual(['api', 'repos/c3lew/Quacket/git/ref/heads/quacket-assets']);
      // Orphan = a commit with no parents.
      expect(JSON.parse(calls[2]?.stdin ?? '{}')).toMatchObject({ tree: 'tree1', parents: [] });
      expect(JSON.parse(calls[3]?.stdin ?? '{}')).toMatchObject({
        ref: 'refs/heads/quacket-assets',
        sha: 'commit1',
      });

      const path = `.quacket/assets/${STAMP}-img_1.png`;
      expect(uploadCalls(h.runner)[0]?.args).toEqual([
        'api',
        '--method',
        'PUT',
        `repos/c3lew/Quacket/contents/${path}`,
        '--input',
        '-',
      ]);
      // Base64 rides stdin: a real screenshot would blow the Windows argv limit.
      expect(JSON.parse(uploadCalls(h.runner)[0]?.stdin ?? '{}')).toEqual({
        message: `Add ${path}`,
        content: 'iVBORw==',
        branch: 'quacket-assets',
      });
    });
  });

  it('skips branch creation when quacket-assets already exists', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['repos/c3lew/Quacket/git/ref/heads/quacket-assets'] },
      { stdout: '{"ref":"refs/heads/quacket-assets"}' },
    );
    await withFiling(
      async (h) => {
        await h.fileNew(draft({ images: [image('img_1')] }));

        expect(ghCalls(h.runner).some((c) => c.args.includes('repos/c3lew/Quacket/git/refs'))).toBe(false);
        expect(uploadCalls(h.runner)).toHaveLength(1);
      },
      { runner },
    );
  });

  it('degrades an image embed to a link for a private repo', async () => {
    await withFiling(async (h) => {
      await h.fileNew(
        draft({
          repo: PRIVATE_REPO.nameWithOwner,
          images: [image('img_1')],
          refined: refined({
            sections: [{ heading: 'Actual', body: '![annotated screenshot](quacket-image:img_1)' }],
          }),
        }),
        PRIVATE_REPO,
      );

      const body = sentBody(h.runner);
      expect(body).toContain(
        `[annotated screenshot](https://github.com/c3lew/Vouch/blob/abc123def/.quacket/assets/${STAMP}-img_1.png)`,
      );
      // A private raw URL renders as a broken image, so no embed may survive.
      expect(body).not.toContain('![');
    });
  });

  it('applies `enhancement` for a feature when the repo has it', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft({ refined: refined({ type: 'feature' }) }));

      expect(createCalls(h.runner)[0]?.args.slice(-2)).toEqual(['--label', 'enhancement']);
    });
  });

  it('skips a label the repo does not have, and never creates one', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['label', 'list'] },
      { stdout: '[{"name":"bug"},{"name":"documentation"}]' },
    );
    await withFiling(
      async (h) => {
        await h.fileNew(draft({ refined: refined({ type: 'feature' }) }));

        expect(createCalls(h.runner)[0]?.args).not.toContain('--label');
        expect(ghCalls(h.runner).some((c) => c.args.includes('label') && c.args.includes('create'))).toBe(
          false,
        );
      },
      { runner },
    );
  });

  it('applies no label for a chore, without even asking for the label list', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft({ refined: refined({ type: 'chore' }) }));

      expect(createCalls(h.runner)[0]?.args).not.toContain('--label');
      expect(ghCalls(h.runner).some((c) => c.args.includes('label'))).toBe(false);
    });
  });
});

// ── Filing a comment ────────────────────────────────────────────────────────

describe('filing a comment', () => {
  it('posts to the existing issue and attaches images the same way', async () => {
    await withFiling(async (h) => {
      const receipt = await h.fileNew(
        draft({
          images: [image('img_1')],
          refined: refined({ sections: [{ heading: 'Actual', body: '![shot](quacket-image:img_1)' }] }),
          target: { kind: 'comment', issueNumber: 7 },
        }),
      );

      const calls = ghCalls(h.runner);
      const uploadAt = calls.findIndex((c) => c.args.includes('PUT'));
      const commentAt = calls.findIndex((c) => c.args.includes('comment'));
      expect(uploadAt).toBeLessThan(commentAt);

      expect(calls[commentAt]?.args).toEqual([
        'issue',
        'comment',
        '7',
        '--repo',
        'c3lew/Quacket',
        '--body-file',
        '-',
      ]);
      expect(visible(calls[commentAt]?.stdin ?? '')).toBe(
        `## Actual\n\n![shot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n`,
      );
      // Commenting never touches labels.
      expect(calls.some((c) => c.args.includes('label'))).toBe(false);
      expect(receipt).toEqual({
        url: 'https://github.com/c3lew/Quacket/issues/7#issuecomment-991',
        issueNumber: 7,
        filingId: 'fil_1',
      });
    });
  });

  it('creates an issue rather than a comment when the target says new-issue', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft());

      const calls = ghCalls(h.runner);
      expect(calls.some((c) => c.args.includes('create'))).toBe(true);
      expect(calls.some((c) => c.args.includes('comment'))).toBe(false);
    });
  });
});

// ── The hidden identity ─────────────────────────────────────────────────────

describe('the Filing identity in the remote body', () => {
  /**
   * The identity is assigned BEFORE the first remote write, which is what makes a
   * later reconciliation possible at all: a report that reached GitHub always
   * carries the exact id Quacket can look for.
   */
  it('rides in the body as a hidden HTML comment, and nothing else is appended', async () => {
    await withFiling(async (h) => {
      await h.fileNew(
        draft({
          images: [image('img_1')],
          refined: refined({
            sections: [
              { heading: 'Repro steps', body: '1. Lock Windows\n2. Unlock' },
              { heading: 'Actual', body: '![screenshot](quacket-image:img_1)' },
            ],
          }),
        }),
      );

      const body = sentBody(h.runner);
      // Exact equality is the real proof: the user's sections, the rewritten URL,
      // and the invisible marker — with nothing else added.
      expect(body).toBe(
        `## Repro steps\n\n1. Lock Windows\n2. Unlock\n\n## Actual\n\n![screenshot](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)\n` +
          `\n<!-- quacket-filing: fil_1 -->\n`,
      );
    });
  });

  it('adds no VISIBLE marker, branding or footer', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft());

      const body = sentBody(h.runner);
      // Everything a reader would see, once the HTML comment is taken out. (The
      // word "quacket" occurs in the repo's own name and asset paths, so a
      // substring check would prove nothing — hence the exact comparison.)
      expect(visible(body)).toBe('## Actual\n\nThe icon is gone.\n');
      expect(visible(body)).not.toContain('<!--');
      expect(body).not.toMatch(/filed with|generated (by|with)|powered by|created by quacket/i);
      expect(body).not.toMatch(/\n---\n/);
    });
  });

  /**
   * The only test that uses the REAL id generator. It exists because the obvious
   * implementation — `crypto.randomUUID()` — is gated behind a secure context in
   * Chromium, and a Filing that cannot get an identity cannot file at all.
   */
  it('mints a real identity without an injected generator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quacket-filing-'));
    try {
      const runner = scriptedRunner();
      const drafts = new DraftStore(dir, nodeFiles);
      const filing = createFiling({ runner, files: nodeFiles, drafts, baseDir: dir, now: NOW });

      const first = draft({ id: 'draft_1' });
      await drafts.save(first);
      const one = await filing.file({ kind: 'new', draft: first, repo: PUBLIC_REPO, decision: 'as-captured' });
      const second = draft({ id: 'draft_2' });
      await drafts.save(second);
      const two = await filing.file({ kind: 'new', draft: second, repo: PUBLIC_REPO, decision: 'as-captured' });

      expect(one.filingId).toMatch(/^fil_[0-9a-f]{32}$/);
      expect(two.filingId).not.toBe(one.filingId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives each Filing its own identity', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft({ id: 'draft_1' }));
      await h.fileNew(draft({ id: 'draft_2' }));

      const bodies = createCalls(h.runner).map((c) => c.stdin ?? '');
      expect(bodies[0]).toContain(filingMarker('fil_1'));
      expect(bodies[1]).toContain(filingMarker('fil_2'));
    });
  });
});

// ── No-fabrication in the filed body ────────────────────────────────────────

describe('the filed body never invents scaffolding', () => {
  it('strips image placeholders when filing without images', async () => {
    await withFiling(async (h) => {
      const d = draft({
        images: [],
        refined: refined({
          sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![screenshot](quacket-image:img_1)' }],
        }),
      });
      await h.fileNew(d);

      expect(uploadCalls(h.runner)).toHaveLength(0);
      expect(visible(sentBody(h.runner))).toBe('## Actual\n\nThe icon is gone.\n');
      expect(sentBody(h.runner)).not.toContain('quacket-image:');
    });
  });

  it('drops a section whose only content was an image', async () => {
    await withFiling(async (h) => {
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
      await h.fileNew(draftFrom(state));

      const body = visible(sentBody(h.runner));
      // Exact equality: the Actual section is ABSENT, not present-and-empty.
      expect(body).toBe('## Repro steps\n\n1. Lock Windows\n2. Unlock\n');
      expect(emptyHeadings(body)).toEqual([]);
    });
  });

  it('honours File-without-images on a FIRST attempt, not only on a resume', async () => {
    /*
     * The reducer also clears the thumbnails, so this would pass by accident if
     * the decision never reached Filing. The frozen draft here deliberately
     * still HAS its screenshot, which is the only way to tell the two apart.
     */
    await withFiling(async (h) => {
      await h.fileNew(
        draft({
          images: [image('img_1')],
          refined: refined({
            sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![shot](quacket-image:img_1)' }],
          }),
        }),
        PUBLIC_REPO,
        'without-images',
      );

      expect(uploadCalls(h.runner)).toHaveLength(0);
      expect(visible(sentBody(h.runner))).toBe('## Actual\n\nThe icon is gone.\n');
    });
  });

  it('drops a section left empty by a hallucinated image ref', async () => {
    await withFiling(async (h) => {
      // No such image was ever attached: the model invented the ref.
      await h.fileNew(
        draft({
          images: [],
          refined: refined({
            sections: [
              { heading: 'Actual', body: '![proof](quacket-image:img_99)' },
              { heading: 'Expected', body: 'The icon stays.' },
            ],
          }),
        }),
      );

      expect(visible(sentBody(h.runner))).toBe('## Expected\n\nThe icon stays.\n');
    });
  });

  it('emits no heading at all on the file-as-is path', async () => {
    await withFiling(async (h) => {
      const raw = 'refine 轉圈圈 stuck forever, 每次按都一樣';
      const state = driveReducer({ raw }, [{ type: 'file-as-is' }]);
      // The reducer deliberately carries no heading: nothing here was classified.
      expect(state.refined?.sections).toEqual([{ heading: '', body: raw }]);

      await h.fileNew(draftFrom(state));

      const body = visible(sentBody(h.runner));
      expect(body).toBe(`${raw}\n`);
      expect(body).not.toContain('#');
    });
  });

  /**
   * The floor. Dropping the images can drop the whole report, and a title over an
   * empty body is the user's words thrown away — so the raw dump stands in. This
   * rule used to live in the reducer and moved here with body rendering, which is
   * exactly why the test drives the real reducer and then the real Filing: it
   * fails if the decision goes missing in the move.
   */
  it('files the raw dump, not an empty body, when every section was image-only', async () => {
    await withFiling(async (h) => {
      const state = driveReducer(
        {
          stage: 'draft',
          raw: 'look at this',
          images: [image('img_1')],
          refined: refined({ sections: [{ heading: 'Actual', body: '![screenshot](quacket-image:img_1)' }] }),
        },
        [{ type: 'file-without-images' }],
      );
      await h.fileNew(draftFrom(state));

      const body = visible(sentBody(h.runner));
      expect(body).toBe('look at this\n');
      expect(body).not.toContain('#');
      expect(emptyHeadings(body)).toEqual([]);
    });
  });
});

// ── Ownership: the atomic handoff ───────────────────────────────────────────

describe('taking ownership of the draft', () => {
  it('moves the whole draft directory — bytes and all — into the Filing workspace', async () => {
    // The runner never answers `issue create`, so the Filing is still in flight
    // when the assertions run: this is the state a crash would freeze.
    const runner = scriptedRunner().on({ cmd: 'gh', argsContain: ['issue', 'create'] }, { hangs: true });
    await withFiling(
      async (h) => {
        const d = draft({ images: [image('img_1')] });
        await expect(h.fileNew(d)).rejects.toMatchObject({ filingId: 'fil_1' });

        // The active draft slot is EMPTY: nothing was copied, the folder moved.
        expect(await h.draftDirs()).toEqual([]);
        expect(await h.filings()).toEqual(['fil_1']);
        expect(await h.files.list(joinPath(h.dir, 'filings', 'fil_1', 'draft'))).toEqual(
          expect.arrayContaining(['draft.json', 'img_1.png']),
        );
        // The bytes themselves, not a re-encoded copy.
        expect(
          await h.files.readBytes(joinPath(h.dir, 'filings', 'fil_1', 'draft', 'img_1.png')),
        ).toEqual(new Uint8Array([137, 80, 78, 71]));
      },
      { runner },
    );
  });

  it('leaves no partial snapshot: the JSON on disk is always complete', async () => {
    const runner = scriptedRunner().on({ cmd: 'gh', argsContain: ['issue', 'create'] }, { hangs: true });
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toBeTruthy();

        // Written to a temp name and renamed over, so nothing half-written is
        // ever visible under the real name.
        expect(await h.files.list(joinPath(h.dir, 'filings', 'fil_1'))).toEqual(
          expect.arrayContaining(['filing.json', 'draft']),
        );
        expect(await h.snapshot('fil_1')).toMatchObject({ version: 1, id: 'fil_1' });
      },
      { runner },
    );
  });

  /**
   * Story 19/20. The report is frozen at the handoff, so what gets filed is what
   * was on screen when Submit was pressed — not what the draft says afterwards.
   */
  it('files the frozen report even after the caller edits and re-saves', async () => {
    await withFiling(async (h) => {
      const d = draft({ raw: 'original', refined: refined({ title: 'Original title' }) });
      await h.drafts.save(d);

      // Submit, then the user keeps typing into what is now a different draft.
      const filed = h.file({ kind: 'new', draft: d, repo: PUBLIC_REPO, decision: 'as-captured' });
      await h.drafts.save({ ...d, id: 'draft_2', raw: 'edited afterwards' });
      await filed;

      const create = createCalls(h.runner)[0];
      expect(create?.args).toContain('Original title');
      expect(create?.stdin).not.toContain('edited afterwards');
    });
  });
});

describe('a Filing that could not even start', () => {
  it('leaves the draft in its slot, with its screenshots', async () => {
    // The handoff rename fails. Nothing has reached GitHub, so the honest state
    // is the one we were already in.
    const files: FileStore = {
      ...nodeFiles,
      rename: async (from, to) => {
        if (to.includes('filings')) throw new Error('injected rename failure');
        return nodeFiles.rename(from, to);
      },
    };
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft({ images: [image('img_1')] }))).rejects.toBeTruthy();

        expect((await h.drafts.load())?.raw).toBe('tray icon vanished');
        expect((await h.drafts.load())?.images[0]?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
        expect(createCalls(h.runner)).toHaveLength(0);
      },
      { files },
    );
  });

  it('offers no Filing to resume, so a retry starts a fresh one', async () => {
    const files: FileStore = {
      ...nodeFiles,
      rename: async (from, to) => {
        if (to.includes('filings')) throw new Error('injected rename failure');
        return nodeFiles.rename(from, to);
      },
    };
    await withFiling(
      async (h) => {
        // A `filingId` here would send [Try again] at a Filing that does not
        // exist — and could never succeed.
        await expect(h.fileNew(draft())).rejects.not.toHaveProperty('filingId');
        // And no orphan workspace is left behind.
        expect(await h.filings()).toEqual([]);
      },
      { files },
    );
  });

  it('reports a corrupt snapshot as a Filing rather than crashing on it', async () => {
    const files = breaking('remove', (path) => path.includes('filings'));
    await withFiling(
      async (h) => {
        await h.fileNew(draft());
        await h.files.writeText(joinPath(h.dir, 'filings', 'fil_1', 'filing.json'), '{not json');

        await expect(
          h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' }),
        ).rejects.toMatchObject({ kind: 'create_failed', filingId: 'fil_1' });
        // Unreadable is not permission to file it again.
        expect(createCalls(h.runner)).toHaveLength(1);
      },
      { files },
    );
  });
});

// ── Terminal success ────────────────────────────────────────────────────────

describe('success is terminal', () => {
  /*
   * GitHub accepts the report, and only the write that RECORDS that fails — a
   * full disk, a locked file, the machine losing power mid-write.
   *
   * The submit is over at that point. Reporting it as a failure would hand the
   * user a [Try again] that files their report a SECOND time (QA #31: two issues
   * from one Submit), so the durability failure must not reach them as one.
   * Every other snapshot write is left working, so the failure is pinned to the
   * receipt rather than to setup.
   */
  /** `nodeFiles` with the snapshot write for one state rigged to fail. */
  const snapshotWriteFails = (state: string): FileStore => ({
    ...nodeFiles,
    writeText: async (path, text) => {
      if (text.includes(`"state":"${state}"`)) throw new Error('injected: power lost');
      return nodeFiles.writeText(path, text);
    },
  });

  for (const [label, target] of [
    ['a new issue', { kind: 'new-issue' } as const],
    ['a comment', { kind: 'comment', issueNumber: 7 } as const],
  ] as const) {
    it(`reports success when the receipt write fails — ${label}`, async () => {
      await withFiling(
        async (h) => {
          const receipt = await h.fileNew(draft({ target }));

          // What GitHub accepted is what the user is told, URL and all.
          expect(receipt.url).toContain('github.com/c3lew/Quacket/issues/');
          expect(receipt.filingId).toBe('fil_1');
          expect(createCalls(h.runner)).toHaveLength(1);
        },
        { files: snapshotWriteFails('filed') },
      );
    });
  }

  it('does not create a second report when a lost receipt is resumed anyway', async () => {
    /*
     * The end of QA #31's walkthrough: the receipt write is lost, and the same
     * identity is resumed regardless. `2` here is the duplicate report — one
     * Submit, two issues on GitHub, and no way to tell from inside Quacket.
     *
     * The cleanup removal is broken too, on purpose. Both are the same disk, so
     * assuming the second one works would leave a snapshot saying `filing` with
     * no receipt behind — which is exactly what a resume would file again.
     */
    const files: FileStore = {
      ...snapshotWriteFails('filed'),
      remove: async (path) => {
        if (path.includes('filings')) throw new Error('injected: locked');
        return nodeFiles.remove(path);
      },
    };
    await withFiling(
      async (h) => {
        const receipt = await h.fileNew(draft());
        const again = await h.file({
          kind: 'resume',
          filingId: receipt.filingId,
          decision: 'as-captured',
        });

        expect(again).toEqual(receipt);
        expect(createCalls(h.runner)).toHaveLength(1);
        // The state the resume had to survive: the disk still thinks it never finished.
        const stale = await h.snapshot('fil_1');
        expect(stale['state']).toBe('filing');
        expect(stale['receipt']).toBeUndefined();
      },
      { files },
    );
  });

  it('rejects with a Filing — never a raw filesystem error — when a snapshot read blows up', async () => {
    /*
     * The module's contract in the one place it used to leak: an unexpected
     * error escaping untyped takes the Filing id with it, and the app's [Try
     * again] then starts a NEW Filing rather than resuming this one. The
     * filesystem's own wording is dropped too — `EBUSY` is not a sentence.
     */
    const files = breaking('readText', (path) => path.endsWith('filing.json'));
    await withFiling(
      async (h) => {
        await expect(
          h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' }),
        ).rejects.toMatchObject({
          name: 'FilingError',
          filingId: 'fil_1',
          message: expect.not.stringContaining('injected'),
        });
      },
      { files },
    );
  });

  it('rejects with a Filing when the FROZEN report on disk is unreadable', async () => {
    // Same contract, the other side of it: this one throws from inside the
    // attempt rather than from the snapshot load, and used to escape as a raw
    // `SyntaxError` — no id, and JSON parser wording in the palette.
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: server error (HTTP 500)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toMatchObject({ filingId: 'fil_1' });
        await h.files.writeText(
          joinPath(h.dir, 'filings', 'fil_1', 'draft', 'draft.json'),
          '{not json',
        );

        await expect(
          h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' }),
        ).rejects.toMatchObject({
          name: 'FilingError',
          filingId: 'fil_1',
          message: expect.not.stringContaining('JSON'),
        });
      },
      { runner },
    );
  });

  it('reports the GitHub failure even when recording it fails too', async () => {
    // The disk problem must not overwrite the reason the user actually needs:
    // the remote failure, with the id that makes [Try again] resume this Filing.
    const files = snapshotWriteFails('failed');
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: server error (HTTP 500)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toMatchObject({
          name: 'FilingError',
          filingId: 'fil_1',
          message: 'Could not create the issue.',
        });
      },
      { files, runner },
    );
  });

  it('reports success and keeps the receipt terminal when cleanup fails', async () => {
    const files = breaking('remove', (path) => path.includes('filings'));
    await withFiling(
      async (h) => {
        const receipt = await h.fileNew(draft());

        expect(receipt.issueNumber).toBe(42);
        // The receipt survived, and the failure is recorded as CLEANUP — never as
        // something the user could be offered a Retry for.
        const snapshot = await h.snapshot('fil_1');
        expect(snapshot).toMatchObject({
          state: 'filed',
          cleanup: 'pending',
          receipt: { url: 'https://github.com/c3lew/Quacket/issues/42', issueNumber: 42 },
        });
        // A disk problem is recorded as a disk problem. Filing it under the
        // GitHub failure would make one field mean two things — and would read
        // as though the remote write had failed.
        expect(snapshot['cleanupFailure']).toMatchObject({ message: expect.any(String) });
        expect(snapshot['lastFailure']).toBeUndefined();
      },
      { files },
    );
  });

  it('does not create a second report when a filed Filing is resumed', async () => {
    const files = breaking('remove', (path) => path.includes('filings'));
    await withFiling(
      async (h) => {
        await h.fileNew(draft());
        const again = await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        expect(again.issueNumber).toBe(42);
        expect(createCalls(h.runner)).toHaveLength(1);
      },
      { files },
    );
  });

  it('drains a pending cleanup on the next resume, with no GitHub call at all', async () => {
    // Cleanup fails once (the directory stays), then a later resume succeeds.
    let breakIt = true;
    const files: FileStore = {
      ...nodeFiles,
      remove: async (path) => {
        if (breakIt && path.includes('filings')) throw new Error('injected remove failure');
        return nodeFiles.remove(path);
      },
    };
    await withFiling(
      async (h) => {
        await h.fileNew(draft());
        expect(await h.filings()).toEqual(['fil_1']);

        breakIt = false;
        const before = ghCalls(h.runner).length;
        await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        expect(await h.filings()).toEqual([]);
        expect(ghCalls(h.runner)).toHaveLength(before);
      },
      { files },
    );
  });

  it('removes its own workspace and nothing else — a newer draft survives', async () => {
    await withFiling(async (h) => {
      await h.fileNew(draft());
      // The next report, captured while the first was being filed.
      await h.drafts.save(draft({ id: 'draft_next', raw: 'the next report' }));

      expect(await h.filings()).toEqual([]);
      expect((await h.drafts.load())?.raw).toBe('the next report');
    });
  });

  it('keeps several pending cleanups independent, and none of them blocks the draft slot', async () => {
    const files = breaking('remove', (path) => path.includes('filings'));
    await withFiling(
      async (h) => {
        await h.fileNew(draft({ id: 'draft_a', raw: 'first report' }));
        await h.fileNew(draft({ id: 'draft_b', raw: 'second report' }));
        await h.drafts.save(draft({ id: 'draft_c', raw: 'still capturing' }));

        expect((await h.filings()).sort()).toEqual(['fil_1', 'fil_2']);
        expect(await h.snapshot('fil_1')).toMatchObject({ state: 'filed', cleanup: 'pending' });
        expect(await h.snapshot('fil_2')).toMatchObject({ state: 'filed', cleanup: 'pending' });
        expect((await h.drafts.load())?.raw).toBe('still capturing');
      },
      { files },
    );
  });
});

// ── Failure, resume, and what lands on disk ─────────────────────────────────

describe('a pre-terminal failure', () => {
  it('reports create_failed with the Filing to resume, and keeps the report', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: Something went wrong (HTTP 502)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toMatchObject({
          kind: 'create_failed',
          filingId: 'fil_1',
          message: 'Could not create the issue.',
        });

        expect(await h.snapshot('fil_1')).toMatchObject({
          state: 'failed',
          lastFailure: { kind: 'create_failed', message: 'Could not create the issue.' },
        });
      },
      { runner },
    );
  });

  it('resumes the SAME identity rather than starting a second report', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: Something went wrong (HTTP 502)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toBeTruthy();

        runner.on(
          { cmd: 'gh', argsContain: ['issue', 'create'] },
          { stdout: 'https://github.com/c3lew/Quacket/issues/42\n' },
        );
        const receipt = await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        expect(receipt.filingId).toBe('fil_1');
        const bodies = createCalls(h.runner).map((c) => c.stdin ?? '');
        expect(bodies).toHaveLength(2);
        // Both attempts carry the same identity — a reconciler can tell they are
        // one report, not two.
        expect(bodies.every((b) => b.includes(filingMarker('fil_1')))).toBe(true);
      },
      { runner },
    );
  });

  it('reports upload_failed when the Contents API rejects the write', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['--method', 'PUT'] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft({ images: [image('img_1')] }))).rejects.toMatchObject({
          kind: 'upload_failed',
        });
        expect(createCalls(h.runner)).toHaveLength(0);
      },
      { runner },
    );
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
        stdout: '{"message":"Git Repository is empty.","status":"409"}',
        stderr: 'gh: Git Repository is empty. (HTTP 409)',
      },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft({ images: [image('img_1')] }))).rejects.toMatchObject({
          kind: 'upload_failed',
          message: expect.stringContaining('no commits yet'),
        });
      },
      { runner },
    );
  });

  it('files the same report without its screenshots on a File-without-images resume', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['--method', 'PUT'] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    await withFiling(
      async (h) => {
        const d = draft({
          images: [image('img_1')],
          refined: refined({
            sections: [{ heading: 'Actual', body: 'The icon is gone.\n\n![shot](quacket-image:img_1)' }],
          }),
        });
        await expect(h.fileNew(d)).rejects.toMatchObject({ kind: 'upload_failed' });

        const receipt = await h.file({
          kind: 'resume',
          filingId: 'fil_1',
          decision: 'without-images',
        });

        expect(receipt.filingId).toBe('fil_1');
        expect(createCalls(h.runner)).toHaveLength(1);
        // Same text, same identity, no screenshot — and no second upload attempt.
        expect(visible(sentBody(h.runner))).toBe('## Actual\n\nThe icon is gone.\n');
        expect(uploadCalls(h.runner)).toHaveLength(1);
      },
      { runner },
    );
  });
});

// ── The durable snapshot ────────────────────────────────────────────────────

describe('the durable Filing snapshot', () => {
  it('records what an interrupted submission can be diagnosed from', async () => {
    const files = breaking('remove', (path) => path.includes('filings'));
    await withFiling(
      async (h) => {
        await h.fileNew(draft({ target: { kind: 'comment', issueNumber: 7 } }));

        expect(await h.snapshot('fil_1')).toMatchObject({
          version: 1,
          id: 'fil_1',
          state: 'filed',
          repo: 'c3lew/Quacket',
          isPrivate: false,
          target: { kind: 'comment', issueNumber: 7 },
          createdAt: '2026-07-16T09:30:00.000Z',
          updatedAt: '2026-07-16T09:30:00.000Z',
          cleanup: 'pending',
          receipt: { filingId: 'fil_1', issueNumber: 7 },
        });
      },
      { files },
    );
  });

  it('never writes a token, a `gh` stderr detail, or a process environment', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      {
        exitCode: 1,
        stderr: 'gh: HTTP 401 (Authorization: token ghp_SECRETSECRETSECRET)',
      },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(draft())).rejects.toBeTruthy();

        const raw = await readFile(join(h.dir, 'filings', 'fil_1', 'filing.json'), 'utf8');
        expect(raw).not.toContain('ghp_');
        expect(raw).not.toContain('Authorization');
        expect(raw).not.toContain('token');
        // Only the plain-language message the user already sees.
        expect(JSON.parse(raw).lastFailure).toEqual({
          kind: 'create_failed',
          message: 'Could not create the issue.',
        });
      },
      { runner },
    );
  });
});

// ── Asset receipts ──────────────────────────────────────────────────────────

/**
 * Everything here is asserted from outside: how many PUTs `gh` was handed, what
 * URL came out in the body, and what the snapshot on disk holds. Never the
 * ledger's internal shape beyond what a next run has to read back.
 *
 * `remove` is broken on purpose in the success cases — cleanup deletes the
 * workspace the instant a report is filed, so the snapshot is only readable
 * afterwards if cleanup could not finish.
 */
describe('durable Asset receipts', () => {
  const keepWorkspace = () => breaking('remove', (path) => path.includes('filings'));

  const OTHER_PNG = new Uint8Array([137, 80, 78, 71, 13, 10]);

  const sha256 = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

  /** The `gh` argument that names one upload, so a test can fail exactly one. */
  const uploadOf = (id: string, ext = 'png', repo = 'c3lew/Quacket'): string =>
    `repos/${repo}/contents/.quacket/assets/${STAMP}-${id}.${ext}`;

  const assetsOf = async (h: Harness, id = 'fil_1'): Promise<Record<string, string>[]> =>
    ((await h.snapshot(id)).assets ?? []) as Record<string, string>[];

  const twoShots = (over: Partial<ImageAttachment> = {}) =>
    draft({
      images: [image('img_1'), image('img_2', { bytes: OTHER_PNG, ...over })],
      refined: refined({
        sections: [
          { heading: 'Actual', body: '![one](quacket-image:img_1)\n\n![two](quacket-image:img_2)' },
        ],
      }),
    });

  it('writes one receipt per upload, bound to the repo, media type and bytes', async () => {
    await withFiling(
      async (h) => {
        await h.fileNew(twoShots());

        expect(uploadCalls(h.runner)).toHaveLength(2);
        expect(await assetsOf(h)).toEqual([
          {
            repo: 'c3lew/Quacket',
            mediaType: 'image/png',
            fingerprint: sha256(image('img_1').bytes),
            url: `https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png`,
          },
          {
            repo: 'c3lew/Quacket',
            mediaType: 'image/png',
            fingerprint: sha256(OTHER_PNG),
            url: `https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_2.png`,
          },
        ]);
      },
      { files: keepWorkspace() },
    );
  });

  it('keeps the receipt the first upload earned when the second one fails', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: [uploadOf('img_2')] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(twoShots())).rejects.toMatchObject({ kind: 'upload_failed' });

        // The report never reached GitHub, but the screenshot that DID land is
        // on disk — a next run must not send those bytes again.
        expect(createCalls(h.runner)).toHaveLength(0);
        expect(await assetsOf(h)).toMatchObject([{ fingerprint: sha256(image('img_1').bytes) }]);
        expect(await h.snapshot('fil_1')).toMatchObject({ state: 'failed' });
      },
      { runner },
    );
  });

  it('reuses a landed upload on resume instead of sending the same bytes again', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: [uploadOf('img_2')] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(twoShots())).rejects.toMatchObject({ kind: 'upload_failed' });
        runner.on(
          { cmd: 'gh', argsContain: [uploadOf('img_2')] },
          { stdout: '{"commit":{"sha":"second99"}}' },
        );

        await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        // Three PUTs in total: img_1 once, img_2 twice (the failure, then the
        // one that worked). img_1 was never re-sent.
        const puts = uploadCalls(h.runner).map((c) => c.args[3]);
        expect(puts).toEqual([uploadOf('img_1'), uploadOf('img_2'), uploadOf('img_2')]);
        expect(visible(sentBody(h.runner))).toContain(
          `![one](https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png)`,
        );
        expect(visible(sentBody(h.runner))).toContain(
          `![two](https://raw.githubusercontent.com/c3lew/Quacket/second99/.quacket/assets/${STAMP}-img_2.png)`,
        );
      },
      { runner },
    );
  });

  it('spawns nothing at all for images when every screenshot already landed', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: ['issue', 'create'] },
      { exitCode: 1, stderr: 'gh: Something went wrong (HTTP 502)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(twoShots())).rejects.toMatchObject({ kind: 'create_failed' });
        expect(uploadCalls(h.runner)).toHaveLength(2);

        runner.on(
          { cmd: 'gh', argsContain: ['issue', 'create'] },
          { stdout: 'https://github.com/c3lew/Quacket/issues/42\n' },
        );
        await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        // No second PUT, and no branch check either: with nothing to upload
        // there is nothing to set up.
        expect(uploadCalls(h.runner)).toHaveLength(2);
        const branchChecks = ghCalls(h.runner).filter((c) =>
          c.args.includes('repos/c3lew/Quacket/git/ref/heads/quacket-assets'),
        );
        expect(branchChecks).toHaveLength(1);
      },
      { runner },
    );
  });

  it('uploads separately for different bytes and for a different media type', async () => {
    await withFiling(
      async (h) => {
        // Same bytes as img_1, filed as a JPEG: the media type is part of the
        // key, so it is a different asset and gets its own upload.
        await h.fileNew(twoShots({ bytes: image('img_1').bytes, mediaType: 'image/jpeg' }));

        expect(uploadCalls(h.runner).map((c) => c.args[3])).toEqual([
          uploadOf('img_1'),
          uploadOf('img_2', 'jpg'),
        ]);
      },
      { files: keepWorkspace() },
    );
  });

  it('uploads one asset for two screenshots that are byte-identical', async () => {
    await withFiling(
      async (h) => {
        await h.fileNew(twoShots({ bytes: image('img_1').bytes }));

        expect(uploadCalls(h.runner)).toHaveLength(1);
        const url = `https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}-img_1.png`;
        expect(visible(sentBody(h.runner))).toBe(
          `## Actual\n\n![one](${url})\n\n![two](${url})\n`,
        );
      },
      { files: keepWorkspace() },
    );
  });

  it('resolves every ref to its own image, whatever order the receipts are in', async () => {
    await withFiling(
      async (h) => {
        // Uploads — and therefore receipts — happen in Draft order; the body
        // references them the other way round.
        const d = draft({
          images: [image('img_2', { bytes: OTHER_PNG }), image('img_1')],
          refined: refined({
            sections: [
              { heading: 'Actual', body: '![one](quacket-image:img_1)\n\n![two](quacket-image:img_2)' },
            ],
          }),
        });
        await h.fileNew(d);

        const stem = `https://raw.githubusercontent.com/c3lew/Quacket/abc123def/.quacket/assets/${STAMP}`;
        expect(visible(sentBody(h.runner))).toBe(
          `## Actual\n\n![one](${stem}-img_1.png)\n\n![two](${stem}-img_2.png)\n`,
        );
        expect((await assetsOf(h)).map((a) => a.fingerprint)).toEqual([
          sha256(OTHER_PNG),
          sha256(image('img_1').bytes),
        ]);
      },
      { files: keepWorkspace() },
    );
  });

  it('never says `failed` on disk while a resumed attempt is still running', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: [uploadOf('img_2')] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    const written: string[] = [];
    const files: FileStore = {
      ...nodeFiles,
      writeText: async (path: string, text: string) => {
        if (path.endsWith('filing.json.tmp')) written.push(text);
        return nodeFiles.writeText(path, text);
      },
    };
    await withFiling(
      async (h) => {
        await expect(h.fileNew(twoShots())).rejects.toMatchObject({ kind: 'upload_failed' });
        written.length = 0;
        runner.on(
          { cmd: 'gh', argsContain: [uploadOf('img_2')] },
          { stdout: '{"commit":{"sha":"second99"}}' },
        );

        await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'as-captured' });

        // Every write the resume made before it had a receipt describes a Filing
        // that IS filing — not the previous attempt's failure restated as now.
        const inFlight = written
          .map((t) => JSON.parse(t) as Record<string, unknown>)
          .filter((s) => s.receipt === undefined);
        expect(inFlight).not.toHaveLength(0);
        expect(inFlight.map((s) => [s.state, s.lastFailure])).toEqual(
          inFlight.map(() => ['filing', undefined]),
        );
      },
      { runner, files },
    );
  });

  it('leaves the receipts alone on a File-without-images resume, and files once', async () => {
    const runner = scriptedRunner().on(
      { cmd: 'gh', argsContain: [uploadOf('img_2')] },
      { exitCode: 1, stderr: 'gh: Repository is archived (HTTP 403)' },
    );
    await withFiling(
      async (h) => {
        await expect(h.fileNew(twoShots())).rejects.toMatchObject({ kind: 'upload_failed' });
        const before = await assetsOf(h);

        await h.file({ kind: 'resume', filingId: 'fil_1', decision: 'without-images' });

        expect(createCalls(h.runner)).toHaveLength(1);
        expect(uploadCalls(h.runner)).toHaveLength(2);
        // The section was image-only, so the raw dump is the floor under it.
        expect(visible(sentBody(h.runner))).toBe('tray icon vanished\n');
        expect(await assetsOf(h)).toEqual(before);
      },
      { runner, files: keepWorkspace() },
    );
  });
});
