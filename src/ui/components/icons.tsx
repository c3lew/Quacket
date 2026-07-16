/**
 * The icon system: line icons on a 16px grid, drawn as inline SVG.
 *
 * Every icon strokes `currentColor`, so it inherits the colour and state of
 * whatever it sits in and needs no per-state variant. Emoji are not an option —
 * they render differently per OS, cannot be recoloured or stroke-tuned, and read
 * as unfinished. That includes the duck: it is a drawn mark, not 🦆.
 */

const PATHS = {
  // Chrome
  duck: 'M8 3a4 4 0 0 1 4 4v1h2l-2 2.5c.6 4-2 6.5-6 6.5-3.5 0-6-2-6-5.5C0 8 2 6.5 4.5 6.5h.6A4 4 0 0 1 8 3Z',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.9-1.3a5.9 5.9 0 0 0 0-1.4l1.3-1-1.5-2.6-1.6.6a6 6 0 0 0-1.2-.7L10.6 2H7.4l-.3 1.6c-.4.2-.8.4-1.2.7l-1.6-.6L2.8 6.3l1.3 1a5.9 5.9 0 0 0 0 1.4l-1.3 1 1.5 2.6 1.6-.6c.4.3.8.5 1.2.7l.3 1.6h3.2l.3-1.6c.4-.2.8-.4 1.2-.7l1.6.6 1.5-2.6-1.3-1Z',
  close: 'm4 4 8 8M12 4l-8 8',
  back: 'm10 4-4 4 4 4',
  chevronDown: 'm4.5 6.5 3.5 3.5 3.5-3.5',
  chevronRight: 'm6 4 4 4-4 4',

  // Actions
  zap: 'M8.5 1.5 3 9h4l-1.5 5.5L11 7H7l1.5-5.5Z',
  check: 'm3.5 8.5 3 3 6-7',
  copy: 'M5.5 5.5h8v8h-8zM3 10.5h-.5v-8h8V3',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3',
  external: 'M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13 3 7.5 8.5',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9M6.5 7v4M9.5 7v4',
  pencil: 'M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5zM10 4l2 2',
  image: 'M2.5 3.5h11v9h-11zM5.5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm-3 4.5 3.5-3 2.5 2 2.5-2.5 2.5 2.5',
  plus: 'M8 3.5v9M3.5 8h9',

  // Meaning
  repo: 'M4 2.5h8.5v11H5a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 5 2.5M4 10.5h8.5M6 5.5h4',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  comment: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  question: 'M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.8M8 12h.01',
  warning: 'M8 2 1.5 13.5h13L8 2Zm0 4.5V10M8 12h.01',
  key: 'M9.5 6.5a3 3 0 1 0-3 3l1 0v1.5h1.5V12.5h1.5l0-1.5 1.5 0V9.5z',
  github:
    'M8 1.5a6.5 6.5 0 0 0-2 12.7c.3 0 .4-.1.4-.3v-1.2c-1.8.4-2.2-.9-2.2-.9-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.7 0 1 .7 1 .7.6 1 1.6.7 2 .6 0-.5.2-.8.4-1-1.4-.2-2.9-.7-2.9-3.2 0-.7.2-1.3.7-1.7-.1-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 0 1 3.2 0c1.3-.9 1.8-.7 1.8-.7.4.9.2 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-2.9 3.2.2.2.4.6.4 1.2v1.8c0 .2.1.4.4.3A6.5 6.5 0 0 0 8 1.5Z',

  // Report types
  bug: 'M5 6a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0zM6 4.5 5 3.5M10 4.5l1-1M5 7.5H2.5M11 7.5h2.5M5 10.5l-2 1.5M11 10.5l2 1.5',
  feature: 'M8 2l1.6 3.6L13.5 6l-2.8 2.6.7 3.9L8 10.7 4.6 12.5l.7-3.9L2.5 6l3.9-.4z',
  chore: 'M10.5 2.5a3.5 3.5 0 0 0-4.3 4.3l-4 4a1.2 1.2 0 0 0 1.7 1.7l4-4a3.5 3.5 0 0 0 4.3-4.3L10 4.5 9 4l-.5-1z',

  // Annotation tools
  circle: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z',
  crop: 'M4.5 1.5v10h10M1.5 4.5h10v10',
} as const;

export type IconName = keyof typeof PATHS;

/** Solid marks. Everything else is a stroked line icon. */
const FILLED = new Set<IconName>(['duck', 'github']);

export function Icon({
  name,
  size = 15,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
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
      {filled ? <path d={PATHS[name]} fill="currentColor" stroke="none" /> : <path d={PATHS[name]} />}
    </svg>
  );
}

/**
 * The product mark. The eye is punched in the panel colour rather than drawn in
 * a fixed grey, so the duck stays legible on whatever it sits on.
 */
export function DuckMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d={PATHS.duck} fill="currentColor" />
      <circle cx="9.4" cy="6.3" r="0.85" fill="var(--duck-eye)" />
    </svg>
  );
}

/**
 * Duck mark + wordmark. The window chrome's identity, top-left, always.
 *
 * Also a drag handle (#19): the window is undecorated and Tauri starts a drag
 * only when the mousedown TARGET carries the attribute, so the children are
 * made pointer-inert (`.wordmark` in styles.css) to keep the span the target —
 * otherwise the duck and the bold text would be dead spots in the title bar.
 */
export function Wordmark() {
  return (
    <span className="wordmark" data-tauri-drag-region>
      <DuckMark size={18} />
      <b>Quacket</b>
    </span>
  );
}

/** The one indeterminate progress affordance. */
export function Spinner({ size = 15 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
