import { joinPath, type FileStore } from '../files.ts';
import type { Draft, ImageAttachment } from '../types.ts';

/**
 * Draft persistence: unconditional local auto-save from the first keystroke.
 *
 * The invariant everything else hangs off: **nothing is ever lost except by
 * explicit discard or a confirmed submit success.** Crash, kill, accidental
 * close, and every failed submit all keep the draft.
 *
 * The base directory and the filesystem are both injected — this module never
 * resolves the real app data dir and never picks a host's fs API. Those two are
 * the whole test seam (no ProcessRunner: drafts spawn nothing).
 *
 * Layout, one folder per draft (single active draft in v1):
 *
 *   <baseDir>/drafts/<draft.id>/draft.json   metadata + image manifest
 *   <baseDir>/drafts/<draft.id>/<img>.png    image bytes, real files
 *
 * The store owns the draft only until a Filing starts. There is deliberately no
 * submit bracket here any more: an in-flight submit is not a state a draft can
 * be in, it is a Filing that OWNS the draft's directory outright (`handoff`).
 */

/** Bytes live in their own file, so the manifest carries everything but them. */
type StoredImage = Omit<ImageAttachment, 'bytes'>;

type StoredDraft = Omit<Draft, 'images'> & { images: StoredImage[] };

const DRAFT_JSON = 'draft.json';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' } as const;

const fileFor = (image: StoredImage): string => `${image.id}.${EXT[image.mediaType]}`;

/**
 * A manifest entry whose bytes are gone is corruption, not a miss — the draft
 * exists and claims the image. Throwing beats restoring a report the user
 * believes still has a screenshot attached.
 */
const imageBytes = async (
  files: FileStore,
  dir: string,
  meta: StoredImage,
): Promise<Uint8Array> => {
  const bytes = await files.readBytes(joinPath(dir, fileFor(meta)));
  if (bytes === null) throw new Error(`draft image ${meta.id} is missing from disk`);
  return bytes;
};

/**
 * Reads one draft directory, wherever it now lives.
 *
 * Exported because a draft outlives the drafts folder: `handoff` renames the
 * whole directory into a Filing workspace, and Filing then reads the frozen
 * report back out of it with this. The on-disk format has exactly one reader,
 * which is what keeps the two sides from drifting.
 */
export async function readDraftDir(files: FileStore, dir: string): Promise<Draft | null> {
  const text = await files.readText(joinPath(dir, DRAFT_JSON));
  if (text === null) return null;

  const { images, ...rest } = JSON.parse(text) as StoredDraft;
  return {
    ...rest,
    images: await Promise.all(
      images.map(async (meta) => ({ ...meta, bytes: await imageBytes(files, dir, meta) })),
    ),
  };
}

export class DraftStore {
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    baseDir: string,
    private readonly files: FileStore,
  ) {
    this.root = joinPath(baseDir, 'drafts');
  }

  private dir(id: string): string {
    return joinPath(this.root, id);
  }

  /**
   * Auto-save fires per keystroke and callers do not await it, so operations
   * overlap by default. Running them in call order is what makes both "the last
   * keystroke wins" and the atomic rename true: concurrent writers would
   * otherwise race on the temp file and rename a stale — or torn — draft.json
   * into place.
   */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op);
    this.tail = next.catch(() => {});
    return next;
  }

  /** Auto-save. Cheap enough for every keystroke: metadata only, never bytes. */
  async save(draft: Draft): Promise<void> {
    await this.serial(() => this.write(draft));
  }

  async load(): Promise<Draft | null> {
    return this.serial(() => this.read());
  }

  private async read(): Promise<Draft | null> {
    const entries = await this.files.list(this.root);
    const id = entries?.[0];
    if (id === undefined) return null;
    return readDraftDir(this.files, this.dir(id));
  }

  /** The only deliberate way to lose work. */
  async discard(): Promise<void> {
    await this.serial(() => this.files.remove(this.root));
  }

  /**
   * Writes the bytes and folds the image into the draft. Re-attaching the same
   * id overwrites the file, which is how annotation (destructive in v1) lands.
   */
  async attachImage(draft: Draft, image: ImageAttachment): Promise<Draft> {
    return this.serial(async () => {
      await this.files.mkdirp(this.dir(draft.id));
      await this.files.writeBytes(joinPath(this.dir(draft.id), fileFor(image)), image.bytes);
      const next: Draft = {
        ...draft,
        images: draft.images.some((i) => i.id === image.id)
          ? draft.images.map((i) => (i.id === image.id ? image : i))
          : [...draft.images, image],
      };
      await this.write(next);
      return next;
    });
  }

  async removeImage(draft: Draft, id: string): Promise<Draft> {
    const image = draft.images.find((i) => i.id === id);
    if (image === undefined) return draft;
    return this.serial(async () => {
      await this.files.remove(joinPath(this.dir(draft.id), fileFor(image)));
      const next: Draft = { ...draft, images: draft.images.filter((i) => i.id !== id) };
      await this.write(next);
      return next;
    });
  }

  /**
   * Hands this draft — final text, manifest and every screenshot byte — to a
   * Filing workspace, atomically, and gives up ownership of it.
   *
   * This is the freeze. After it returns, the drafts folder is empty and the
   * report belongs to one Filing: a later keystroke, a pasted screenshot or a
   * second Submit cannot reach what is being written to GitHub.
   *
   * Two properties do the work, and both come from where the call sits rather
   * than from anything the caller promises:
   *
   *   - It runs INSIDE the serial queue, behind every auto-save already in
   *     flight, and writes the final draft.json itself. So the snapshot handed
   *     over is complete — never a half-written keystroke, never missing the
   *     answers folded in at submit time.
   *   - It MOVES the directory. One rename on one volume: no screenshot is
   *     copied, no JSON is re-serialised into a second place, and there is no
   *     window in which both a draft and a Filing claim the same bytes.
   *
   * `destDir`'s parent must already exist — Filing creates its own workspace,
   * because only Filing knows where its workspace is.
   */
  async handoff(draft: Draft, destDir: string): Promise<void> {
    await this.serial(async () => {
      await this.write(draft);
      await this.files.rename(this.dir(draft.id), destDir);
    });
  }

  /** The ONE writer of draft.json. */
  private async write(draft: Draft): Promise<void> {
    const dir = this.dir(draft.id);
    await this.files.mkdirp(dir);
    await this.pruneOthers(draft.id);

    const stored: StoredDraft = {
      ...draft,
      images: draft.images.map(({ bytes: _bytes, ...meta }) => meta),
    };
    // Rename is atomic, so a crash mid-save can never leave a torn draft.json —
    // the one thing that would break "nothing is ever lost".
    const file = joinPath(dir, DRAFT_JSON);
    const tmp = `${file}.tmp`;
    await this.files.writeText(tmp, JSON.stringify(stored));
    await this.files.rename(tmp, file);
  }

  /** Single active draft in v1: saving one is what retires any other. */
  private async pruneOthers(keep: string): Promise<void> {
    const entries = (await this.files.list(this.root)) ?? [];
    await Promise.all(
      entries.filter((e) => e !== keep).map((e) => this.files.remove(joinPath(this.root, e))),
    );
  }
}
