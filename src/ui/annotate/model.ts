/**
 * The annotation editor's logic, with the canvas taken out.
 *
 * Everything here is a pure function over plain data, so the interesting parts
 * of the editor — where a click lands after the image has been scaled and
 * cropped, what the keyboard means, which crop survives an undo — are testable
 * in the headless test env. The .tsx is left holding nothing but paint calls.
 *
 * THE ONE INVARIANT: every Op is stored in BASE-IMAGE pixel coordinates, never
 * in canvas or view coordinates. That is what makes `effectiveView` a lookup of
 * the last crop instead of a composition of nested crops, and it is what makes
 * undo a plain `pop` that restores the previous view for free.
 */

export type Tool = 'pen' | 'circle' | 'crop';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One committed edit. Undo drops the last one; Cancel drops them all. */
export type Op =
  | { kind: 'pen'; points: Point[]; width: number }
  | { kind: 'circle'; rect: Rect; width: number }
  | { kind: 'crop'; rect: Rect };

/** Marks are one colour on purpose: this is a "look here", not a drawing app. */
export const MARK_COLOR = '#ff4d5a';

/** Below this, a drag was a stray click and not a gesture. Base pixels. */
export const MIN_CROP = 8;

/**
 * Which slice of the base image is on screen.
 *
 * Crop rects are absolute, so the newest one is the answer outright — there is
 * nothing to compose. Undo therefore needs no crop-specific branch: drop the op
 * and the previous crop (or the whole image) becomes current again.
 */
export function effectiveView(ops: Op[], baseW: number, baseH: number): Rect {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op?.kind === 'crop') return op.rect;
  }
  return { x: 0, y: 0, w: baseW, h: baseH };
}

/**
 * Pointer position -> base-image pixel.
 *
 * Two transforms have to be undone at once: the canvas is scaled to fit the
 * panel (`box` vs `view` size), and after a crop it shows an offset window into
 * the base image (`view.x/y`). Getting either wrong puts marks where the user
 * did not click, which is why this is a function and not three lines in a
 * handler.
 *
 * @param client Pointer client coords.
 * @param box    The canvas' bounding client rect.
 * @param view   The slice of the base image the canvas is showing.
 */
export function toBasePoint(client: Point, box: Rect, view: Rect): Point {
  return {
    x: view.x + ((client.x - box.x) * view.w) / box.w,
    y: view.y + ((client.y - box.y) * view.h) / box.h,
  };
}

/** A drag describes the same rect whichever corner it started from. */
export function normRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/**
 * Confine a rect to the visible image.
 *
 * Pointer capture keeps reporting coordinates after the pointer leaves the
 * canvas, so a crop drag can describe a rect hanging off the image. Cropping to
 * it would bake transparent margins into the PNG. Only crop clamps: a pen
 * stroke or a circle running off the edge is a legitimate mark and the canvas
 * bounds already clip it.
 */
export function clampRect(r: Rect, view: Rect): Rect {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const x = clamp(r.x, view.x, view.x + view.w);
  const y = clamp(r.y, view.y, view.y + view.h);
  const x2 = clamp(r.x + r.w, view.x, view.x + view.w);
  const y2 = clamp(r.y + r.h, view.y, view.y + view.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * Snap a crop to whole pixels by rounding its EDGES, not its size.
 *
 * Canvas dimensions are integers, so a float crop is silently truncated and the
 * image rescales by a fraction of a pixel. Rounding x and w independently can
 * push the right edge past a clamped bound; rounding x and x2 cannot.
 */
export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
}

export const isUsableCrop = (r: Rect): boolean => r.w > MIN_CROP && r.h > MIN_CROP;

/**
 * Marks are drawn in base-image pixels, so their width has to scale with the
 * image or a 4K screenshot gets hairline strokes once it is scaled into the
 * panel.
 */
export const strokeWidth = (viewW: number): number => Math.max(3, Math.round(viewW / 240));

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * A fully resolved decision, not a raw key. Enter and Esc mean different things
 * depending on whether a crop box is on screen, and that resolution is the part
 * worth testing — so it happens here rather than in an event handler.
 */
export type Intent =
  | { kind: 'tool'; tool: Tool }
  | { kind: 'undo' }
  | { kind: 'apply-crop' }
  | { kind: 'cancel-crop' }
  | { kind: 'done' }
  | { kind: 'cancel' };

/** The shape of a KeyboardEvent this cares about — so tests need no DOM. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Returns null for any key the editor does not own, which lets it bubble to the
 * parent untouched — Del (remove the image) and the app's own shortcuts stay the
 * parent's business.
 */
export function keyIntent(e: KeyLike, hasPendingCrop: boolean): Intent | null {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  if (mod && k === 'z') return { kind: 'undo' };
  // Any other modifier combo belongs to the app, not to a single-letter tool.
  if (mod || e.altKey) return null;

  if (k === 'p') return { kind: 'tool', tool: 'pen' };
  if (k === 'o') return { kind: 'tool', tool: 'circle' };
  if (k === 'c') return { kind: 'tool', tool: 'crop' };
  if (k === 'enter') return hasPendingCrop ? { kind: 'apply-crop' } : { kind: 'done' };
  if (k === 'escape') return hasPendingCrop ? { kind: 'cancel-crop' } : { kind: 'cancel' };
  return null;
}
