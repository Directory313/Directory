import { describe, expect, it } from 'vitest';
import { cubicBezierEase, evalKeys, formatTime, parseTime, setKey } from './anim';
import type { Prop } from '../types/project';

// These mirror crates/veyra-core/src/anim.rs tests so UI display and engine render agree.
describe('keyframe evaluation (mirror of the Rust engine)', () => {
  it('linear', () => {
    const p: Prop<number> = { value: 0 };
    setKey(p, 0, 0);
    setKey(p, 2, 100);
    expect(evalKeys(p.keys, p.value, 1)).toBeCloseTo(50);
    expect(evalKeys(p.keys, p.value, -1)).toBe(0);
    expect(evalKeys(p.keys, p.value, 3)).toBe(100);
  });
  it('hold', () => {
    const p: Prop<number> = { value: 0, keys: [{ t: 0, v: 1, interp: 'hold' }, { t: 1, v: 9 }] };
    expect(evalKeys(p.keys, p.value, 0.99)).toBe(1);
    expect(evalKeys(p.keys, p.value, 1)).toBe(9);
  });
  it('bezier ease is symmetric', () => {
    expect(cubicBezierEase({ x: 0.42, y: 0 }, { x: 0.58, y: 1 }, 0.5)).toBeCloseTo(0.5, 3);
    expect(cubicBezierEase({ x: 0.42, y: 0 }, { x: 0.58, y: 1 }, 0.1)).toBeLessThan(0.1);
  });
  it('vectors and sorted insertion', () => {
    const p: Prop<number[]> = { value: [0, 0] };
    setKey(p, 2, [2, 2]);
    setKey(p, 0, [0, 0]);
    setKey(p, 1, [1, 1]);
    expect(p.keys!.map((k) => k.t)).toEqual([0, 1, 2]);
    expect(evalKeys(p.keys, p.value, 1.5)).toEqual([1.5, 1.5]);
  });
  it('timecode round trip', () => {
    expect(formatTime(3723.5, 30)).toBe('01:02:03:15');
    expect(parseTime('01:02:03:15', 30)).toBeCloseTo(3723.5);
    expect(parseTime('90', 30)).toBe(3);
    expect(parseTime('2.5s', 30)).toBe(2.5);
  });
});

describe('easing curves (no extra keyframes)', () => {
  it('elastic and bounce start at 0, end at 1, overshoot/bounce in between', async () => {
    const { elasticOut, bounceOut, EASINGS, sampleEasing } = await import('./anim');
    expect(elasticOut(0)).toBe(0); expect(elasticOut(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => elasticOut(i / 100)))).toBeGreaterThan(1.05);
    expect(bounceOut(0)).toBe(0); expect(bounceOut(1)).toBeCloseTo(1, 6);
    const back = sampleEasing(EASINGS.find((e) => e.id === 'backOut')!);
    expect(Math.max(...back)).toBeGreaterThan(1.05);
    expect(back[0]).toBeCloseTo(0, 6); expect(back[back.length - 1]).toBeCloseTo(1, 6);
  });
  it('applying an easing changes only the segment, never the key count', async () => {
    const { applyEasing, EASINGS, evalKeys } = await import('./anim');
    const keys = [{ t: 0, v: 0 }, { t: 1, v: 100 }] as { t: number; v: number; interp?: never }[];
    const before = evalKeys(keys, 0, 0.3);
    applyEasing(EASINGS.find((e) => e.id === 'bounceOut')!, keys[0] as never, keys[1] as never);
    expect(keys.length).toBe(2);
    expect(evalKeys(keys, 0, 0.3)).not.toBeCloseTo(before, 3);
    expect(evalKeys(keys, 0, 1)).toBe(100);
  });
});
