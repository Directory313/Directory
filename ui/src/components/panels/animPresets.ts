// Animation presets: write real keyframes / expressions / text animators onto layers.
import type { Draft } from 'immer';
import type { Keyframe, Layer, Prop, TextAnimator, Vec3 } from '../../types/project';
import { draftComp, newLocalId, useEditor } from '../../store/editor';
import { EASE_IN_HANDLE, EASE_OUT_HANDLE, EASINGS, applyEasing, propAt } from '../../lib/anim';

type L = Draft<Layer>;
const kf = <T,>(t: number, v: T, interp: Keyframe<T>['interp'] = 'bezier', outH = EASE_OUT_HANDLE, inH = EASE_IN_HANDLE): Keyframe<T> => ({ t, v, interp, outH, inH });
function put<T>(p: Prop<T>, keys: Keyframe<T>[]) {
  const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
  p.keys = [...(p.keys ?? []).filter((k) => k.t < t0 - 1e-4 || k.t > t1 + 1e-4), ...keys].sort((a, b) => a.t - b.t);
}
const D = 0.6;
/** Two keyframes with the named easing curve between them (no extra keys). */
function move<T>(p: Prop<T>, t0: number, v0: T, t1: number, v1: T, easing: string) {
  const a = kf(t0, v0), b = kf(t1, v1);
  const e = EASINGS.find((x) => x.id === easing);
  if (e) applyEasing(e, a as Keyframe<unknown>, b as Keyframe<unknown>);
  put(p, [a, b]);
}

export interface AnimPreset { id: string; name: string; group: string; apply: (l: L, t: number) => void; textOnly?: boolean }

function textAnimator(name: string, unit: TextAnimator['unit'], over: Partial<TextAnimator>): TextAnimator {
  return {
    id: newLocalId(), name, unit, start: { value: 0 }, end: { value: 100 }, offset: { value: 0 }, smoothness: 100,
    opacity: { value: 100 }, position: { value: [0, 0] }, scale: { value: 100 }, rotation: { value: 0 }, tracking: { value: 0 }, fill: null, ...over,
  };
}

export const ANIM_PRESETS: AnimPreset[] = [
  { id: 'fadeIn', name: 'Fade In', group: 'Basic', apply: (l, t) => put(l.transform.opacity, [kf(t, 0), kf(t + D, 100)]) },
  { id: 'fadeOut', name: 'Fade Out', group: 'Basic', apply: (l, t) => { const o = propAt(l.transform.opacity as Prop<number>, t); put(l.transform.opacity, [kf(t, o), kf(t + D, 0)]); } },
  { id: 'smooth', name: 'Smooth Move In', group: 'Basic', apply: (l, t) => { const p = propAt(l.transform.position as Prop<Vec3>, t); put(l.transform.position, [kf<Vec3>(t, [p[0] - 300, p[1], p[2]], 'bezier', { x: 0.2, y: 0 }, { x: 0.2, y: 1 }), kf<Vec3>(t + 0.8, p)]); } },
  { id: 'scalePop', name: 'Scale Pop', group: 'Basic', apply: (l, t) => { const s = propAt(l.transform.scale as Prop<Vec3>, t); move<Vec3>(l.transform.scale, t, [0, 0, s[2]], t + 0.45, s, 'backOut'); } },
  { id: 'rotate', name: 'Rotation (360°)', group: 'Basic', apply: (l, t) => { const r = propAt(l.transform.rotation as Prop<Vec3>, t); put(l.transform.rotation, [kf<Vec3>(t, r), kf<Vec3>(t + 1.2, [r[0], r[1], r[2] + 360])]); } },
  // Physics presets use two keyframes and a curve (bounce / elastic / overshoot) between them.
  // Adjust the feel afterwards in the Graph Editor or with the Easing list.
  { id: 'bounce', name: 'Bounce In', group: 'Physics', apply: (l, t) => { const p = propAt(l.transform.position as Prop<Vec3>, t); move<Vec3>(l.transform.position, t, [p[0], p[1] - 420, p[2]], t + 1.0, p, 'bounceOut'); } },
  { id: 'elastic', name: 'Elastic Scale', group: 'Physics', apply: (l, t) => { const s = propAt(l.transform.scale as Prop<Vec3>, t); move<Vec3>(l.transform.scale, t, [0, 0, s[2]], t + 0.9, s, 'elasticOut'); } },
  { id: 'overshoot', name: 'Overshoot Slide', group: 'Physics', apply: (l, t) => { const p = propAt(l.transform.position as Prop<Vec3>, t); move<Vec3>(l.transform.position, t, [p[0] + 500, p[1], p[2]], t + 0.7, p, 'backOut'); } },
  { id: 'spring', name: 'Spring Rotation', group: 'Physics', apply: (l, t) => { const r = propAt(l.transform.rotation as Prop<Vec3>, t); move<Vec3>(l.transform.rotation, t, [r[0], r[1], r[2] - 35], t + 0.9, r, 'elasticOut'); } },
  { id: 'shake', name: 'Shake', group: 'Procedural', apply: (l) => { l.transform.position.expr = 'wiggle(14, 18)'; } },
  { id: 'wiggle', name: 'Wiggle (gentle)', group: 'Procedural', apply: (l) => { l.transform.position.expr = 'wiggle(1.5, 25)'; } },
  { id: 'float', name: 'Floating', group: 'Procedural', apply: (l) => { l.transform.position.expr = 'value + [0, sin(time * 2) * 14, 0]'; l.transform.rotation.expr = 'value + [0, 0, sin(time * 1.3) * 2]'; } },
  { id: 'pulse', name: 'Pulse', group: 'Procedural', apply: (l) => { l.transform.scale.expr = 'value * (1 + sin(time * 6) * 0.04)'; } },
  { id: 'loop', name: 'Loop Keyframes', group: 'Procedural', apply: (l) => { for (const p of [l.transform.position, l.transform.scale, l.transform.rotation, l.transform.opacity]) if ((p.keys?.length ?? 0) > 1) p.expr = "loopOut('cycle')"; } },
  { id: 'reveal', name: 'Wipe Reveal', group: 'Reveal', apply: (l) => { l.transitionIn = { kind: 'wipeLeft', duration: 0.8, ease: true }; } },
  { id: 'blurIn', name: 'Blur In', group: 'Reveal', apply: (l) => { l.transitionIn = { kind: 'blur', duration: 0.6, ease: true }; } },
  { id: 'zoomIn', name: 'Zoom In', group: 'Reveal', apply: (l) => { l.transitionIn = { kind: 'zoomIn', duration: 0.5, ease: true }; } },
  { id: 'typewriter', name: 'Typewriter', group: 'Text', textOnly: true, apply: (l, t) => {
    if (l.kind.type !== 'text') return;
    const lt = t;
    l.kind.animators.push(textAnimator('Typewriter', 'characters', { opacity: { value: 0 }, smoothness: 0, start: { value: 0, keys: [kf(lt, 0, 'linear'), kf(lt + 1.5, 100, 'linear')] } }) as never);
  } },
  { id: 'staggerUp', name: 'Stagger Up (words)', group: 'Text', textOnly: true, apply: (l, t) => {
    if (l.kind.type !== 'text') return;
    l.kind.animators.push(textAnimator('Stagger Up', 'words', { opacity: { value: 0 }, position: { value: [0, 60] }, start: { value: 0, keys: [kf(t, 0), kf(t + 1.2, 100)] } }) as never);
  } },
  { id: 'charPop', name: 'Character Pop', group: 'Text', textOnly: true, apply: (l, t) => {
    if (l.kind.type !== 'text') return;
    l.kind.animators.push(textAnimator('Character Pop', 'characters', { scale: { value: 0 }, opacity: { value: 0 }, start: { value: 0, keys: [kf(t, 0), kf(t + 1, 100)] } }) as never);
  } },
  { id: 'trackingIn', name: 'Tracking In', group: 'Text', textOnly: true, apply: (l, t) => {
    if (l.kind.type !== 'text') return;
    put(l.kind.tracking as Prop<number>, [kf(t, 600), kf(t + 1.2, 0)]);
    put(l.transform.opacity, [kf(t, 0), kf(t + 0.5, 100)]);
  } },
];

