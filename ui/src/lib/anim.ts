// Keyframe evaluation mirror of crates/veyra-core/src/anim.rs (display only; the backend renders).
import type { Handle, Keyframe, Prop, ParamValue } from '../types/project';

export const HANDLE_OUT_LINEAR: Handle = { x: 1 / 3, y: 1 / 3 };
export const HANDLE_IN_LINEAR: Handle = { x: 2 / 3, y: 2 / 3 };
export const EASE_OUT_HANDLE: Handle = { x: 0.33, y: 0 };
export const EASE_IN_HANDLE: Handle = { x: 0.67, y: 1 };

export function cubicBezierEase(p1: Handle, p2: Handle, x: number): number {
  x = Math.min(1, Math.max(0, x));
  const x1 = Math.min(1, Math.max(0, p1.x)), x2 = Math.min(1, Math.max(0, p2.x));
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * p1.y + 3 * (1 - s) * s * s * p2.y + s * s * s;
  let lo = 0, hi = 1, s = x;
  for (let i = 0; i < 40; i++) {
    const v = bx(s);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return by(s);
}

export function lerpValue<T>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * t) as T;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && typeof a[0] === 'number') {
    return (a as number[]).map((x, i) => x + ((b as number[])[i] - x) * t) as T;
  }
  if (a && b && typeof a === 'object' && 'vertices' in (a as object)) {
    const pa = a as unknown as { vertices: { p: number[]; i: number[]; o: number[] }[]; closed: boolean };
    const pb = b as unknown as typeof pa;
    if (!pa.vertices.length || !pb.vertices.length) return t < 1 ? a : b;
    const n = Math.max(pa.vertices.length, pb.vertices.length);
    const get = (p: typeof pa, i: number) => p.vertices[Math.min(i, p.vertices.length - 1)];
    const L = (x: number[], y: number[]) => x.map((v, k) => v + (y[k] - v) * t);
    return { closed: t < 0.5 ? pa.closed : pb.closed, vertices: Array.from({ length: n }, (_, i) => { const va = get(pa, i), vb = get(pb, i); return { p: L(va.p, vb.p), i: L(va.i, vb.i), o: L(va.o, vb.o) }; }) } as unknown as T;
  }
  return t < 1 ? a : b;
}

export function evalKeys<T>(keys: Keyframe<T>[] | undefined, fallback: T, t: number): T {
  if (!keys || keys.length === 0) return fallback;
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const x = (t - a.t) / Math.max(b.t - a.t, 1e-12);
  return lerpValue(a.v, b.v, segmentProgress(a, b, x));
}

/** Elastic ease-out (mirrors anim.rs). `amount` scales the overshoot. */
export function elasticOut(x: number, amount = 1): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return 1 + Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) * Math.min(4, Math.max(0, amount));
}

/** Bounce ease-out (mirrors anim.rs). `amount` scales the rebounds. */
export function bounceOut(x: number, amount = 1): number {
  x = Math.min(1, Math.max(0, x));
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  let y: number;
  if (x < 2 / d1) { const u = x - 1.5 / d1; y = n1 * u * u + 0.75; }
  else if (x < 2.5 / d1) { const u = x - 2.25 / d1; y = n1 * u * u + 0.9375; }
  else { const u = x - 2.625 / d1; y = n1 * u * u + 0.984375; }
  return 1 - (1 - y) * Math.min(4, Math.max(0, amount));
}

/** Progress (0..1, may overshoot) of the segment leaving key `a`. */
export function segmentProgress(a: Keyframe<unknown>, b: Keyframe<unknown>, x: number): number {
  const amt = a.amount ?? 1;
  switch (a.interp) {
    case 'hold': return 0;
    case 'bezier': return cubicBezierEase(a.outH ?? HANDLE_OUT_LINEAR, b.inH ?? HANDLE_IN_LINEAR, x);
    case 'elasticOut': return elasticOut(x, amt);
    case 'elasticIn': return 1 - elasticOut(1 - x, amt);
    case 'bounceOut': return bounceOut(x, amt);
    case 'bounceIn': return 1 - bounceOut(1 - x, amt);
    default: return x;
  }
}

