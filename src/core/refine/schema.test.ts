import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOW_UPS,
  MAX_SIMILAR_ISSUES,
  REFINE_SCHEMA,
  REPORT_TYPES,
  SECTION_HEADINGS,
  TITLE_MAX_CHARS,
} from './schema.ts';

const schema = REFINE_SCHEMA as unknown as Record<string, any>;

describe('REFINE_SCHEMA', () => {
  it('returns one refine call: type, title, sections, follow-ups, similar issues', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['type', 'title', 'sections', 'follow_ups', 'similar_issues']);
    expect(Object.keys(schema.properties)).toEqual([
      'type',
      'title',
      'sections',
      'follow_ups',
      'similar_issues',
    ]);
  });

  it('classifies as exactly bug | feature | chore', () => {
    expect(schema.properties.type.enum).toEqual(['bug', 'feature', 'chore']);
    expect(REPORT_TYPES).toEqual(['bug', 'feature', 'chore']);
  });

  it('constrains headings to the lean per-type set, so no section can be invented', () => {
    expect(schema.properties.sections.items.properties.heading.enum).toEqual([
      'Repro steps',
      'Expected',
      'Actual',
      'Environment',
      'Problem',
      'Proposed solution',
      'What',
      'Why',
    ]);
    expect(SECTION_HEADINGS).toHaveLength(8);
    // Nothing to hang fabrication on.
    expect(SECTION_HEADINGS as readonly string[]).not.toContain('Additional context');
    expect(SECTION_HEADINGS as readonly string[]).not.toContain('Notes');
  });

  it('makes an omitted section representable and a padded one not', () => {
    const sections = schema.properties.sections;
    // Omission is just a shorter array — there is no per-section "present" flag or
    // nullable body to express "I had nothing here".
    expect(sections.type).toBe('array');
    expect(sections.items.required).toEqual(['heading', 'body']);
    expect(sections.items.properties.body.type).toBe('string');
    expect(sections.items.additionalProperties).toBe(false);
    expect(sections.description).toMatch(/ONLY sections you have real information for/);
    expect(sections.items.properties.body.description).toMatch(/N\/A/);
  });

  it('closes every object so the model cannot smuggle in extra fields', () => {
    const objects = collect(schema, (n) => n.type === 'object');
    expect(objects.length).toBeGreaterThanOrEqual(3);
    for (const o of objects) expect(o.additionalProperties).toBe(false);
  });

  it('carries the numeric limits to the model in descriptions', () => {
    expect(schema.properties.title.description).toContain(String(TITLE_MAX_CHARS));
    expect(schema.properties.follow_ups.description).toContain(String(MAX_FOLLOW_UPS));
    expect(schema.properties.similar_issues.description).toContain(String(MAX_SIMILAR_ISSUES));
  });

  it('tells the model never to invent an issue number it was not shown', () => {
    const similar = schema.properties.similar_issues.items;
    expect(similar.required).toEqual(['number', 'title', 'reason']);
    expect(similar.properties.number.type).toBe('integer');
    expect(similar.properties.number.description).toMatch(/never invent one/i);
  });

  it('states the title must be prefix-free', () => {
    expect(schema.properties.title.description).toMatch(/NO prefix/);
  });

  /**
   * One schema, two transports: Claude takes it inline through --json-schema, Codex
   * reads it from a file through --output-schema. Both mean JSON.stringify, so anything
   * that does not survive a round-trip never reaches the model.
   */
  it('survives a JSON round-trip, which is how both providers receive it', () => {
    const serialized = JSON.stringify(REFINE_SCHEMA);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(REFINE_SCHEMA)));
    expect(serialized).not.toContain('undefined');
  });

  /**
   * Codex's --output-schema lands on a strict structured-output path where a single
   * unsupported keyword fails the whole turn. Keeping to the portable core is what lets
   * ONE schema serve both providers; the numeric limits live in parse.ts instead.
   */
  it('uses only JSON Schema keywords both providers accept', () => {
    const allowed = new Set([
      'type',
      'enum',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'description',
    ]);
    const seen = new Set<string>();
    collect(schema, () => true).forEach((n) => Object.keys(n).forEach((k) => seen.add(k)));

    expect([...seen].filter((k) => !allowed.has(k))).toEqual([]);
    for (const risky of ['maxLength', 'minLength', 'minItems', 'maxItems', 'pattern', 'format']) {
      expect(JSON.stringify(REFINE_SCHEMA)).not.toContain(`"${risky}"`);
    }
  });
});

/** Every schema node (objects with a `type`), depth-first. */
function collect(node: any, pick: (n: any) => boolean): any[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  const here = typeof node.type === 'string' && pick(node) ? [node] : [];
  const kids = [...Object.values(node.properties ?? {}), ...(node.items ? [node.items] : [])];
  return [...here, ...kids.flatMap((k) => collect(k, pick))];
}
