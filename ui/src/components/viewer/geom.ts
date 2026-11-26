// 2D affine math for the viewer overlay. Mirrors crates/veyra-core/src/eval.rs for 2D layers
// (3D layers are approximated by their Z rotation for on-canvas handles).
import type { BezPath, Composition, Layer, Project } from '../../types/project';
import { propAt } from '../../lib/anim';

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f */
export type M = [number, number, number, number, number, number];
export type P = [number, number];

export const I: M = [1, 0, 0, 1, 0, 0];
export const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m: M, p: P): P => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const applyLinear = (m: M, p: P): P => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];
export const inv = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
export const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
export const rotate = (deg: number): M => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
export const scale = (x: number, y: number): M => [x, 0, 0, y, 0, 0];

export function layerSize(p: Project, comp: Composition, l: Layer): P {
  switch (l.kind.type) {
    case 'media': {
      const a = p.assets.find((x) => x.id === (l.kind as { asset: string }).asset);
      return [Math.max(1, a?.info.width ?? comp.width), Math.max(1, a?.info.height ?? comp.height)];
    }
    case 'solid': return [l.kind.width, l.kind.height];
    case 'comp': {
      const c = p.compositions.find((x) => x.id === (l.kind as { comp: string }).comp);
      return c ? [c.width, c.height] : [comp.width, comp.height];
    }
    case 'null': return [100, 100];
    default: return [comp.width, comp.height];
  }
}

export function localMatrix(l: Layer, compTime: number): M {
  const lt = compTime - l.start;
  const a = propAt(l.transform.anchor, lt);
  const pos = propAt(l.transform.position, lt);
  const s = propAt(l.transform.scale, lt);
  const r = propAt(l.transform.rotation, lt);
  return mul(mul(mul(translate(pos[0], pos[1]), rotate(r[2])), scale(s[0] / 100, s[1] / 100)), translate(-a[0], -a[1]));
}

export function parentMatrix(comp: Composition, l: Layer, t: number): M {
  let m: M = I;
  let cur = l;
  for (let guard = 0; cur.parent && guard < 64; guard++) {
    const p = comp.layers.find((x) => x.id === cur.parent);
    if (!p) break;
    m = mul(localMatrix(p, t), m);
    cur = p;
  }
  return m;
}

export function worldMatrix(comp: Composition, l: Layer, t: number): M {
  return mul(parentMatrix(comp, l, t), localMatrix(l, t));
}

/** Content bounds of a layer in layer space ([x0, y0, x1, y1]). Text/shape layers report their drawn content. */
export function contentBounds(p: Project, comp: Composition, l: Layer, t: number): [number, number, number, number] {
  const [w, h] = layerSize(p, comp, l);
  const lt = t - l.start;
  const k = l.kind;
  if (k.type === 'shape') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of k.items) {
      const off = propAt(it.offset, lt);
      const g = it.geometry;
      let hw = 50, hh = 50;
      if (g.type === 'rect' || g.type === 'ellipse') { const sz = propAt(g.size, lt); hw = sz[0] / 2; hh = sz[1] / 2; }
      else if (g.type === 'polygon') { hw = hh = propAt(g.outerRadius, lt); }
      else if (g.type === 'line' || g.type === 'arrow') { const to = propAt(g.to, lt); x0 = Math.min(x0, w / 2 + off[0], w / 2 + off[0] + to[0]); x1 = Math.max(x1, w / 2 + off[0], w / 2 + off[0] + to[0]); y0 = Math.min(y0, h / 2 + off[1] - 4, h / 2 + off[1] + to[1]); y1 = Math.max(y1, h / 2 + off[1] + 4, h / 2 + off[1] + to[1]); continue; }
      else if (g.type === 'path') {
        const path = propAt(g.path, lt);
        for (const v of path.vertices) { x0 = Math.min(x0, w / 2 + off[0] + v.p[0]); x1 = Math.max(x1, w / 2 + off[0] + v.p[0]); y0 = Math.min(y0, h / 2 + off[1] + v.p[1]); y1 = Math.max(y1, h / 2 + off[1] + v.p[1]); }
        continue;
      }
      x0 = Math.min(x0, w / 2 + off[0] - hw); x1 = Math.max(x1, w / 2 + off[0] + hw);
      y0 = Math.min(y0, h / 2 + off[1] - hh); y1 = Math.max(y1, h / 2 + off[1] + hh);
    }
    if (!Number.isFinite(x0)) return [0, 0, w, h];
    return [x0, y0, x1, y1];
  }
  if (k.type === 'text') {
    const text = propAt(k.text, lt);
    const size = propAt(k.fontSize, lt);
    const lines = text.split('\n');
    const longest = Math.max(1, ...lines.map((x) => x.length));
    const bw = k.boxWidth > 0 ? k.boxWidth : longest * size * 0.56;
    const bh = lines.length * size * propAt(k.lineHeight, lt);
    const x0 = k.align === 'left' ? w / 2 : k.align === 'right' ? w / 2 - bw : w / 2 - bw / 2;
    const y0 = k.valign === 'top' ? h / 2 : k.valign === 'bottom' ? h / 2 - bh : h / 2 - bh / 2;
    return [x0, y0, x0 + bw, y0 + bh];
  }
  if (k.type === 'null') return [0, 0, 100, 100];
  return [0, 0, w, h];
}

export function isPickable(l: Layer) {
  return l.visible && !l.locked && !['camera', 'light', 'audio', 'adjustment'].includes(l.kind.type);
}

/** Topmost layer whose content contains comp point `pt`. */
export function pick(p: Project, comp: Composition, pt: P, t: number): Layer | undefined {
  for (const l of comp.layers) {
    if (!isPickable(l) || t < l.start || t >= l.start + l.duration) continue;
    const m = inv(worldMatrix(comp, l, t));
    const q = apply(m, pt);
    const [x0, y0, x1, y1] = contentBounds(p, comp, l, t);
    const pad = l.kind.type === 'null' ? 0 : 2;
    if (q[0] >= x0 - pad && q[0] <= x1 + pad && q[1] >= y0 - pad && q[1] <= y1 + pad) return l;
  }
  return undefined;
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): BezPath {
  const v = (x: number, y: number) => ({ p: [x, y] as P, i: [0, 0] as P, o: [0, 0] as P });
  return { vertices: [v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)], closed: true };
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): BezPath {
  const K = 0.5522847498;
  return {
    closed: true,
    vertices: [
      { p: [cx, cy - ry], i: [-rx * K, 0], o: [rx * K, 0] },
      { p: [cx + rx, cy], i: [0, -ry * K], o: [0, ry * K] },
      { p: [cx, cy + ry], i: [rx * K, 0], o: [-rx * K, 0] },
      { p: [cx - rx, cy], i: [0, ry * K], o: [0, -ry * K] },
    ],
  };
}

/** SVG path data for a bezier path transformed by `m`. */
export function pathD(path: BezPath, m: M): string {
  const v = path.vertices;
  if (v.length === 0) return '';
  const pt = (x: P) => apply(m, x);
  const f = (x: P) => `${x[0].toFixed(2)} ${x[1].toFixed(2)}`;
  let d = `M ${f(pt(v[0].p as P))}`;
  const n = v.length;
  const segs = path.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = v[i], b = v[(i + 1) % n];
    const c1 = pt([a.p[0] + a.o[0], a.p[1] + a.o[1]]);
    const c2 = pt([b.p[0] + b.i[0], b.p[1] + b.i[1]]);
    d += ` C ${f(c1)} ${f(c2)} ${f(pt(b.p as P))}`;
  }
  if (path.closed) d += ' Z';
  return d;
}
