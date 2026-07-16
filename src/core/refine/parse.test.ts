import { describe, expect, it } from 'vitest';
import { ProviderError, imageRef } from '../types.ts';
import { parseRefined } from './parse.ts';

/**
 * Fixtures are shaped like what the CLIs actually hand back: Claude's parsed
 * `structured_output` object, or the JSON Codex writes to its `-o` file once parsed.
 * parseRefined takes it from there, so these are plain objects — no runner involved.
 * This module spawns nothing; there is no process to fake.
 */

const wellFormed = {
  type: 'bug',
  title: 'Refine spinner never resolves on the first attempt',
  sections: [
    { heading: 'Repro steps', body: 'Press Refine on a fresh capture.' },
    { heading: 'Expected', body: 'Refine finishes and the draft appears.' },
    { heading: 'Actual', body: 'The spinner never resolves. A second attempt works.' },
  ],
  follow_ups: ['Which model was selected when it hung?'],
  similar_issues: [
    { number: 41, title: 'Repo picker is slow to open', reason: 'Also a stuck spinner.' },
  ],
};

const headings = (r: { sections: { heading: string }[] }) => r.sections.map((s) => s.heading);

describe('parseRefined', () => {
  it('parses a well-formed response into a RefinedDraft', () => {
    expect(parseRefined(wellFormed)).toEqual({
      type: 'bug',
      title: 'Refine spinner never resolves on the first attempt',
      sections: [
        { heading: 'Repro steps', body: 'Press Refine on a fresh capture.' },
        { heading: 'Expected', body: 'Refine finishes and the draft appears.' },
        { heading: 'Actual', body: 'The spinner never resolves. A second attempt works.' },
      ],
      followUps: ['Which model was selected when it hung?'],
      similarIssues: [
        { number: 41, title: 'Repo picker is slow to open', reason: 'Also a stuck spinner.' },
      ],
    });
  });

  it('maps the snake_case wire fields onto the camelCase domain type', () => {
    const draft = parseRefined(wellFormed);
    expect(draft.followUps).toHaveLength(1);
    expect(draft.similarIssues).toHaveLength(1);
    expect(draft).not.toHaveProperty('follow_ups');
    expect(draft).not.toHaveProperty('similar_issues');
  });

  // ── the no-fabrication rule ───────────────────────────────────────────────

  describe('no-fabrication rule', () => {
    it('yields no Environment section when the report carries no environment info', () => {
      const draft = parseRefined(wellFormed);
      expect(headings(draft)).toEqual(['Repro steps', 'Expected', 'Actual']);
      expect(headings(draft)).not.toContain('Environment');
      expect(draft.sections.find((s) => s.heading === 'Environment')).toBeUndefined();
    });

    it.each([
      'N/A',
      'n/a',
      'None',
      'none.',
      'Unknown',
      'TBD',
      'Not specified',
      'Not provided.',
      'No information available',
      'No environment details provided',
      '_N/A_',
      '   ',
      '-',
    ])('drops a section padded with %j', (filler) => {
      const draft = parseRefined({
        ...wellFormed,
        sections: [...wellFormed.sections, { heading: 'Environment', body: filler }],
      });
      expect(headings(draft)).not.toContain('Environment');
      // ...and the real sections are untouched.
      expect(headings(draft)).toEqual(['Repro steps', 'Expected', 'Actual']);
    });

    it('drops a section whose body only restates its heading', () => {
      const draft = parseRefined({
        ...wellFormed,
        sections: [...wellFormed.sections, { heading: 'Environment', body: 'Environment' }],
      });
      expect(headings(draft)).not.toContain('Environment');
    });

    it('keeps a section that genuinely has environment info', () => {
      const draft = parseRefined({
        ...wellFormed,
        sections: [
          ...wellFormed.sections,
          { heading: 'Environment', body: 'Windows 11, Quacket 0.1.0' },
        ],
      });
      expect(draft.sections.at(-1)).toEqual({
        heading: 'Environment',
        body: 'Windows 11, Quacket 0.1.0',
      });
    });

    it('does not mistake real content that merely mentions a filler word for filler', () => {
      const draft = parseRefined({
        ...wellFormed,
        sections: [{ heading: 'Actual', body: 'The status field shows "Unknown" forever.' }],
      });
      expect(draft.sections).toHaveLength(1);
    });

    it('throws when every section is padding, since nothing usable is left', () => {
      expect(() =>
        parseRefined({
          ...wellFormed,
          sections: [
            { heading: 'Repro steps', body: 'N/A' },
            { heading: 'Environment', body: 'Unknown' },
          ],
        }),
      ).toThrow(ProviderError);
    });
  });

  // ── image placeholders ────────────────────────────────────────────────────

  it('carries the quacket-image placeholder through parse verbatim', () => {
    const body = `The dialog renders empty:\n\n![empty dialog](${imageRef('img_1')})`;
    const draft = parseRefined({
      ...wellFormed,
      sections: [{ heading: 'Actual', body }],
    });
    expect(draft.sections[0]?.body).toBe(body);
    expect(draft.sections[0]?.body).toContain('](quacket-image:img_1)');
  });

  // ── titles ────────────────────────────────────────────────────────────────

  describe('title', () => {
    const titleOf = (title: unknown) => parseRefined({ ...wellFormed, title }).title;

    it.each([
      ['Bug: login button does nothing', 'Login button does nothing'],
      ['[Bug] Login button does nothing', 'Login button does nothing'],
      ['[bug] login button does nothing', 'Login button does nothing'],
      ['fix(auth): Login button does nothing', 'Login button does nothing'],
      ['feat: Add a fuzzy repo switcher', 'Add a fuzzy repo switcher'],
      ['Feature - dark mode', 'Dark mode'],
      ['chore: Bump vitest to 3.2', 'Bump vitest to 3.2'],
      ['[Bug] fix: login button does nothing', 'Login button does nothing'],
    ])('strips the type prefix off %j', (input, expected) => {
      expect(titleOf(input)).toBe(expected);
    });

    it.each([
      'Fix login redirect loop',
      'Add a keyboard shortcut for switching repos',
      '[object Object] appears in the log',
      'Feature-flag rollout breaks on restart',
      'Login button does nothing on the first click',
    ])('leaves the prefix-free title %j alone', (title) => {
      expect(titleOf(title)).toBe(title);
    });

    it('collapses a multi-line title to a single line', () => {
      expect(titleOf('Login button\n  does nothing\ton click')).toBe(
        'Login button does nothing on click',
      );
    });

    it('clamps an over-long title at a word boundary', () => {
      const long =
        'Refine hangs forever when pasting a very large screenshot into the capture window';
      const title = titleOf(long);
      expect(title.length).toBeLessThanOrEqual(70);
      expect(long.startsWith(title)).toBe(true);
      expect(title.endsWith(' ')).toBe(false);
      // Cut on whitespace, not mid-word.
      expect(long[title.length]).toBe(' ');
    });

    it('leaves a title at the limit untouched', () => {
      const exactly70 = 'Refine hangs forever when pasting a large screenshot into it';
      expect(exactly70).toHaveLength(60);
      expect(titleOf(exactly70)).toBe(exactly70);
      expect(titleOf(`${exactly70} now!!`)).toHaveLength(66);
    });

    it('capitalizes a title left lowercase by prefix stripping', () => {
      expect(titleOf('bug: login button does nothing')).toBe('Login button does nothing');
      // ...and never touches a title we did not strip, whatever its case.
      expect(titleOf('iOS build crashes on launch')).toBe('iOS build crashes on launch');
      expect(titleOf('gh auth status reports a stale account')).toBe(
        'gh auth status reports a stale account',
      );
    });

    it.each([['', 'empty'], ['   \n ', 'whitespace'], ['Bug:', 'nothing but a prefix']])(
      'throws when the title is %j (%s)',
      (title) => {
        expect(() => titleOf(title)).toThrow(ProviderError);
      },
    );
  });

  // ── follow-ups & similar issues ───────────────────────────────────────────

  describe('follow_ups', () => {
    it('treats an absent batch as no questions', () => {
      const { follow_ups: _omitted, ...rest } = wellFormed;
      expect(parseRefined(rest).followUps).toEqual([]);
    });

    it('drops blank questions and caps the batch at 4', () => {
      const draft = parseRefined({
        ...wellFormed,
        follow_ups: ['Q1?', '', '   ', 'Q2?', 'Q3?', 'Q4?', 'Q5?', 'Q6?'],
      });
      expect(draft.followUps).toEqual(['Q1?', 'Q2?', 'Q3?', 'Q4?']);
    });

    it('throws when the batch is not an array', () => {
      expect(() => parseRefined({ ...wellFormed, follow_ups: 'Q1?' })).toThrow(ProviderError);
    });
  });

  describe('similar_issues', () => {
    it('treats an absent list as no suggestions', () => {
      const { similar_issues: _omitted, ...rest } = wellFormed;
      expect(parseRefined(rest).similarIssues).toEqual([]);
    });

    it.each([
      ['a missing reason', { number: 7, title: 'T' }],
      ['a blank reason', { number: 7, title: 'T', reason: '  ' }],
      ['a non-integer number', { number: 7.5, title: 'T', reason: 'r' }],
      ['a string number', { number: '7', title: 'T', reason: 'r' }],
      ['no title', { number: 7, reason: 'r' }],
    ])('drops a suggestion with %s rather than failing the draft', (_label, bad) => {
      const draft = parseRefined({ ...wellFormed, similar_issues: [bad] });
      expect(draft.similarIssues).toEqual([]);
      // The draft itself still made it through — suggestions are never blocking.
      expect(draft.title).toBe(wellFormed.title);
    });

    it('caps suggestions at 3', () => {
      const draft = parseRefined({
        ...wellFormed,
        similar_issues: [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `T${n}`, reason: 'r' })),
      });
      expect(draft.similarIssues.map((s) => s.number)).toEqual([1, 2, 3]);
    });
  });

  // ── garbage ───────────────────────────────────────────────────────────────

  describe('rejects garbage', () => {
    it.each([
      ['a string', 'not json'],
      ['null', null],
      ['an array', [{ title: 'x' }]],
      ['a number', 7],
    ])('throws on %s', (_label, input) => {
      expect(() => parseRefined(input)).toThrow(ProviderError);
    });

    it.each([
      ['an unknown report type', { ...wellFormed, type: 'question' }],
      ['a missing report type', { ...wellFormed, type: undefined }],
      ['a non-string title', { ...wellFormed, title: 42 }],
      ['sections as a string', { ...wellFormed, sections: 'Repro steps: click it' }],
      ['a missing sections array', { ...wellFormed, sections: undefined }],
      ['an empty sections array', { ...wellFormed, sections: [] }],
      ['a section that is not an object', { ...wellFormed, sections: ['Repro steps'] }],
      ['a section with no heading', { ...wellFormed, sections: [{ body: 'text' }] }],
      ['a section with a non-string body', { ...wellFormed, sections: [{ heading: 'Actual', body: 3 }] }],
    ])('throws on %s', (_label, input) => {
      expect(() => parseRefined(input)).toThrow(ProviderError);
    });

    it('reports parse failure as a provider_error the UI already speaks', () => {
      try {
        parseRefined('not json');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError);
        const err = e as ProviderError;
        expect(err.kind).toBe('provider_error');
        // Plain language: shown to the user as-is.
        expect(err.message).toBe('The AI returned an unusable draft.');
        expect(err.detail).toContain('string');
      }
    });
  });

  // ── no marker ─────────────────────────────────────────────────────────────

  it('adds no Quacket marker, footer, or attribution to the draft', () => {
    const draft = parseRefined({
      ...wellFormed,
      sections: [{ heading: 'Actual', body: `Broken:\n\n![shot](${imageRef('img_1')})` }],
    });
    // The image placeholder is the ONLY place the word may legitimately appear.
    const serialized = JSON.stringify(draft).replaceAll('quacket-image:img_1', '');
    expect(serialized).not.toMatch(/quacket/i);
    expect(serialized).not.toMatch(/generated (by|with)/i);
    expect(serialized).not.toMatch(/refined by/i);
    expect(serialized).not.toMatch(/🦆/);
  });
});
