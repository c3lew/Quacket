/**
 * Geometry guard for the gear glyph (#22): the hub circle and the tooth ring
 * are separate subpaths of one `d` string, and nothing but this test stops
 * them from drifting apart — the ring once sat a full unit right of the hub.
 */

import { describe, expect, it } from 'vitest';

import { PATHS } from './icons.tsx';

/**
 * Anchor points of each subpath, in order. Anchors only — arc/bezier bulges
 * are ignored, which is exact enough here because every extreme of the gear
 * (tooth tips, hub cardinal points) is an explicit anchor.
 */
function subpathAnchors(d: string): Array<Array<[number, number]>> {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)/g) ?? [];
  const subpaths: Array<Array<[number, number]>> = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = '';
  let i = 0;

  const next = (): number => Number(tokens[i++]);
  const push = (): void => void subpaths[subpaths.length - 1]!.push([x, y]);

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase();

    switch (command.toLowerCase()) {
      case 'm': {
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        startX = x;
        startY = y;
        subpaths.push([]);
        push();
        command = relative ? 'l' : 'L';
        break;
      }
      case 'l': {
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        push();
        break;
      }
      case 'h': {
        const dx = next();
        x = relative ? x + dx : dx;
        push();
        break;
      }
      case 'v': {
        const dy = next();
        y = relative ? y + dy : dy;
        push();
        break;
      }
      case 'c': {
        i += 4; // control points don't anchor
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        push();
        break;
      }
      case 'a': {
        i += 5; // rx ry rotation large-arc sweep
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        push();
        break;
      }
      case 'z': {
        x = startX;
        y = startY;
        break;
      }
      default:
        throw new Error(`unhandled path command "${command}" in ${d}`);
    }
  }
  return subpaths;
}

const bboxCenter = (points: Array<[number, number]>): [number, number] => {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

describe('gear glyph', () => {
  it('hub circle and tooth ring share the grid centre (8, 8)', () => {
    const [hub, ring, ...rest] = subpathAnchors(PATHS.gear);
    expect(rest).toEqual([]);

    const [hubX, hubY] = bboxCenter(hub!);
    const [ringX, ringY] = bboxCenter(ring!);

    expect(hubX).toBeCloseTo(8, 1);
    expect(hubY).toBeCloseTo(8, 1);
    expect(ringX).toBeCloseTo(8, 1);
    expect(ringY).toBeCloseTo(8, 1);
  });
});