export function applyAnimPreset(p: AnimPreset) {
  const s = useEditor.getState();
  if (!s.selectedLayers.length) { s.toast('info', 'Select a layer first'); return; }
  let skipped = 0;
  s.edit(`Preset: ${p.name}`, (d) => {
    for (const l of draftComp(d)?.layers ?? []) {
      if (!s.selectedLayers.includes(l.id)) continue;
      if (p.textOnly && l.kind.type !== 'text') { skipped++; continue; }
      p.apply(l, Math.max(0, s.time - l.start));
    }
  });
  if (skipped) s.toast('info', `${p.name} applies to text layers only`);
}

/** Capture the selected layer's transform animation as a reusable preset (times relative to first key). */
export function captureAnimation(l: Layer) {
  const tr = l.transform;
  const props = { position: tr.position, scale: tr.scale, rotation: tr.rotation, opacity: tr.opacity, anchor: tr.anchor } as Record<string, Prop<unknown>>;
  const t0 = Math.min(...Object.values(props).flatMap((p) => (p.keys ?? []).map((k) => k.t)), Infinity);
  const out: Record<string, { keys: Keyframe<unknown>[]; expr?: string | null; relative: boolean }> = {};
  for (const [k, p] of Object.entries(props)) {
    if (!p.keys?.length && !p.expr) continue;
    const base = p.keys?.[0]?.v;
    out[k] = { expr: p.expr, relative: k === 'position', keys: (p.keys ?? []).map((x) => ({ ...x, t: x.t - (Number.isFinite(t0) ? t0 : 0), v: k === 'position' && Array.isArray(base) ? (x.v as number[]).map((n, i) => n - (base as number[])[i]) : x.v })) };
  }
  return out;
}

export function applyCaptured(data: ReturnType<typeof captureAnimation>) {
  const s = useEditor.getState();
  s.edit('Apply Animation Preset', (d) => {
    for (const l of draftComp(d)?.layers ?? []) {
      if (!s.selectedLayers.includes(l.id)) continue;
      const t = s.time - l.start;
      for (const [k, v] of Object.entries(data)) {
        const p = (l.transform as unknown as Record<string, Prop<unknown>>)[k];
        if (!p) continue;
        const cur = propAt(p as Prop<unknown>, t);
        if (v.keys.length) put(p, v.keys.map((x) => ({ ...x, t: x.t + t, v: v.relative && Array.isArray(cur) ? (x.v as number[]).map((n, i) => n + (cur as number[])[i]) : x.v })) as Keyframe<unknown>[]);
        if (v.expr) p.expr = v.expr;
      }
    }
  });
}
