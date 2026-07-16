import { describe, expect, it } from 'vitest';

import {
  clampRect,
  effectiveView,
  isUsableCrop,
  keyIntent,
  normRect,
  roundRect,
  strokeWidth,
  toBasePoint,
  type Op,
} from './model.ts';

const pen = (...points: Array<[number, number]>): Op => ({
  kind: 'pen',
  points: points.map(([x, y]) => ({ x, y })),
  width: 3,
});
const crop = (x: number, y: number, w: number, h: number): Op => ({ kind: 'crop', rect: { x, y, w, h } });

describe('effectiveView', () => {
  it('shows the whole image when nothing has been cropped', () => {
    expect(effectiveView([], 1100, 700)).toEqual({ x: 0, y: 0, w: 1100, h: 700 });
  });

  it('is unaffected by marks', () => {
    const ops = [pen([10, 10], [20, 20]), { kind: 'circle', rect: { x: 0, y: 0, w: 50, h: 50 }, width: 3 } as Op];
    expect(effectiveView(ops, 1100, 700)).toEqual({ x: 0, y: 0, w: 1100, h: 700 });
  });

  it('shows the cropped slice after a crop', () => {
    expect(effectiveView([crop(100, 50, 400, 300)], 1100, 700)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });

  it('takes the newest crop when crops are stacked, because crop rects are absolute', () => {
    // Second crop is expressed in base coords already — no composition needed.
    const view = effectiveView([crop(100, 50, 400, 300), crop(150, 80, 100, 90)], 1100, 700);
    expect(view).toEqual({ x: 150, y: 80, w: 100, h: 90 });
  });

  it('reverts to the previous crop when the last op is undone', () => {
    const ops = [crop(100, 50, 400, 300), crop(150, 80, 100, 90)];
    expect(effectiveView(ops.slice(0, -1), 1100, 700)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });

  it('reverts to the whole image when the only crop is undone', () => {
    const ops = [pen([1, 1]), crop(150, 80, 100, 90)];
    expect(effectiveView(ops.slice(0, -1), 1100, 700)).toEqual({ x: 0, y: 0, w: 1100, h: 700 });
  });

  it('keeps the crop when a mark made after it is undone', () => {
    const ops = [crop(100, 50, 400, 300), pen([120, 60])];
    expect(effectiveView(ops.slice(0, -1), 1100, 700)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });
});

describe('toBasePoint', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('maps 1:1 when the canvas is unscaled at the origin', () => {
    expect(toBasePoint({ x: 30, y: 40 }, box(0, 0, 100, 100), { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      x: 30,
      y: 40,
    });
  });

  it('subtracts the canvas offset on screen', () => {
    expect(toBasePoint({ x: 230, y: 140 }, box(200, 100, 100, 100), { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      x: 30,
      y: 40,
    });
  });

  it('undoes the fit-to-panel scale — a 1100px image shown at 550px', () => {
    // Click dead centre of the scaled canvas -> centre of the image.
    expect(toBasePoint({ x: 275, y: 175 }, box(0, 0, 550, 350), { x: 0, y: 0, w: 1100, h: 700 })).toEqual({
      x: 550,
      y: 350,
    });
  });

  it('adds the view origin so clicks land correctly after a crop', () => {
    // Canvas shows base rect (100,50)-(500,350) at 1:1; top-left click is base (100,50).
    expect(toBasePoint({ x: 0, y: 0 }, box(0, 0, 400, 300), { x: 100, y: 50, w: 400, h: 300 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it('undoes scale and crop offset together', () => {
    // Cropped 400x300 slice at origin (100,50), displayed at half size (200x150),
    // canvas itself offset (20,10) on screen. Click its centre.
    expect(toBasePoint({ x: 120, y: 85 }, box(20, 10, 200, 150), { x: 100, y: 50, w: 400, h: 300 })).toEqual({
      x: 300,
      y: 200,
    });
  });
});

describe('normRect', () => {
  it('normalises a top-left to bottom-right drag', () => {
    expect(normRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('normalises a bottom-right to top-left drag to the same rect', () => {
    expect(normRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('normalises a drag that crosses only one axis', () => {
    expect(normRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});

describe('clampRect', () => {
  const full = { x: 0, y: 0, w: 100, h: 100 };

  it('leaves a rect already inside the image alone', () => {
    expect(clampRect({ x: 10, y: 10, w: 50, h: 50 }, full)).toEqual({ x: 10, y: 10, w: 50, h: 50 });
  });

  it('trims an overshoot past the bottom-right — pointer capture reports coords off-canvas', () => {
    expect(clampRect({ x: 60, y: 60, w: 90, h: 90 }, full)).toEqual({ x: 60, y: 60, w: 40, h: 40 });
  });

  it('trims an overshoot past the top-left', () => {
    expect(clampRect({ x: -30, y: -20, w: 60, h: 60 }, full)).toEqual({ x: 0, y: 0, w: 30, h: 40 });
  });

  it('collapses a rect entirely outside the image', () => {
    const r = clampRect({ x: 200, y: 200, w: 50, h: 50 }, full);
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
    expect(isUsableCrop(r)).toBe(false);
  });

  it('clamps to the cropped view, not to the base image origin', () => {
    // Already cropped to (100,50,400,300); a second crop cannot escape it.
    const view = { x: 100, y: 50, w: 400, h: 300 };
    expect(clampRect({ x: 50, y: 20, w: 600, h: 500 }, view)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });
});

describe('roundRect', () => {
  it('snaps a float rect to whole pixels by rounding each edge', () => {
    // Right edge 10.4+30.4 = 40.8 -> 41, so the width is 41-10 = 31, NOT round(30.4).
    expect(roundRect({ x: 10.4, y: 20.6, w: 30.4, h: 40.4 })).toEqual({ x: 10, y: 21, w: 31, h: 40 });
  });

  it('rounds edges, so a rect flush against the bound cannot grow past it', () => {
    // x=99.6 w=0.6 -> naive round(x)+round(w) = 100+1 = 101, one past a 100px view.
    const r = roundRect({ x: 99.6, y: 0, w: 0.6, h: 10 });
    expect(r.x + r.w).toBe(100);
  });

  it('leaves an already-integral rect untouched', () => {
    expect(roundRect({ x: 10, y: 20, w: 30, h: 40 })).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});

describe('isUsableCrop', () => {
  it('rejects a stray click', () => {
    expect(isUsableCrop({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
  });

  it('rejects a drag at the threshold', () => {
    expect(isUsableCrop({ x: 0, y: 0, w: 8, h: 8 })).toBe(false);
  });

  it('rejects a rect that is wide but not tall', () => {
    expect(isUsableCrop({ x: 0, y: 0, w: 400, h: 3 })).toBe(false);
  });

  it('accepts a deliberate drag', () => {
    expect(isUsableCrop({ x: 0, y: 0, w: 9, h: 9 })).toBe(true);
  });
});

describe('strokeWidth', () => {
  it('never goes below a legible floor on a small image', () => {
    expect(strokeWidth(320)).toBe(3);
  });

  it('scales with the image so a 4K screenshot does not get hairlines', () => {
    expect(strokeWidth(3840)).toBe(16);
  });

  it('grows when a crop shrinks the view', () => {
    // Same on-screen size, fewer base pixels -> a thinner stroke still reads the same.
    expect(strokeWidth(1920)).toBe(8);
    expect(strokeWidth(960)).toBe(4);
  });
});

describe('keyIntent', () => {
  const k = (key: string, mods: Partial<Omit<Parameters<typeof keyIntent>[0], 'key'>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it('selects tools with P / O / C', () => {
    expect(keyIntent(k('p'), false)).toEqual({ kind: 'tool', tool: 'pen' });
    expect(keyIntent(k('o'), false)).toEqual({ kind: 'tool', tool: 'circle' });
    expect(keyIntent(k('c'), false)).toEqual({ kind: 'tool', tool: 'crop' });
  });

  it('accepts shifted tool keys — Shift+P is still P', () => {
    expect(keyIntent(k('P'), false)).toEqual({ kind: 'tool', tool: 'pen' });
  });

  it('ignores a tool letter held with a modifier, so Ctrl+P still reaches the app', () => {
    expect(keyIntent(k('p', { ctrlKey: true }), false)).toBeNull();
    expect(keyIntent(k('p', { altKey: true }), false)).toBeNull();
    expect(keyIntent(k('c', { metaKey: true }), false)).toBeNull();
  });

  it('undoes on Ctrl+Z and Cmd+Z', () => {
    expect(keyIntent(k('z', { ctrlKey: true }), false)).toEqual({ kind: 'undo' });
    expect(keyIntent(k('z', { metaKey: true }), false)).toEqual({ kind: 'undo' });
  });

  it('does not undo on a bare Z', () => {
    expect(keyIntent(k('z'), false)).toBeNull();
  });

  it('Enter finishes the edit when no crop is pending', () => {
    expect(keyIntent(k('Enter'), false)).toEqual({ kind: 'done' });
  });

  it('Enter applies the crop instead when a crop box is on screen', () => {
    expect(keyIntent(k('Enter'), true)).toEqual({ kind: 'apply-crop' });
  });

  it('Esc cancels the whole edit when no crop is pending', () => {
    expect(keyIntent(k('Escape'), false)).toEqual({ kind: 'cancel' });
  });

  it('Esc discards only the crop box when one is on screen', () => {
    expect(keyIntent(k('Escape'), true)).toEqual({ kind: 'cancel-crop' });
  });

  it('leaves Del to the parent — removing the image is not the editor\'s call', () => {
    expect(keyIntent(k('Delete'), false)).toBeNull();
    expect(keyIntent(k('Backspace'), false)).toBeNull();
  });

  it('ignores keys it does not own so they bubble to the app', () => {
    expect(keyIntent(k('a'), false)).toBeNull();
    expect(keyIntent(k('Tab'), false)).toBeNull();
    expect(keyIntent(k('ArrowLeft'), false)).toBeNull();
  });
});