// ---------------------------------------------------------------- easing library
// Every easing changes only the interpolation of the segment between two existing keys;
// none of them add keyframes. Bezier easings set the graph handles (editable afterwards in
// the Graph Editor; Back easings use handles outside 0..1 to overshoot). Elastic and bounce
// are dedicated curve types with an adjustable `amount`.

export interface Easing { id: string; name: string; group: string; out?: Handle; in?: Handle; interp?: Keyframe<unknown>['interp'] }
const bz = (id: string, name: string, group: string, x1: number, y1: number, x2: number, y2: number): Easing => ({ id, name, group, out: { x: x1, y: y1 }, in: { x: x2, y: y2 }, interp: 'bezier' });

export const EASINGS: Easing[] = [
  { id: 'linear', name: 'Linear', group: 'Basic', interp: 'linear' },
  bz('easy', 'Easy Ease', 'Basic', 0.33, 0, 0.67, 1),
  bz('easeIn', 'Ease In', 'Basic', 0.42, 0, 1, 1),
  bz('easeOut', 'Ease Out', 'Basic', 0, 0, 0.58, 1),
  { id: 'hold', name: 'Hold', group: 'Basic', interp: 'hold' },
  bz('sineIn', 'Sine In', 'Sine', 0.12, 0, 0.39, 0), bz('sineOut', 'Sine Out', 'Sine', 0.61, 1, 0.88, 1), bz('sineInOut', 'Sine In-Out', 'Sine', 0.37, 0, 0.63, 1),
  bz('quadIn', 'Quad In', 'Quad', 0.11, 0, 0.5, 0), bz('quadOut', 'Quad Out', 'Quad', 0.5, 1, 0.89, 1), bz('quadInOut', 'Quad In-Out', 'Quad', 0.45, 0, 0.55, 1),
  bz('cubicIn', 'Cubic In', 'Cubic', 0.32, 0, 0.67, 0), bz('cubicOut', 'Cubic Out', 'Cubic', 0.33, 1, 0.68, 1), bz('cubicInOut', 'Cubic In-Out', 'Cubic', 0.65, 0, 0.35, 1),
  bz('quartIn', 'Quart In', 'Quart', 0.5, 0, 0.75, 0), bz('quartOut', 'Quart Out', 'Quart', 0.25, 1, 0.5, 1), bz('quartInOut', 'Quart In-Out', 'Quart', 0.76, 0, 0.24, 1),
  bz('quintIn', 'Quint In', 'Quint', 0.64, 0, 0.78, 0), bz('quintOut', 'Quint Out', 'Quint', 0.22, 1, 0.36, 1), bz('quintInOut', 'Quint In-Out', 'Quint', 0.83, 0, 0.17, 1),
  bz('expoIn', 'Expo In', 'Expo', 0.7, 0, 0.84, 0), bz('expoOut', 'Expo Out', 'Expo', 0.16, 1, 0.3, 1), bz('expoInOut', 'Expo In-Out', 'Expo', 0.87, 0, 0.13, 1),
  bz('circIn', 'Circ In', 'Circ', 0.55, 0, 1, 0.45), bz('circOut', 'Circ Out', 'Circ', 0, 0.55, 0.45, 1), bz('circInOut', 'Circ In-Out', 'Circ', 0.85, 0, 0.15, 1),
  bz('backIn', 'Back In (anticipate)', 'Back / Overshoot', 0.36, 0, 0.66, -0.56), bz('backOut', 'Back Out (overshoot)', 'Back / Overshoot', 0.34, 1.56, 0.64, 1), bz('backInOut', 'Back In-Out', 'Back / Overshoot', 0.68, -0.6, 0.32, 1.6),
  { id: 'elasticOut', name: 'Elastic Out', group: 'Elastic / Bounce', interp: 'elasticOut' },
  { id: 'elasticIn', name: 'Elastic In', group: 'Elastic / Bounce', interp: 'elasticIn' },
  { id: 'bounceOut', name: 'Bounce Out', group: 'Elastic / Bounce', interp: 'bounceOut' },
  { id: 'bounceIn', name: 'Bounce In', group: 'Elastic / Bounce', interp: 'bounceIn' },
];

