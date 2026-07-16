/**
 * The image annotation editor.
 *
 * Opens ONLY when the user clicks a thumbnail — annotation is never forced, and
 * nothing here runs unless it was asked for. `onDone` flattens the marks onto
 * the image and hands back new PNG bytes (destructive in v1); `onCancel`
 * throws the edits away.
 *
 * All the decisions live in ./model.ts as pure functions. What is left here is
 * paint calls and event plumbing, which is the part a test could not reach
 * anyway.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ImageAttachment } from '../../core/types.ts';
import {
  clampRect,
  effectiveView,
  isUsableCrop,
  keyIntent,
  MARK_COLOR,
  normRect,
  roundRect,
  strokeWidth,
  toBasePoint,
  type Intent,
  type Op,
  type Point,
  type Rect,
  type Tool,
} from './model.ts';
import './annotate.css';

export interface AnnotateEditorProps {
  image: ImageAttachment;
  /** Flattened PNG bytes. The edits are baked in — v1 keeps no original. */
  onDone: (bytes: Uint8Array) => void;
  /** Discards every edit; the image is left exactly as it was. */
  onCancel: () => void;
}

// ── Icons ───────────────────────────────────────────────────────────────────
// Inline SVG, stroke="currentColor" so each one inherits its control's colour
// and state. Never emoji: they cannot be recoloured and render differently on
// every machine.

const Svg = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={d} />
  </svg>
);

const PenIcon = () => <Svg d="m3 13 .9-3.6L10.6 2.7a1.6 1.6 0 0 1 2.7 1.1c0 .4-.17.83-.47 1.13L6.1 11.6 3 13Z" />;
const CropIcon = () => <Svg d="M5 2v8a1 1 0 0 0 1 1h8M2 5h8a1 1 0 0 1 1 1v8" />;
const UndoIcon = () => <Svg d="m6 3.5-3 3 3 3M3 6.5h6.5a3.5 3.5 0 1 1 0 7H7" />;
const CheckIcon = () => <Svg d="m3.5 8.5 3 3 6-7" />;
const BackIcon = () => <Svg d="m10 4-4 4 4 4" />;
const XIcon = () => <Svg d="m4 4 8 8M12 4l-8 8" />;
const CircleIcon = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    aria-hidden="true"
    focusable="false"
  >
    <ellipse cx="8" cy="8" rx="6" ry="4.3" />
  </svg>
);

const TOOLS: Array<{ tool: Tool; label: string; hint: string; icon: () => React.ReactElement }> = [
  { tool: 'pen', label: 'Pen', hint: 'P', icon: PenIcon },
  { tool: 'circle', label: 'Circle', hint: 'O', icon: CircleIcon },
  { tool: 'crop', label: 'Crop', hint: 'C', icon: CropIcon },
];

// ── Painting ────────────────────────────────────────────────────────────────

function drawMark(cx: CanvasRenderingContext2D, op: Op): void {
  if (op.kind === 'crop') return;
  cx.lineWidth = op.width;
  cx.beginPath();
  if (op.kind === 'pen') {
    const first = op.points[0];
    if (!first) return;
    cx.moveTo(first.x, first.y);
    for (const p of op.points.slice(1)) cx.lineTo(p.x, p.y);
    // A click with no drag is still a deliberate dot, so give it length to stroke.
    if (op.points.length === 1) cx.lineTo(first.x + 0.01, first.y);
  } else {
    const { x, y, w, h } = op.rect;
    cx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  }
  cx.stroke();
}

/** Dim everything outside the selection so the crop reads as "this part stays". */
function drawCropBox(cx: CanvasRenderingContext2D, view: Rect, r: Rect): void {
  const x = r.x - view.x;
  const y = r.y - view.y;
  cx.save();
  cx.fillStyle = 'rgba(0,0,0,.55)';
  cx.beginPath();
  cx.rect(0, 0, view.w, view.h);
  cx.rect(x, y, r.w, r.h);
  cx.fill('evenodd');
  cx.setLineDash([6, 4]);
  cx.lineWidth = 2;
  cx.strokeStyle = '#fff';
  cx.strokeRect(x, y, r.w, r.h);
  cx.restore();
}

