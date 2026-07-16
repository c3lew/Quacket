import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFiles } from '../testing/node-files.ts';
import type { Draft, ImageAttachment } from '../types.ts';
import { DraftStore } from './store.ts';

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
  it('round-trips uploadedUrl so a retry reuses the uploaded blob', async () => {
    let d = draft({ raw: 'see screenshot' });
    d = await store.attachImage(d, png('img_1', 9, 9));
    d = await store.attachImage(d, png('img_2', 7));

    // Partial failure: img_1 made it to the assets branch, img_2 did not.
    d = { ...d, images: d.images.map((i) => (i.id === 'img_1' ? { ...i, uploadedUrl: 'https://raw.example/sha/img_1.png' } : i)) };
    await store.save(d);
    await store.finishSubmit(d, { ok: false, error: { kind: 'upload_failed', message: 'Upload failed.' } });

    const restored = await relaunch().load();
    expect(restored?.images[0]?.uploadedUrl).toBe('https://raw.example/sha/img_1.png');
    expect(restored?.images[1]?.uploadedUrl).toBeUndefined();
    expect(restored?.images[1]?.bytes).toEqual(new Uint8Array([7]));
  });

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
    await store.beginSubmit({ ...d, raw: 'ab' });
    await store.finishSubmit({ ...d, raw: 'ab' }, { ok: false, error: { kind: 'rate_limited', message: 'Rate limited.' } });

    expect(await relaunch().load()).not.toBeNull();
  });

  it('frees the slot when asked explicitly', async () => {
    await store.save(draft({ raw: 'never mind' }));

    await store.discard();

    expect(await relaunch().load()).toBeNull();
  });
});

describe('submit lifecycle', () => {
  it('keeps the draft and lands the error card when a submit fails', async () => {
    const d = draft({ raw: 'the report' });
    await store.beginSubmit(d);

    await store.finishSubmit(d, { ok: false, error: { kind: 'create_failed', message: 'Could not create the issue.' } });

    const restored = await relaunch().load();
    expect(restored?.raw).toBe('the report');
    expect(restored?.lastError).toEqual({ kind: 'create_failed', message: 'Could not create the issue.' });
  });

  it('frees the slot only on confirmed success', async () => {
    const d = draft({ raw: 'the report' });
    await store.beginSubmit(d);

    await store.finishSubmit(d, { ok: true });

    expect(await relaunch().load()).toBeNull();
  });

  it('restores into a failed-submit state when killed mid-flight', async () => {
    const d = draft({ raw: 'the report' });
    await store.save(d);

    await store.beginSubmit(d); // ...and the process dies here, before any outcome.

    const restored = await relaunch().load();
    expect(restored?.raw).toBe('the report');
    expect(restored?.lastError?.kind).toBe('create_failed');
    expect(restored?.lastError?.message).toMatch(/closed while/i);
  });

  it('keeps the in-flight mark when a screenshot is attached mid-flight', async () => {
    /*
     * The second writer. A paste lands from the document listener at any stage,
     * so an image can arrive while a submit is still in the air — and the attach
     * path wrote `inFlight: false`, because every writer used to assert the flag
     * rather than the bracket owning it. The kill then restored a normal draft:
     * no failed-submit state, no Retry, which is the whole of #15 / story 28.
     */
    const d = draft({ raw: 'the report' });
    await store.beginSubmit(d);

    await store.attachImage(d, png('img_1', 1, 2));

    // ...and the process dies here, still inside the bracket.
    const restored = await relaunch().load();
    expect(restored?.lastError?.kind).toBe('create_failed');
    expect(restored?.lastError?.message).toMatch(/closed while/i);
    expect(restored?.images[0]?.bytes).toEqual(new Uint8Array([1, 2]));
  });

  it('keeps the in-flight mark when an auto-save lands mid-flight', async () => {
    // Same shape, the other writer: `save` hardcoded `false` too.
    const d = draft({ raw: 'the report' });
    await store.beginSubmit(d);

    await store.save({ ...d, raw: 'the report, still being edited' });

    expect((await relaunch().load())?.lastError?.kind).toBe('create_failed');
  });

  it('never marks a NEW draft in-flight because an older submit is still out', async () => {
    // The mark belongs to one report's submit, not to the store.
    await store.beginSubmit(draft({ id: 'd1', raw: 'first' }));

    await store.save(draft({ id: 'd2', raw: 'second' }));

    const restored = await relaunch().load();
    expect(restored?.id).toBe('d2');
    expect(restored?.lastError).toBeUndefined();
  });

  it('stops reporting a mid-flight crash once the submit resolves', async () => {
    const d = draft({ raw: 'the report' });
    await store.beginSubmit(d);
    await store.finishSubmit(d, { ok: false, error: { kind: 'timeout', message: 'Timed out.' } });

    expect((await relaunch().load())?.lastError).toEqual({ kind: 'timeout', message: 'Timed out.' });
  });

  it('clears a previous error when the user retries', async () => {
    const d = draft({ raw: 'the report' });
    await store.finishSubmit(d, { ok: false, error: { kind: 'create_failed', message: 'Could not create the issue.' } });

    await store.save(d); // Retry: the stage machine re-saves the draft it holds.

    expect((await relaunch().load())?.lastError).toBeUndefined();
  });
});

describe('single active draft', () => {
  it('keeps one folder: saving a new draft retires the old one', async () => {
    await store.save(draft({ id: 'd1', raw: 'first' }));
    await store.finishSubmit(draft({ id: 'd1' }), { ok: true });
    await store.save(draft({ id: 'd2', raw: 'second' }));

    const restored = await relaunch().load();
    expect(restored?.id).toBe('d2');
    expect(restored?.raw).toBe('second');
  });
});
