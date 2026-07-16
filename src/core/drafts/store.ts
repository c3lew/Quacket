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
 */

type DraftError = NonNullable<Draft['lastError']>;

/** What a submit resolved to. Only `ok` frees the draft slot. */
export type SubmitOutcome = { ok: true } | { ok: false; error: DraftError };

/** Bytes live in their own file, so the manifest carries everything but them. */
type StoredImage = Omit<ImageAttachment, 'bytes'>;

type StoredDraft = Omit<Draft, 'images'> & {
  /**
   * A submit was started and never resolved — the mark a killed app leaves
   * behind, which `read` turns back into a failed-submit state with a Retry.
   *
   * It is a fact about the SUBMIT, so no caller is allowed to assert it. `write`
   * derives it from the store's own bracket instead: `beginSubmit` opens,
   * `finishSubmit` closes, and every write in between preserves whatever it
   * found, without being asked to.
   *
   * It used to be a parameter every writer passed, documented as "only
   * `beginSubmit` sets it; any later write clears it" — which quietly assumed the
   * only later write was `finishSubmit`'s. It was not. `attachImage` passed
   * `false` too, and an image can arrive mid-flight (the paste listener is on the
   * document at every stage), so a screenshot pasted during a submit cleared the
   * mark and the killed app restored a NORMAL draft: no failed-submit state, no
   * Retry, which is the whole of #15 / story 28. That is the third time this
   * codebase has been bitten by two producers of one artifact where only one knew
   * the invariant, so the invariant moved to where a writer cannot fail to
   * consult it: here.
   */
  inFlight: boolean;
  images: StoredImage[];
};

const DRAFT_JSON = 'draft.json';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' } as const;

const fileFor = (image: StoredImage): string => `${image.id}.${EXT[image.mediaType]}`;

/**
 * The app died between `beginSubmit` and its outcome, so nothing got to record
 * why. Retry re-runs the whole submit; uploadedUrl round-trips, so whatever did
 * make it to the assets branch is reused rather than uploaded twice.
 */
const CRASH_ERROR: DraftError = {
  kind: 'create_failed',
  message:
    'Quacket closed while this report was being submitted, so it may not have been filed. Retry to be sure.',
};

export class DraftStore {
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * The draft whose submit is bracketed and still unresolved, or null.
   *
   * An id rather than a bare boolean, so a NEW draft can never inherit the
   * previous one's mark: `inFlight` is true of one report's submit, not of the
   * store.
   */
  private inFlightId: string | null = null;

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

    const dir = this.dir(id);
    const text = await this.files.readText(joinPath(dir, DRAFT_JSON));
    if (text === null) return null;

    const { inFlight, images, ...rest } = JSON.parse(text) as StoredDraft;
    const draft: Draft = {
      ...rest,
      images: await Promise.all(
        images.map(async (meta) => ({ ...meta, bytes: await this.imageBytes(dir, meta) })),
      ),
    };
    return inFlight ? { ...draft, lastError: CRASH_ERROR } : draft;
  }

  /**
   * A manifest entry whose bytes are gone is corruption, not a miss — the draft
   * exists and claims the image. Throwing beats restoring a report the user
   * believes still has a screenshot attached.
   */
  private async imageBytes(dir: string, meta: StoredImage): Promise<Uint8Array> {
    const bytes = await this.files.readBytes(joinPath(dir, fileFor(meta)));
    if (bytes === null) throw new Error(`draft image ${meta.id} is missing from disk`);
    return bytes;
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
   * Opens the in-flight bracket: a kill anywhere between here and `finishSubmit`
   * restores as a failed submit with a Retry.
   *
   * The flag is raised INSIDE the serial op, so a save already queued behind this
   * call still writes the honest `false` — the bracket starts exactly where this
   * write lands, not where the caller happened to say the word.
   */
  async beginSubmit(draft: Draft): Promise<void> {
    await this.serial(async () => {
      this.inFlightId = draft.id;
      await this.write(draft);
    });
  }

  /**
   * The slot-freeing decision lives here rather than at the call site, so a
   * failed submit structurally cannot drop the draft.
   */
  async finishSubmit(draft: Draft, outcome: SubmitOutcome): Promise<void> {
    /*
     * Closes the bracket, and closes it for every writer at once — including any
     * write already queued ahead of ours. That is correct rather than sloppy: by
     * the time this is CALLED the submit really has resolved, so nothing written
     * afterwards may still claim otherwise. Hence synchronous, not inside the
     * serial op.
     */
    this.inFlightId = null;
    if (outcome.ok) {
      await this.discard();
      return;
    }
    await this.save({ ...draft, lastError: outcome.error });
  }

  /**
   * The ONE writer of draft.json, and the only thing that decides `inFlight`.
   *
   * It reads the bracket instead of taking the answer from its caller, because a
   * caller cannot know: `save` and `attachImage` are just as reachable during a
   * submit as outside one, and both used to hardcode `false` — asserting "the
   * submit resolved" on no evidence at all.
   */
  private async write(draft: Draft): Promise<void> {
    const dir = this.dir(draft.id);
    await this.files.mkdirp(dir);
    await this.pruneOthers(draft.id);

    const stored: StoredDraft = {
      ...draft,
      images: draft.images.map(({ bytes: _bytes, ...meta }) => meta),
      inFlight: this.inFlightId === draft.id,
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
