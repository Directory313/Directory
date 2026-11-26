// Clip drag gestures: move, trim in/out, slip, slide, roll and ripple.
import type { Draft } from 'immer';
import type { Composition, Layer, Project } from '../../types/project';
import { draftComp, useEditor } from '../../store/editor';
import { maxDuration, shiftKeysDeep, snapTargets, snapTo } from './model';
import { useTL } from './tlstore';

export type DragMode = 'move' | 'trimL' | 'trimR' | 'slip' | 'slide';

export interface ClipDrag {
  mode: DragMode;
  layerId: string;
  ids: string[];
  snapshot: Project;
  x0: number;
  coalesce: string;
}

const S = () => useEditor.getState();
const EPS = 1e-4;

function srcDuration(p: Project, l: Layer): number | null {
  if (l.kind.type !== 'media' && l.kind.type !== 'audio') return null;
  const asset = p.assets.find((a) => a.id === (l.kind as { asset: string }).asset);
  if (!asset || asset.kind === 'image' || asset.kind === 'svg' || asset.info.duration <= 0) return null;
  return asset.info.duration;
}

/** Find a layer that touches `edge` on the other side (for roll/slide), excluding `self`. */
function neighbour(c: Composition, self: string, edge: number, side: 'before' | 'after', fps: number) {
  const tol = 0.5 / fps;
  return c.layers.find((l) => l.id !== self && (side === 'before' ? Math.abs(l.start + l.duration - edge) < tol : Math.abs(l.start - edge) < tol));
}

export function applyClipDrag(d: ClipDrag, clientX: number, alt: boolean) {
  const s = S();
  const { pps } = useTL.getState();
  const ripple = useTL.getState().ripple;
  const snapComp = d.snapshot.compositions.find((c) => c.id === s.compId);
  if (!snapComp) return;
  const fps = snapComp.fps;
  const frame = (t: number) => Math.round(t * fps) / fps;
  let dt = (clientX - d.x0) / pps;
  const main = snapComp.layers.find((l) => l.id === d.layerId);
  if (!main) return;
  const snapping = s.snapping && !alt;
  const targets = snapping ? snapTargets(snapComp, d.ids, s.time) : [];

  if (d.mode === 'move') {
    if (snapping) {
      const a = snapTo(main.start + dt, targets, pps);
      const b = snapTo(main.start + main.duration + dt, targets, pps);
      if (a != null && (b == null || Math.abs(a - main.start - dt) <= Math.abs(b - main.start - main.duration - dt))) dt = a - main.start;
      else if (b != null) dt = b - main.start - main.duration;
    }
    dt = frame(dt);
    const minStart = Math.min(...snapComp.layers.filter((l) => d.ids.includes(l.id)).map((l) => l.start));
    // Allow negative starts only down to -duration (layer partly before 0 is valid in AE, keep it simple: clamp at 0).
    if (minStart + dt < 0) dt = -minStart;
    s.edit('Move Clip', (dr) => {
      const c = draftComp(dr);
      if (!c) return;
      for (const id of d.ids) {
        const l = c.layers.find((x) => x.id === id);
        const o = snapComp.layers.find((x) => x.id === id);
        if (l && o && !o.locked) l.start = frame(o.start + dt);
      }
      const end = Math.max(...c.layers.map((l) => l.start + l.duration));
      if (end > c.duration) c.duration = end;
    }, d.coalesce);
    return;
  }

  if (d.mode === 'slip') {
    const sd = srcDuration(d.snapshot, main);
    dt = frame(dt);
    s.edit('Slip', (dr) => {
      const l = draftComp(dr)?.layers.find((x) => x.id === d.layerId);
      if (!l) return;
      let si = main.sourceIn - dt * main.speed;
      const maxIn = sd != null ? Math.max(0, sd - main.duration * main.speed) : Infinity;
      si = Math.min(maxIn, Math.max(0, si));
      l.sourceIn = Math.round(si * 1e6) / 1e6;
    }, d.coalesce);
    return;
  }

  if (d.mode === 'slide') {
    // Move this clip; the clip ending at our start and the clip starting at our end follow.
    dt = frame(dt);
    const prev = neighbour(snapComp, main.id, main.start, 'before', fps);
    const next = neighbour(snapComp, main.id, main.start + main.duration, 'after', fps);
    if (prev) dt = Math.max(dt, -prev.duration + 1 / fps);
    if (next) dt = Math.min(dt, next.duration - 1 / fps);
    s.edit('Slide', (dr) => {
      const c = draftComp(dr);
      if (!c) return;
      const l = c.layers.find((x) => x.id === main.id);
      if (l) l.start = frame(main.start + dt);
      if (prev) { const p = c.layers.find((x) => x.id === prev.id); if (p) p.duration = frame(prev.duration + dt); }
      if (next) {
        const n = c.layers.find((x) => x.id === next.id);
        if (n) { trimLeft(n, next, dt, srcDuration(d.snapshot, next), fps); }
      }
    }, d.coalesce);
    return;
  }

  // Trims (with roll when the opposite clip is also selected and touching).
  const edge = d.mode === 'trimL' ? main.start : main.start + main.duration;
  if (snapping) {
    const sn = snapTo(edge + dt, targets, pps);
    if (sn != null) dt = sn - edge;
  }
  dt = frame(dt);
  const rollPartner = d.ids.length === 2 ? neighbour(snapComp, main.id, edge, d.mode === 'trimL' ? 'before' : 'after', fps) : undefined;
  const partner = rollPartner && d.ids.includes(rollPartner.id) ? rollPartner : undefined;
  s.edit(partner ? 'Roll Edit' : 'Trim', (dr) => {
    const c = draftComp(dr);
    if (!c) return;
    const l = c.layers.find((x) => x.id === main.id);
    if (!l) return;
    const sd = srcDuration(d.snapshot, main);
    if (d.mode === 'trimL') {
      const applied = trimLeft(l, main, dt, sd, fps);
      if (partner) { const p = c.layers.find((x) => x.id === partner.id); if (p) p.duration = Math.max(1 / fps, frame(partner.duration + applied)); }
    } else {
      let nd = main.duration + dt;
      const mx = maxDuration(main, sd, main.sourceIn);
      if (mx != null) nd = Math.min(nd, mx);
      nd = Math.max(1 / fps, frame(nd));
      const applied = nd - main.duration;
      l.duration = nd;
      if (partner) { const p = c.layers.find((x) => x.id === partner.id); if (p) trimLeft(p, partner, applied, srcDuration(d.snapshot, partner), fps); }
      if (ripple && !partner) {
        for (const o of snapComp.layers) {
          if (o.id === main.id || o.start < main.start + main.duration - EPS) continue;
          const x = c.layers.find((y) => y.id === o.id);
          if (x) x.start = Math.max(0, frame(o.start + applied));
        }
      }
      const end = Math.max(...c.layers.map((x) => x.start + x.duration));
      if (end > c.duration) c.duration = end;
    }
  }, d.coalesce);
}

