import { describe, expect, it } from 'vitest';
import { animatedProps, maxDuration, niceStep, shiftKeysDeep, snapTo } from './model';
import type { Layer } from '../../types/project';

const prop = (v: unknown, keys: { t: number; v: unknown }[] = []) => ({ value: v, keys });

function layer(): Layer {
  return {
    id: 'L1', name: 'L', kind: { type: 'null' }, start: 1, duration: 5, sourceIn: 0, speed: 1, reverse: false, visible: true, locked: false,
    solo: false, muted: false, shy: false, is3d: false, blend: 'normal', motionBlur: false, markers: [],
    transform: { anchor: prop([0, 0, 0]), position: prop([0, 0, 0], [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [10, 0, 0] }]), scale: prop([100, 100, 100]), rotation: prop([0, 0, 0]), opacity: prop(100) },
    effects: [{ id: 'e1', kind: 'gaussianBlur', enabled: true, params: { radius: prop(5, [{ t: 0.5, v: 5 }]) } }],
    masks: [], audio: { volume: prop(0), pan: prop(0), fadeIn: 0, fadeOut: 0, effects: [] },
    material: {} as Layer['material'],
  } as unknown as Layer;
}

describe('timeline model', () => {
  it('finds animated properties including effect params', () => {
    const ps = animatedProps(layer(), [{ kind: 'gaussianBlur', name: 'Gaussian Blur', category: '', description: '', shader: 2, audio: false, params: [{ key: 'radius', label: 'Blurriness', kind: { type: 'float', min: 0, max: 1, step: 1 }, default: 0 }] }]);
    expect(ps.map((p) => p.path)).toEqual(['transform.position', 'effects.e1.params.radius']);
    expect(ps[1].label).toContain('Blurriness');
  });
  it('shifts keys deeply', () => {
    const l = layer();
    shiftKeysDeep(l, -0.5);
    expect(l.transform.position.keys![1].t).toBe(0.5);
    expect(l.effects[0].params.radius.keys![0].t).toBe(0);
  });
  it('snaps within pixel tolerance', () => {
    expect(snapTo(1.02, [0, 1, 2], 100)).toBe(1);
    expect(snapTo(1.2, [0, 1, 2], 100)).toBeNull();
  });
  it('limits media duration by source', () => {
    expect(maxDuration(layer(), 10, 2)).toBe(8);
    expect(maxDuration(layer(), null, 0)).toBeNull();
  });
  it('picks readable ruler steps', () => {
    const s = niceStep(100, 30);
    expect(s.major * 100).toBeGreaterThanOrEqual(90);
    expect(s.minor).toBeLessThanOrEqual(s.major);
  });
});
