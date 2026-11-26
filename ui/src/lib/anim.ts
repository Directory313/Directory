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
  let p = x;
  if (a.interp === 'hold') p = 0;
  else if (a.interp === 'bezier') p = cubicBezierEase(a.outH ?? HANDLE_OUT_LINEAR, b.inH ?? HANDLE_IN_LINEAR, x);
  return lerpValue(a.v, b.v, p);
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
