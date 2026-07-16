/**
 * The guard that makes "one picker, everywhere" a property of the REPO.
 *
 * A `<select>` whose `value` matches none of its `<option>`s shows `option[0]`,
 * reads it back, and fires no change when the user picks what is on screen. That
 * defect has been found and fixed in four places across three rounds, and each
 * fix was scoped to the file it was found in — so the next round found it in the
 * next file. Round 4's own re-verify, verbatim: "the invariant is enforced
 * per-FILE, not per-repo, and the defect did what it has done every round: it
 * MOVED."
 *
 * It moves because it is the platform primitive's DEFAULT. Nobody re-introduces
 * it; they just write `<select>`, and it arrives. So the primitive is written
 * down once in `Picker.tsx`, and this test is what stops a fifth surface writing
 * its own — not a convention, not a comment, a red build.
 *
 * ── Why an AST and not a grep ───────────────────────────────────────────────
 *
 * The prose in this repo talks about `<select>` a lot — `Picker.tsx` explains the
 * bug, `SettingsView.tsx` points at it, `App.test.tsx` has a helper docblock
 * about it. A regex flags all of them, and a guard that cries wolf gets an
 * allowlist bolted on, which is how it stops guarding anything. The parser sees
 * only JSX, so the guard is exact and needs no exceptions to live with.
 *
 * `detectRawSelects` is exported to itself below: the cases prove it can still
 * SEE a raw select before the sweep is allowed to conclude that none exist.
 * A detector that finds nothing passes a repo-wide sweep perfectly.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** The one file allowed to write the primitive. */
const OWNER = 'src/ui/components/Picker.tsx';

const SRC = resolve(import.meta.dirname, '../..');
const ROOT = resolve(SRC, '..');

/** 1-based lines carrying a raw `<select` JSX tag. Comments and strings cannot match. */
function detectRawSelects(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === 'select'
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return lines;
}

const tsxFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
    .map((e) => join(e.parentPath, e.name));

const posix = (file: string): string => relative(ROOT, file).split('\\').join('/');

// ── The detector can see the thing it is sweeping for ───────────────────────

describe('detectRawSelects', () => {
  it('finds a raw select, wherever it is written', () => {
    expect(
      detectRawSelects(
        'x.tsx',
        `const Row = () => (
           <label>
             <select value={v} onChange={f}>
               <option value="a">A</option>
             </select>
           </label>
         );`,
      ),
    ).toEqual([3]);
  });

  it('finds one hidden inside another element, not just at the top level', () => {
    expect(detectRawSelects('x.tsx', `const R = () => <div><span><select /></span></div>;`)).toEqual([1]);
  });

  it('does not fire on prose ABOUT a select — which is why this is not a grep', () => {
    // Every one of these is real text in this repo. A regex guard flags all four,
    // earns an allowlist, and the allowlist is where the next surface hides.
    const text = `/**
       * a \`<select>\` whose \`value\` matches none of its options
       * What a \`<select>\` actually SHOWS the user
       */
      // the browser silently selects option[0]
      const HINT = 'do not write <select> here';
      const R = () => <Picker label="Model" value={v} onPick={f} />;`;
    expect(detectRawSelects('x.tsx', text)).toEqual([]);
  });
});

// ── The sweep ───────────────────────────────────────────────────────────────

describe('the raw <select> invariant, over the whole repo', () => {
  it(`is written in exactly one file, and that file is ${OWNER}`, () => {
    const offenders = tsxFiles()
      .map((file) => ({ file: posix(file), lines: detectRawSelects(file, readFileSync(file, 'utf8')) }))
      .filter((f) => f.lines.length > 0);

    /*
     * Both halves matter. Nothing but Picker.tsx may write one — that is the
     * invariant. And Picker.tsx MUST write one: without that, deleting the
     * component would leave this test green over a repo with no picker at all,
     * and the sweep would be asserting nothing.
     */
    expect(offenders.map((f) => f.file)).toEqual([OWNER]);
    expect(offenders[0]?.lines).toHaveLength(1);
  });

  it('sweeps a real, non-empty set of files', () => {
    // A broken walk returns [], and [] satisfies any "no offenders" check
    // vacuously. This is the assertion that the sweep looked at anything.
    const swept = tsxFiles().map(posix);
    expect(swept.length).toBeGreaterThan(5);
    expect(swept).toContain(OWNER);
    expect(swept).toContain('src/ui/components/Onboarding.tsx');
    expect(swept).toContain('src/ui/components/SettingsView.tsx');
    expect(swept).toContain('src/ui/components/Palette.tsx');
  });
});
