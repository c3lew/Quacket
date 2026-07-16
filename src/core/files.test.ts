import { describe, expect, it } from 'vitest';
import { joinPath } from './files.ts';

/**
 * `joinPath` replaces `node:path.join`, so the cases that matter are the ones a
 * real injected base dir actually produces: Windows backslashes from
 * `appDataDir()`, and a trailing separator from `tempDir()`.
 */
describe('joinPath', () => {
  it('joins with a single forward slash', () => {
    expect(joinPath('/home/u/.quacket', 'drafts', 'd1')).toBe('/home/u/.quacket/drafts/d1');
  });

  it('does not double the separator when the base dir carries one', () => {
    // tempDir() returns a trailing separator on Windows; appDataDir() does not.
    expect(joinPath('C:\\Temp\\', 'codex-1')).toBe('C:\\Temp/codex-1');
    expect(joinPath('/tmp/', '/codex-1')).toBe('/tmp/codex-1');
  });

  it('leaves a Windows base dir intact, since only the separator it appends is ours', () => {
    // Forward slashes are accepted by both Node and Rust on Windows, so a mixed
    // path is a real path — rewriting the base dir would be the riskier move.
    expect(joinPath('C:\\Users\\u\\AppData\\Roaming\\quacket', 'drafts')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\quacket/drafts',
    );
  });

  it('drops empty segments rather than emitting an empty path element', () => {
    expect(joinPath('/tmp', '', 'x')).toBe('/tmp/x');
    expect(joinPath('', '/tmp', 'x')).toBe('/tmp/x');
  });

  it('is stable under re-joining its own output, which every nested path relies on', () => {
    const dir = joinPath('/tmp/', 'drafts');
    expect(joinPath(dir, 'd1', 'draft.json')).toBe('/tmp/drafts/d1/draft.json');
  });

  it('preserves a root-relative base dir', () => {
    expect(joinPath('/', 'tmp')).toBe('/tmp');
  });
});