/**
 * Render the whole editor state into a context sized to `view`. Ops carry base
 * coordinates, so one translate puts them all in the right place — including
 * marks made before a crop, which the canvas bounds then clip for free.
 */
function paintInto(
  cx: CanvasRenderingContext2D,
  base: CanvasImageSource,
  ops: Op[],
  draft: Op | null,
  pending: Rect | null,
  view: Rect,
): void {
  cx.clearRect(0, 0, view.w, view.h);
  cx.drawImage(base, view.x, view.y, view.w, view.h, 0, 0, view.w, view.h);
  cx.save();
  cx.translate(-view.x, -view.y);
  cx.strokeStyle = MARK_COLOR;
  cx.lineCap = 'round';
  cx.lineJoin = 'round';
  for (const op of ops) drawMark(cx, op);
  if (draft) drawMark(cx, draft);
  cx.restore();
  if (pending) drawCropBox(cx, view, pending);
}

// ── Component ───────────────────────────────────────────────────────────────

export function AnnotateEditor({ image, onDone, onCancel }: AnnotateEditorProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<Point | null>(null);

  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [ops, setOps] = useState<Op[]>([]);
  const [draft, setDraft] = useState<Op | null>(null);
  const [pending, setPending] = useState<Rect | null>(null);

  const base = baseRef.current;
  const view = effectiveView(ops, base?.naturalWidth ?? 0, base?.naturalHeight ?? 0);

  // Decode the attachment. Resetting the edits here means a swapped image can
  // never inherit marks positioned against the old one's pixels.
  useEffect(() => {
    setReady(false);
    setOps([]);
    setDraft(null);
    setPending(null);
    dragRef.current = null;

    // types.ts types bytes as a bare `Uint8Array`, which since TS 5.7 means
    // `Uint8Array<ArrayBufferLike>` — and BlobPart rejects it only because
    // ArrayBufferLike admits SharedArrayBuffer. Nothing here ever produces one
    // (bytes come from disk, the clipboard, or a canvas), so narrowing is sound
    // and beats copying the whole screenshot to satisfy the checker.
    const bytes = image.bytes as Uint8Array<ArrayBuffer>;
    const url = URL.createObjectURL(new Blob([bytes], { type: image.mediaType }));
    const img = new Image();
    img.onload = () => {
      baseRef.current = img;
      setReady(true);
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
      baseRef.current = null;
    };
  }, [image.bytes, image.mediaType]);

  // Repaint after every render: the canvas is a projection of state, so there is
  // no incremental path to get out of sync.
  useEffect(() => {
    const cv = canvasRef.current;
    const img = baseRef.current;
    if (!cv || !img || !ready) return;
    cv.width = view.w;
    cv.height = view.h;
    const cx = cv.getContext('2d');
    if (cx) paintInto(cx, img, ops, draft, pending, view);
  });

  // The editor owns the keyboard while it is open, so it takes focus on mount.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const flatten = useCallback(() => {
    const img = baseRef.current;
    if (!img) return;
    // Paint fresh into an offscreen canvas rather than reading the visible one:
    // a pending crop box is a selection, not an edit, and must never be baked in.
    const out = document.createElement('canvas');
    const final = effectiveView(ops, img.naturalWidth, img.naturalHeight);
    out.width = final.w;
    out.height = final.h;
    const cx = out.getContext('2d');
    if (!cx) return;
    paintInto(cx, img, ops, null, null, final);
    out.toBlob((blob) => {
      if (!blob) return;
      void blob.arrayBuffer().then((buf) => onDone(new Uint8Array(buf)));
    }, 'image/png');
  }, [ops, onDone]);

  const run = useCallback(
    (intent: Intent) => {
      switch (intent.kind) {
        case 'tool':
          setTool(intent.tool);
          setPending(null);
          return;
        case 'undo':
          setOps((o) => o.slice(0, -1));
          return;
        case 'apply-crop':
          if (pending) {
            setOps((o) => [...o, { kind: 'crop', rect: roundRect(pending) }]);
            setPending(null);
          }
          return;
        case 'cancel-crop':
          setPending(null);
          return;
        case 'done':
          flatten();
          return;
        case 'cancel':
          onCancel();
          return;
      }
    },
    [pending, flatten, onCancel],
  );

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const b = e.currentTarget.getBoundingClientRect();
    return toBasePoint(
      { x: e.clientX, y: e.clientY },
      { x: b.left, y: b.top, w: b.width, h: b.height },
      view,
    );
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointAt(e);
    dragRef.current = p;
    const width = strokeWidth(view.w);
    if (tool === 'pen') setDraft({ kind: 'pen', points: [p], width });
    else if (tool === 'circle') setDraft({ kind: 'circle', rect: normRect(p, p), width });
    else setPending(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const p = pointAt(e);
    if (tool === 'pen') {
      setDraft((d) => (d?.kind === 'pen' ? { ...d, points: [...d.points, p] } : d));
    } else if (tool === 'circle') {
      setDraft((d) => (d?.kind === 'circle' ? { ...d, rect: normRect(start, p) } : d));
    } else {
      setPending(clampRect(normRect(start, p), view));
    }
  };

  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (tool === 'crop') {
      setPending((p) => (p && isUsableCrop(p) ? p : null));
      return;
    }
    if (draft) {
      setOps((o) => [...o, draft]);
      setDraft(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const intent = keyIntent(e, pending !== null);
    if (!intent) return; // Not ours — let it reach the app.
    e.preventDefault();
    e.stopPropagation();
    run(intent);
  };

  return (
    <div className="qk-annotate" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="qk-annotate__bar">
        {TOOLS.map(({ tool: t, label, hint, icon: Icon }) => (
          <button
            key={t}
            type="button"
            className={`qk-annotate__tool${tool === t ? ' is-on' : ''}`}
            aria-pressed={tool === t}
            onClick={() => run({ kind: 'tool', tool: t })}
          >
            <Icon />
            {label}
            <kbd>{hint}</kbd>
          </button>
        ))}

        <span className="qk-annotate__sep" />

        <button
          type="button"
          className="qk-annotate__tool"
          disabled={ops.length === 0}
          onClick={() => run({ kind: 'undo' })}
        >
          <UndoIcon />
          Undo
          <kbd>Ctrl+Z</kbd>
        </button>

        {/* A crop is a two-step gesture, so step two gets real buttons rather
            than a line of text explaining which keys to press. */}
        {pending && (
          <span className="qk-annotate__cropactions">
            <button type="button" className="qk-annotate__tool" onClick={() => run({ kind: 'cancel-crop' })}>
              <XIcon />
              Discard crop
              <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="qk-annotate__tool is-accent"
              onClick={() => run({ kind: 'apply-crop' })}
            >
              <CheckIcon />
              Apply crop
              <kbd>Enter</kbd>
            </button>
          </span>
        )}
      </div>

      <div className="qk-annotate__stage">
        <canvas
          ref={canvasRef}
          className="qk-annotate__canvas"
          aria-label="Screenshot — drag to mark it up"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      <div className="qk-annotate__foot">
        <button type="button" className="qk-annotate__btn" onClick={() => run({ kind: 'cancel' })}>
          <BackIcon />
          Cancel
          <kbd>Esc</kbd>
        </button>
        <span className="qk-annotate__spacer" />
        <button
          type="button"
          className="qk-annotate__btn is-primary"
          disabled={!ready}
          onClick={() => run({ kind: 'done' })}
        >
          <CheckIcon />
          Done
          <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
}
