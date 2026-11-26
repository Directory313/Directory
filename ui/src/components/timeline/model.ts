// Pure helpers for the timeline: property discovery, labels, snapping, key shifting.
import type { Composition, EffectDef, Keyframe, Layer, Prop } from '../../types/project';

export interface AnimProp {
  path: string;
  label: string;
  prop: Prop<unknown>;
}

const NICE: Record<string, string> = {
  anchor: 'Anchor Point', position: 'Position', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity',
  volume: 'Volume', pan: 'Pan', feather: 'Feather', expansion: 'Expansion', path: 'Path', fontSize: 'Font Size',
  tracking: 'Tracking', lineHeight: 'Line Height', fill: 'Fill', strokeWidth: 'Stroke Width', stroke: 'Stroke',
  baseColor: 'Base Color', metallic: 'Metallic', roughness: 'Roughness', zoom: 'Zoom', intensity: 'Intensity',
  timeRemap: 'Time Remap', text: 'Source Text', pointOfInterest: 'Point of Interest',
};

function titleCase(k: string) {
  return NICE[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function isProp(o: unknown): o is Prop<unknown> {
  return !!o && typeof o === 'object' && !Array.isArray(o) && 'value' in (o as object);
}

/** Walk a layer and collect every animated property (keys or expression). */
export function animatedProps(layer: Layer, defs: EffectDef[], includeStatic = false): AnimProp[] {
  const out: AnimProp[] = [];
  const walk = (o: unknown, path: string[], labels: string[]) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach((x, i) => {
        const id = x && typeof x === 'object' && 'id' in x ? String((x as { id: string }).id) : String(i);
        let lab = `#${i + 1}`;
        if (x && typeof x === 'object') {
          const xo = x as { name?: string | null; kind?: string };
          if (xo.name) lab = xo.name;
          else if (xo.kind) lab = defs.find((d) => d.kind === xo.kind)?.name ?? xo.kind;
        }
        walk(x, [...path, id], [...labels, lab]);
      });
      return;
    }
    if (isProp(o) && path.length) {
      const p = o as Prop<unknown>;
      const animated = (p.keys?.length ?? 0) > 0 || !!p.expr;
      if (animated || includeStatic) {
        const key = path[path.length - 1];
        // Effect params: label from the registry.
        let label = titleCase(key);
        if (path[0] === 'effects' && path[2] === 'params') {
          const eff = layer.effects.find((e) => e.id === path[1]);
          const def = defs.find((d) => d.kind === eff?.kind);
          label = def?.params.find((x) => x.key === key)?.label ?? label;
        }
        const prefix = labels.filter(Boolean).join(' › ');
        out.push({ path: path.join('.'), label: prefix ? `${prefix} › ${label}` : label, prop: p });
      }
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'id' || v == null || typeof v !== 'object') continue;
      const lab = isProp(v) || k === 'kind' || k === 'transform' || k === 'params' || k === 'effects' || k === 'masks' || k === 'animators' || k === 'items' ? '' : path.length <= 1 ? titleCase(k) : '';
      walk(v, [...path, k], [...labels, lab]);
    }
  };
  walk(layer, [], []);
  // Transform first, then everything else in document order.
  return out.sort((a, b) => (a.path.startsWith('transform') ? 0 : 1) - (b.path.startsWith('transform') ? 0 : 1));
}

export const snapT = (t: number, fps: number) => Math.round(t * fps) / fps;

/** Shift every keyframe in a layer (deep) by dt seconds. Mutates. */
export function shiftKeysDeep(o: unknown, dt: number) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach((x) => shiftKeysDeep(x, dt)); return; }
  const r = o as Record<string, unknown>;
  if (Array.isArray(r.keys) && 'value' in r) {
    for (const k of r.keys as Keyframe<unknown>[]) k.t = Math.round((k.t + dt) * 1e6) / 1e6;
  }
  for (const v of Object.values(r)) if (v && typeof v === 'object') shiftKeysDeep(v, dt);
}

/** Candidate snap times for a composition (excluding the given layers). */
export function snapTargets(comp: Composition, exclude: string[], time: number): number[] {
  const t = [0, comp.duration, time];
  for (const l of comp.layers) {
    if (exclude.includes(l.id)) continue;
    t.push(l.start, l.start + l.duration);
  }
  for (const m of comp.markers) t.push(m.t);
  if (comp.workArea) t.push(comp.workArea[0], comp.workArea[1]);
  return t;
}

/** Snap `t` to the nearest target within `px` pixels; returns the snapped time or null. */
export function snapTo(t: number, targets: number[], pps: number, px = 8): number | null {
  let best: number | null = null;
  let bd = px / pps;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d < bd) { bd = d; best = x; }
  }
  return best;
}

/** Max visible duration for a media layer (null = unlimited). */
export function maxDuration(layer: Layer, sourceDuration: number | null, sourceIn: number): number | null {
  if (sourceDuration == null || sourceDuration <= 0 || layer.timeRemap || layer.freezeAt != null) return null;
  return Math.max(0, (sourceDuration - sourceIn) / Math.max(layer.speed, 1e-6));
}

export function sourceTimeAt(layer: Layer, compT: number): number {
  const local = compT - layer.start;
  if (layer.freezeAt != null) return layer.freezeAt;
  if (layer.reverse) return Math.max(layer.sourceIn, layer.sourceIn + layer.duration * layer.speed - local * layer.speed);
  return layer.sourceIn + local * layer.speed;
}

export function niceStep(pps: number, fps: number): { major: number; minor: number } {
  // Major tick ~ every 90px.
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const major = steps.find((s) => s * pps >= 90) ?? 3600;
  const minorCands = steps.filter((s) => s < major && major / s <= 10 && Math.abs(major / s - Math.round(major / s)) < 1e-6);
  const minor = minorCands.find((s) => s * pps >= 8) ?? major;
  return { major, minor };
}

export const keyId = (layerId: string, path: string, t: number) => `${layerId}|${path}|${t.toFixed(4)}`;
export const graphId = (layerId: string, path: string) => `${layerId}::${path}`;
export const parseGraphId = (g: string) => { const [layerId, path] = g.split('::'); return { layerId, path }; };