/** Move a layer's in-point by dt keeping its content (and keyframes) fixed in comp time. Returns applied dt. */
function trimLeft(l: Draft<Layer>, orig: Layer, dt: number, sd: number | null, fps: number): number {
  let d = dt;
  d = Math.min(d, orig.duration - 1 / fps);
  if (orig.start + d < 0) d = -orig.start;
  if (!orig.reverse && sd != null && orig.freezeAt == null && !orig.timeRemap) {
    const minD = -orig.sourceIn / Math.max(orig.speed, 1e-6);
    d = Math.max(d, minD);
  } else if (sd == null && orig.kind.type === 'media') {
    // stills: free
  }
  d = Math.round(d * fps) / fps;
  l.start = Math.round((orig.start + d) * 1e6) / 1e6;
  l.duration = Math.round((orig.duration - d) * 1e6) / 1e6;
  if (!orig.reverse) l.sourceIn = Math.max(0, Math.round((orig.sourceIn + d * orig.speed) * 1e6) / 1e6);
  // Restore keys from the original then shift so they stay put in comp time.
  const restored = JSON.parse(JSON.stringify(orig)) as Layer;
  shiftKeysDeep(restored, -d);
  l.transform = restored.transform as never;
  l.effects = restored.effects as never;
  l.masks = restored.masks as never;
  l.audio = restored.audio as never;
  l.kind = restored.kind as never;
  l.material = restored.material as never;
  if (restored.timeRemap) l.timeRemap = restored.timeRemap as never;
  return d;
}