/** Apply an easing to the segment leaving key `a` (towards `b`). Mutates; use inside immer. */
export function applyEasing(e: Easing, a: Keyframe<unknown>, b: Keyframe<unknown> | undefined) {
  a.interp = e.interp ?? 'linear';
  if (e.out && e.in) {
    a.outH = { ...e.out };
    if (b) b.inH = { ...e.in };
  } else if (e.interp === 'linear') {
    a.outH = { ...HANDLE_OUT_LINEAR };
    if (b) b.inH = { ...HANDLE_IN_LINEAR };
  }
}

/** Sample an easing curve (for previews / thumbnails). */
export function sampleEasing(e: Easing, n = 48): number[] {
  const a: Keyframe<number> = { t: 0, v: 0 }, b: Keyframe<number> = { t: 1, v: 1 };
  applyEasing(e, a as Keyframe<unknown>, b as Keyframe<unknown>);
  return Array.from({ length: n + 1 }, (_, i) => segmentProgress(a as Keyframe<unknown>, b as Keyframe<unknown>, i / n));
}

/** Value of a property at layer-local time `t` (keyframes only; expressions are evaluated by the backend). */
export function propAt<T>(p: Prop<T>, t: number): T {
  return evalKeys(p.keys, p.value, t);
}

export function isAnimated(p: Prop<unknown> | undefined | null): boolean {
  return !!p && ((p.keys?.length ?? 0) > 0 || !!p.expr);
}

/** Insert or replace a keyframe (mutates; use inside immer). */
export function setKey<T>(p: Prop<T>, t: number, v: T, interp: 'linear' | 'bezier' | 'hold' = 'linear') {
  p.keys = p.keys ?? [];
  const i = p.keys.findIndex((k) => Math.abs(k.t - t) < 1e-4);
  if (i >= 0) { p.keys[i].v = v; return; }
  const k: Keyframe<T> = { t, v, interp, outH: interp === 'bezier' ? EASE_OUT_HANDLE : HANDLE_OUT_LINEAR, inH: interp === 'bezier' ? EASE_IN_HANDLE : HANDLE_IN_LINEAR };
  const pos = p.keys.findIndex((x) => x.t > t);
  if (pos < 0) p.keys.push(k); else p.keys.splice(pos, 0, k);
}

/** Write a value: updates the keyframe at `t` if animated, otherwise the static value. */
export function writeProp<T>(p: Prop<T>, t: number, v: T, autoKey = false) {
  if ((p.keys?.length ?? 0) > 0 || autoKey) setKey(p, t, v);
  else p.value = v;
}

export function sortKeys<T>(p: Prop<T>) {
  p.keys?.sort((a, b) => a.t - b.t);
}

export function paramNum(v: ParamValue | undefined, d = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v[0] ?? d;
  return d;
}

export function formatTime(t: number, fps: number, mode: 'timecode' | 'frames' | 'seconds' = 'timecode'): string {
  if (mode === 'frames') return String(Math.round(t * fps));
  if (mode === 'seconds') return t.toFixed(2) + 's';
  const f = Math.round(t * fps);
  const r = Math.round(fps);
  const fr = f % r, s = Math.floor(f / r) % 60, m = Math.floor(f / r / 60) % 60, h = Math.floor(f / r / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(fr)}`;
}

export function parseTime(s: string, fps: number): number | null {
  s = s.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) / fps;
  if (/^[\d.]+s$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;]/).map(Number);
  if (parts.some(isNaN)) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, f] = parts;
  return h * 3600 + m * 60 + sec + f / fps;
}

export function snapFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}
