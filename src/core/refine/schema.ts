/**
 * The refine output schema — ONE schema, both providers: Claude takes it inline via
 * `--json-schema`, Codex reads it from a file via `--output-schema`.
 *
 * Deliberately restricted to the JSON Schema keywords both providers accept:
 * type / enum / properties / required / additionalProperties / items / description.
 * The numeric limits (title length, list caps, "at least one section") live in
 * `description` — where the model reads them — and are enforced for real in parse.ts.
 * Putting them in the schema as `maxLength` / `minItems` / `maxItems` would buy no
 * guarantee we don't already have and risks a hard reject on Codex's strict
 * structured-output path, where one unsupported keyword fails the whole turn.
 *
 * Wire format is snake_case (`follow_ups`, `similar_issues`); parse.ts maps it to the
 * camelCase `RefinedDraft` in types.ts.
 */

import { IMAGE_REF_SCHEME } from '../types.ts';

export const REPORT_TYPES = ['bug', 'feature', 'chore'] as const;

/**
 * Every heading the format allows, union of all three types. The enum is what keeps
 * sections lean: the model cannot invent a "Notes" or "Additional context" section.
 */
export const SECTION_HEADINGS = [
  'Repro steps',
  'Expected',
  'Actual',
  'Environment',
  'Problem',
  'Proposed solution',
  'What',
  'Why',
] as const;

/** Soft ceiling from the spec ("<= ~70 chars"). Stated in the prompt, clamped in parse.ts. */
export const TITLE_MAX_CHARS = 70;
export const MAX_FOLLOW_UPS = 4;
export const MAX_SIMILAR_ISSUES = 3;

export const REFINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'sections', 'follow_ups', 'similar_issues'],
  properties: {
    type: {
      type: 'string',
      enum: REPORT_TYPES,
      description:
        'bug = something behaves wrong. feature = something should exist that does not. ' +
        'chore = maintenance with no user-visible behavior change.',
    },
    title: {
      type: 'string',
      description:
        `One line of English, at most ${TITLE_MAX_CHARS} characters, with NO prefix — ` +
        'never "Bug:", "[Bug]", "fix:" or "feat(ui):". Bugs state the symptom; features ' +
        'and chores use the imperative.',
    },
    sections: {
      type: 'array',
      description:
        'The ticket body, in order. At least one. Include ONLY sections you have real ' +
        'information for — a section you would have to invent or pad is left out of this ' +
        'array entirely. Use only the headings belonging to the chosen type.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: {
            type: 'string',
            enum: SECTION_HEADINGS,
            description:
              'bug: Repro steps, Expected, Actual, Environment. feature: Problem, ' +
              'Proposed solution. chore: What, Why.',
          },
          body: {
            type: 'string',
            description:
              'Markdown, plain and short. Never "N/A", "None", "Unknown", "TBD", or a ' +
              'restatement of the heading — omit the section instead. Images embed inline ' +
              `here as ![description](${IMAGE_REF_SCHEME}<id>).`,
          },
        },
      },
    },
    follow_ups: {
      type: 'array',
      description:
        `Zero to ${MAX_FOLLOW_UPS} optional questions, asked as one batch. Only ask for ` +
        'missing details that would materially change the ticket. Zero is common and valid.',
      items: { type: 'string' },
    },
    similar_issues: {
      type: 'array',
      description:
        `At most ${MAX_SIMILAR_ISSUES} of the open issues you were shown that plausibly ` +
        'describe the same underlying thing. Empty is the common, correct answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title', 'reason'],
        properties: {
          number: {
            type: 'integer',
            description: 'The issue number, exactly as shown to you. Never invent one.',
          },
          title: { type: 'string', description: 'The issue title, as shown to you.' },
          reason: {
            type: 'string',
            description: 'One short, concrete line on why it looks like the same thing.',
          },
        },
      },
    },
  },
} as const;
