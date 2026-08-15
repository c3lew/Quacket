import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFiles } from '../testing/node-files.ts';
import type { Draft, ImageAttachment } from '../types.ts';
import { DraftStore, readDraftDir } from './store.ts';

/**
 * Every test drives the real public API against a real temp dir through the real
 * `nodeFiles` FileStore — no fs mocking, because crash recovery is only honestly
 * tested if the bytes actually round-trip a disk. "Relaunch" is always a fresh
 * DraftStore over the same base dir, so nothing in-memory carries over.
 */

let base: string;
let store: DraftStore;

const relaunch = () => new DraftStore(base, nodeFiles);

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'd1',
  repo: 'c3lew/Quacket',
  raw: '',
  images: [],
  target: { kind: 'new-issue' },
  ...over,
});

const png = (id: string, ...bytes: number[]): ImageAttachment => ({
  id,
  bytes: new Uint8Array(bytes),
  mediaType: 'image/png',
  annotated: false,
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'quacket-drafts-'));
  store = new DraftStore(base, nodeFiles);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('auto-save', () => {
  it('persists from the very first keystroke, with no prior setup', async () => {
    await store.save(draft({ raw: 'w' }));

    expect((await relaunch().load())?.raw).toBe('w');
  });

  it('has nothing to restore before anything is typed', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips the whole draft, image bytes included', async () => {
    let d = draft({ raw: 'button dies on click', answers: ['', 'chrome'] });
    d = await store.attachImage(d, png('img_1', 1, 2, 3));
    d = { ...d, refined: { type: 'bug', title: 'Save button does nothing', sections: [{ heading: 'Actual', body: `![shot](quacket-image:img_1)` }], followUps: ['Which browser?'], similarIssues: [] } };
    await store.save(d);

    expect(await relaunch().load()).toEqual(d);
  });

  it('keeps the latest keystroke when saves pile up', async () => {
    await store.save(draft({ raw: 'b' }));
    await store.save(draft({ raw: 'bu' }));
    await store.save(draft({ raw: 'bug' }));

    expect((await relaunch().load())?.raw).toBe('bug');
  });

  it('keeps the last keystroke when the UI never awaits a save', async () => {
    // The real call pattern: onChange fires save() and drops the promise, so
    // every keystroke's write is in flight at once.
    const typing = 'save button does nothing';
    const keystrokes = [...typing].map((_, i) => typing.slice(0, i + 1));

    await Promise.all(keystrokes.map((raw) => store.save(draft({ raw }))));

    expect((await relaunch().load())?.raw).toBe(typing);
  });

  it('survives an image attached while saves are still in flight', async () => {
    const d = draft({ raw: 'x' });
    const saves = [store.save({ ...d, raw: 'xy' }), store.save({ ...d, raw: 'xyz' })];

    const withImage = await store.attachImage({ ...d, raw: 'xyz' }, png('img_1', 4, 2));
    await Promise.all(saves);
    await store.save(withImage);

    const restored = await relaunch().load();
    expect(restored?.raw).toBe('xyz');
    expect(restored?.images[0]?.bytes).toEqual(new Uint8Array([4, 2]));
  });
});

describe('silent restore', () => {
  it('restores in place after a kill, with no error and no ceremony', async () => {
    const d = draft({ raw: 'half-typed thought' });
    await store.save(d);

    // No submit was ever started, so this is just a close/crash: plain restore.
    const restored = await relaunch().load();

    expect(restored).toEqual(d);
    expect(restored?.lastError).toBeUndefined();
  });
});

describe('images', () => {
  it('overwrites the bytes when an image is re-attached after annotation', async () => {
    let d = await store.attachImage(draft(), png('img_1', 1, 1));
    d = await store.attachImage(d, { ...png('img_1', 5, 5, 5), annotated: true });

    const restored = await relaunch().load();
    expect(restored?.images).toHaveLength(1);
    expect(restored?.images[0]).toMatchObject({ bytes: new Uint8Array([5, 5, 5]), annotated: true });
  });

  it('removes one image without touching the draft or its siblings', async () => {
    let d = await store.attachImage(draft({ raw: 'keep me' }), png('img_1', 1));
    d = await store.attachImage(d, png('img_2', 2));

    d = await store.removeImage(d, 'img_1');

    const restored = await relaunch().load();
    expect(restored?.raw).toBe('keep me');
    expect(restored?.images.map((i) => i.id)).toEqual(['img_2']);
  });
});

describe('discard is the only way to lose a draft', () => {
  it('survives edits, attachments, removals and a failed submit', async () => {
    let d = await store.attachImage(draft({ raw: 'a' }), png('img_1', 1));
    d = await store.removeImage(d, 'img_1');
    await store.save({ ...d, raw: 'ab' });
    await store.save({ ...d, raw: 'ab', lastError: { kind: 'rate_limited', message: 'Rate limited.' } });

    expect(await relaunch().load()).not.toBeNull();
  });

  it('frees the slot when asked explicitly', async () => {
    await store.save(draft({ raw: 'never mind' }));

    await store.discard();

    expect(await relaunch().load()).toBeNull();
  });
});

/**
 * The handoff replaced the old submit bracket outright.
 *
 * There is no longer an "in-flight draft" state to test, because an in-flight
 * submit is no longer something a draft can BE: a Filing takes the directory,
 * and what used to be `beginSubmit` + a crash is now a Filing workspace that
 * `core/filing/filing.test.ts` owns. What is left here is the property this
 * store still has to guarantee — the move is complete, and it is a move.
 */
describe('handing a draft over to a Filing', () => {
  it('moves the directory: the bytes are there, and the draft slot is empty', async () => {
    let d = draft({ raw: 'the report' });
    d = await store.attachImage(d, png('img_1', 1, 2, 3));

    await store.handoff(d, join(base, 'taken'));

    expect(await relaunch().load()).toBeNull();
    expect(await nodeFiles.readBytes(join(base, 'taken', 'img_1.png'))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await readDraftDir(nodeFiles, join(base, 'taken'))).toEqual(d);
  });

  it('hands over the FINAL draft, not whatever the last keystroke left', async () => {
    // The submit-time content (folded follow-up answers) reaches disk here or
    // nowhere: the auto-save has already stopped by the time this is called.
    const d = draft({ raw: 'the report' });
    await store.save(d);

    await store.handoff({ ...d, answers: ['chrome'] }, join(base, 'taken'));

    expect((await readDraftDir(nodeFiles, join(base, 'taken')))?.answers).toEqual(['chrome']);
  });

  it('waits for saves already in flight rather than racing them', async () => {
    const d = draft({ raw: 'x' });
    const saves = [store.save({ ...d, raw: 'xy' }), store.save({ ...d, raw: 'xyz' })];

    const handed = store.handoff({ ...d, raw: 'xyz' }, join(base, 'taken'));
    await Promise.all([...saves, handed]);

    expect((await readDraftDir(nodeFiles, join(base, 'taken')))?.raw).toBe('xyz');
    expect(await relaunch().load()).toBeNull();
  });
});

describe('single active draft', () => {
  it('keeps one folder: saving a new draft retires the old one', async () => {
    await store.save(draft({ id: 'd1', raw: 'first' }));
    await store.save(draft({ id: 'd2', raw: 'second' }));

    const restored = await relaunch().load();
    expect(restored?.id).toBe('d2');
    expect(restored?.raw).toBe('second');
  });
});
