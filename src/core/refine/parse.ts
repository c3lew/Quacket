/**
 * Parsing the model's structured output into a RefinedDraft, and the point where the
 * no-fabrication rule stops being a request and becomes a guarantee.
 *
 * Two failure modes, deliberately handled differently:
 *
 *   STRUCTURE violation (not an object, unknown type, section isn't {heading, body})
 *     -> throw. The model ignored the contract; the draft is garbage and the UI's
 *        Retry / File-as-is path is the right answer.
 *
 *   CONTENT violation (a section padded with "N/A", a blank follow-up, a malformed
 *   similar-issue entry)
 *     -> drop it. The model followed the contract and had nothing to say. Dropping is
 *        exactly what types.ts encodes: DraftSection has no empty state, so a padded
 *        section is not a section. Throwing away an otherwise-good draft over one
 *        stray "N/A" would just cost the user a re-run of the same call.
 *
 * A draft with nothing left after dropping IS garbage, and throws.
 */

import {
  ProviderError,
  type DraftSection,
  type RefinedDraft,
  type ReportType,
  type SimilarIssue,
} from '../types.ts';
import {
  MAX_FOLLOW_UPS,
  MAX_SIMILAR_ISSUES,
  REPORT_TYPES,
  TITLE_MAX_CHARS,
} from './schema.ts';

/** Parse failures are provider errors: ErrorKind is the whole surface the UI speaks. */
function fail(detail: string): never {
  throw new ProviderError('provider_error', 'The AI returned an unusable draft.', detail);
}

export function parseRefined(raw: unknown): RefinedDraft {
  if (!isObject(raw)) {
    fail(`expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  return {
    type: parseType(raw.type),
    title: parseTitle(raw.title),
    sections: parseSections(raw.sections),
    followUps: parseFollowUps(raw.follow_ups),
    similarIssues: parseSimilarIssues(raw.similar_issues),
  };
}

// ── type ────────────────────────────────────────────────────────────────────

function parseType(v: unknown): ReportType {
  if (typeof v === 'string' && (REPORT_TYPES as readonly string[]).includes(v)) {
    return v as ReportType;
  }
  return fail(`type must be one of ${REPORT_TYPES.join(' | ')}, got ${JSON.stringify(v)}`);
}

// ── title ───────────────────────────────────────────────────────────────────

const PREFIX_WORD =
  'bug|bugfix|fix|feat|feature|chore|task|issue|enhancement|refactor|docs';

/**
 * Only strips prefixes built from an actual type word, so a legitimate title that
 * happens to start with a bracket ("[object Object] appears in the log") survives.
 */
const TITLE_PREFIX = new RegExp(
  `^(?:\\[(?:${PREFIX_WORD})\\]` +
    `|\\((?:${PREFIX_WORD})\\)` +
    `|(?:${PREFIX_WORD})\\b(?:\\([^)]{1,24}\\))?(?:\\s*:|\\s+[-–—]\\s+))\\s*`,
  'i',
);

function parseTitle(v: unknown): string {
  if (typeof v !== 'string') fail(`title must be a string, got ${typeof v}`);

  const title = clamp(stripPrefix(collapse(v)));
  if (title === '') fail('title is empty');
  return title;
}

function stripPrefix(s: string): string {
  let out = s;
  let stripped = false;
  // Loop: "[Bug] fix: ..." wears two.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TITLE_PREFIX, '').trim();
    if (next === out) break;
    out = next;
    stripped = true;
  }
  // Stripping to nothing is allowed: a title that was only a prefix ("Bug:") has no
  // content, and parseTitle throwing on it beats filing an issue titled "Bug:".

  // Re-capitalize only what WE lowercased by stripping ("Bug: login dies" -> "Login
  // dies"). A title the model deliberately opened in lowercase ("gh auth status reports
  // a stale account") is left exactly as written.
  return stripped && /^[a-z]+\b/.test(out) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/**
 * The spec's "~70" is soft and the title is editable on the draft screen, so an
 * over-long title is not garbage — but something has to hold the line, and truncating
 * at a word boundary reads better than an ellipsis or a thrown-away draft.
 */
function clamp(s: string): string {
  if (s.length <= TITLE_MAX_CHARS) return s;
  const cut = s.slice(0, TITLE_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > TITLE_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

// ── sections ────────────────────────────────────────────────────────────────

const FILLER = new RegExp(
  '^(?:' +
    'n/?a|none|nil|null|unknown|tbd|todo|pending' +
    '|to be (?:determined|confirmed|added)' +
    '|not (?:specified|provided|applicable|mentioned|available|known|stated|given)' +
    '|no (?:information|info|details?|repro steps?|environment(?: details?)?)' +
    '(?: (?:provided|available|given|mentioned|specified))?' +
    ')$',
  'i',
);

/** A section body carrying no information. The prompt forbids these; this enforces it. */
function isFiller(body: string, heading: string): boolean {
  // Strip markdown emphasis/bullets so "_N/A_" and "- None." are caught too. Only used
  // to judge the body — never to rewrite it.
  const s = body
    .trim()
    .replace(/^[*_`>\s-]+/, '')
    .replace(/[*_`\s.!]+$/, '')
    .trim();

  if (s === '') return true;
  if (s.toLowerCase() === heading.trim().toLowerCase()) return true;
  return FILLER.test(s);
}

function parseSections(v: unknown): DraftSection[] {
  if (!Array.isArray(v)) fail(`sections must be an array, got ${typeName(v)}`);

  const out: DraftSection[] = [];
  for (const entry of v) {
    if (!isObject(entry)) fail('every section must be an object');
    const { heading, body } = entry;

    if (typeof heading !== 'string' || heading.trim() === '') {
      fail('every section needs a non-empty heading');
    }
    if (typeof body !== 'string') {
      fail(`section "${heading}" has a ${typeName(body)} body, expected a string`);
    }
    if (isFiller(body, heading)) continue;

    out.push({ heading: heading.trim(), body: body.trim() });
  }

  if (out.length === 0) fail('no section had any real content');
  return out;
}

// ── follow-ups ──────────────────────────────────────────────────────────────

/**
 * Absent is not a structure violation worth throwing over: follow-ups are skippable by
 * design, so a draft without them is fully usable. Absent means none.
 */
function parseFollowUps(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`follow_ups must be an array, got ${typeName(v)}`);

  return v
    .filter((q): q is string => typeof q === 'string')
    .map(collapse)
    .filter((q) => q !== '')
    .slice(0, MAX_FOLLOW_UPS);
}

// ── similar issues ──────────────────────────────────────────────────────────

/**
 * Suggestions are advisory and never blocking, so a malformed one is dropped rather
 * than thrown: a bad duplicate guess must not cost the user their draft.
 *
 * Note this cannot catch an invented issue NUMBER — parseRefined does not see the
 * candidate list. Cross-checking against the issues actually shown is the caller's job.
 */
function parseSimilarIssues(v: unknown): SimilarIssue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`similar_issues must be an array, got ${typeName(v)}`);

  const out: SimilarIssue[] = [];
  for (const entry of v) {
    if (!isObject(entry)) continue;
    const { number, title, reason } = entry;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;

    const t = collapse(typeof title === 'string' ? title : '');
    const r = collapse(typeof reason === 'string' ? reason : '');
    if (t === '' || r === '') continue;

    out.push({ number, title: t, reason: r });
  }
  return out.slice(0, MAX_SIMILAR_ISSUES);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const typeName = (v: unknown): string =>
  Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
