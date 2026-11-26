// Editing operations shared by the timeline, viewer, inspector and menus.
import type { Draft } from 'immer';
import type { Asset, Composition, Layer, Prop, Project } from '../types/project';
import { api } from './api';
import { setKey, propAt, isAnimated } from './anim';
import { activeComp, cloneLayer, draftComp, getPath, useEditor } from '../store/editor';

const S = () => useEditor.getState();

export async function addLayer(req: Parameters<typeof api.createLayer>[1], label = 'Add Layer', select = true) {
  const comp = activeComp();
  if (!comp) return null;
  const layer = await api.createLayer(comp, { start: S().time, ...req });
  S().edit(label, (d) => { draftComp(d)?.layers.unshift(layer as Draft<Layer>); });
  if (select) S().select([layer.id]);
  return layer;
}

/** Place an asset on the timeline (new top layer) at `start`. Imports the asset into the project if needed. */
export async function addAssetLayer(asset: Asset, start?: number, compId?: string) {
  const s = S();
  const comp = s.project?.compositions.find((c) => c.id === (compId ?? s.compId));
  if (!comp) return null;
  if (asset.kind === 'model3d') {
    const r = await (asset.path.toLowerCase().endsWith('.blend') ? api.importBlend(comp, asset.path) : api.importModel(comp, asset.path));
    s.edit('Add 3D Model', (d) => {
      if (!d.assets.some((a) => a.id === r.asset.id)) d.assets.push(r.asset as Draft<Asset>);
      const c = draftComp(d, comp.id);
      c?.layers.unshift(...(r.layers as Draft<Layer>[]));
    });
    if (r.report.length) s.toast('warning', 'Some scene features were not transferred', r.report.join('\n'));
    return r.layers[0] ?? null;
  }
  if (asset.kind === 'lut') {
    s.toast('info', 'LUT files are applied with the Apply LUT effect', asset.name);
    return null;
  }
  const layer = await api.createLayer(comp, { kind: 'media', asset, start: start ?? s.time });
  s.edit(`Add ${asset.name}`, (d) => {
    if (!d.assets.some((a) => a.id === asset.id)) d.assets.push(asset as Draft<Asset>);
    const c = draftComp(d, comp.id);
    if (!c) return;
    c.layers.unshift(layer as Draft<Layer>);
    // Grow the composition if the clip runs past its end.
    if (layer.start + layer.duration > c.duration) c.duration = layer.start + layer.duration;
  });
  s.select([layer.id]);
  return layer;
}

export function deleteLayers(ids = S().selectedLayers, ripple = false) {
  if (!ids.length) return;
  const comp = activeComp();
  if (!comp) return;
  if (ripple) {
    api.rippleDelete(comp, ids).then((c) => S().edit('Ripple Delete', (d) => { const dc = draftComp(d); if (dc) dc.layers = c.layers as Draft<Layer>[]; }));
  } else {
    S().edit('Delete', (d) => {
      const c = draftComp(d);
      if (!c) return;
      c.layers = c.layers.filter((l) => !ids.includes(l.id));
      for (const l of c.layers) {
        if (l.parent && ids.includes(l.parent)) l.parent = null;
        if (l.trackMatte && ids.includes(l.trackMatte.layer)) l.trackMatte = null;
      }
    });
  }
  S().set({ selectedLayers: [], selectedKeys: [] });
}

export function duplicateLayers(ids = S().selectedLayers) {
  const comp = activeComp();
  if (!comp || !ids.length) return;
  const copies: Layer[] = [];
  S().edit('Duplicate', (d) => {
    const c = draftComp(d);
    if (!c) return;
    for (const id of ids) {
      const i = c.layers.findIndex((l) => l.id === id);
      if (i < 0) continue;
      const copy = cloneLayer(c.layers[i] as Layer);
      copy.name = `${copy.name} copy`;
      copies.push(copy);
      c.layers.splice(i, 0, copy as Draft<Layer>);
    }
  });
  S().select(copies.map((l) => l.id));
}

export async function splitAtPlayhead(ids?: string[]) {
  const comp = activeComp();
  if (!comp) return;
  const t = S().time;
  const targets = ids ?? (S().selectedLayers.length ? S().selectedLayers : comp.layers.filter((l) => !l.locked && t > l.start && t < l.start + l.duration).map((l) => l.id));
  if (!targets.length) return;
  const next = await api.splitLayers(comp, targets, t);
  S().edit('Split', (d) => { const c = draftComp(d); if (c) c.layers = next.layers as Draft<Layer>[]; });
}

export async function precompose(ids = S().selectedLayers, name?: string) {
  const s = S();
  if (!s.project || !ids.length) return;
  const [p, id] = await api.makeCompound(s.project, s.compId, ids, name ?? `Compound ${s.project.compositions.length}`);
  s.replaceProject('Create Compound Clip', p);
  s.select([id]);
}

export async function unpack(id: string) {
  const s = S();
  if (!s.project) return;
  const p = await api.unpackCompound(s.project, s.compId, id);
  s.replaceProject('Unpack Compound Clip', p);
}

export async function setParent(childIds: string[], parentId: string | null) {
  const s = S();
  const comp = activeComp();
  if (!comp || !s.project) return;
  if (parentId) {
    for (const c of childIds) {
      if (c === parentId || !(await api.checkParent(comp, c, parentId))) {
        s.toast('warning', 'That would create a circular parent relationship');
        return;
      }
    }
    s.edit('Parent', (d) => { for (const c of childIds) { const l = draftComp(d)?.layers.find((x) => x.id === c); if (l) l.parent = parentId; } });
  } else {
    // Keep the child's world placement when unparenting.
    const fixed = await Promise.all(childIds.map((c) => api.unparentPreserving(s.project!, s.compId, c, s.time)));
    s.edit('Unparent', (d) => {
      const c = draftComp(d);
      for (const f of fixed) {
        const l = c?.layers.find((x) => x.id === f.id);
        if (l && !isAnimated(l.transform.position) && !isAnimated(l.transform.rotation) && !isAnimated(l.transform.scale)) l.transform = f.transform as Draft<Layer['transform']>;
        if (l) l.parent = null;
      }
    });
  }
}

export function openComp(compId: string) {
  const s = S();
  s.set({ compId, compStack: [...s.compStack.filter((c) => c !== compId), compId], selectedLayers: [], selectedKeys: [], time: 0 });
}

// ---------------------------------------------------------------- property editing

/** Resolve a property on a layer by path (e.g. "transform.position", "effects.<id>.params.radius"). */
export function layerProp<T = unknown>(layer: Layer, path: string): Prop<T> | undefined {
  return getPath(layer, path) as Prop<T> | undefined;
}

/** Set a property value at the playhead: writes a keyframe if animated (or auto-key), else the static value. */
export function setProp<T>(layerId: string, path: string, value: T, label = 'Edit', coalesce?: string) {
  const s = S();
  s.edit(label, (d) => {
    const l = draftComp(d)?.layers.find((x) => x.id === layerId);
    if (!l) return;
    const p = getPath(l, path) as Prop<T> | undefined;
    if (!p) return;
    const lt = s.time - l.start;
    if ((p.keys?.length ?? 0) > 0 || s.autoKey) setKey(p, lt, value, (s.settings?.defaultInterpolation ?? 'linear') as 'linear');
    else p.value = value;
  }, coalesce ?? `${layerId}:${path}`);
}

/** Stopwatch: toggle keyframe at playhead; if not animated, enables animation with a first key. */
export function toggleKey(layerId: string, path: string, removeAll = false) {
  const s = S();
  s.edit('Keyframe', (d) => {
    const l = draftComp(d)?.layers.find((x) => x.id === layerId);
    if (!l) return;
    const p = getPath(l, path) as Prop<unknown> | undefined;
    if (!p) return;
    const lt = Math.round((s.time - l.start) * 1e4) / 1e4;
    if (removeAll) {
      p.value = propAt(p as Prop<unknown>, lt) as never;
      p.keys = [];
      return;
    }
    const i = (p.keys ?? []).findIndex((k) => Math.abs(k.t - lt) < 1e-3);
    if (i >= 0) {
      const v = p.keys![i].v;
      p.keys!.splice(i, 1);
      if (p.keys!.length === 0) p.value = v as never;
    } else setKey(p as Prop<unknown>, lt, propAt(p as Prop<unknown>, lt), (s.settings?.defaultInterpolation ?? 'linear') as 'linear');
  });
}

export function hasKeyAt(p: Prop<unknown> | undefined, lt: number) {
  return !!p?.keys?.some((k) => Math.abs(k.t - lt) < 1e-3);
}

export function selectAllLayers() {
  const c = activeComp();
  if (c) S().select(c.layers.map((l) => l.id));
}

export function moveLayers(ids: string[], dir: 'up' | 'down' | 'top' | 'bottom') {
  S().edit('Reorder', (d) => {
    const c = draftComp(d);
    if (!c) return;
    const moving = c.layers.filter((l) => ids.includes(l.id));
    const rest = c.layers.filter((l) => !ids.includes(l.id));
    if (dir === 'top') { c.layers = [...moving, ...rest]; return; }
    if (dir === 'bottom') { c.layers = [...rest, ...moving]; return; }
    const arr = [...c.layers];
    const order = dir === 'up' ? arr.map((_, i) => i) : arr.map((_, i) => arr.length - 1 - i);
    for (const i of order) {
      if (!ids.includes(arr[i].id)) continue;
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length || ids.includes(arr[j].id)) continue;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    c.layers = arr;
  });
}

export function copyLayers() {
  const c = activeComp();
  if (!c) return;
  S().set({ clipboard: { ...S().clipboard, layers: c.layers.filter((l) => S().selectedLayers.includes(l.id)).map((l) => JSON.parse(JSON.stringify(l))) } });
}

export function pasteLayers() {
  const s = S();
  const ls = s.clipboard.layers;
  if (!ls?.length) return;
  const minStart = Math.min(...ls.map((l) => l.start));
  const fresh = ls.map((l) => { const c = cloneLayer(l); c.start = c.start - minStart + s.time; c.parent = null; c.trackMatte = null; return c; });
  s.edit('Paste', (d) => {
    const c = draftComp(d);
    c?.layers.unshift(...(fresh as Draft<Layer>[]));
    // Pasting between compositions needs the referenced assets to exist (they are project-wide).
  });
  s.select(fresh.map((l) => l.id));
}

export function layerColor(l: Layer): string {
  switch (l.kind.type) {
    case 'media': return 'var(--track-video)';
    case 'audio': return 'var(--track-audio)';
    case 'text': return 'var(--track-text)';
    case 'shape': case 'solid': case 'generator': case 'particles': return 'var(--track-shape)';
    case 'mesh': case 'camera': case 'light': return 'var(--track-3d)';
    default: return 'var(--track-null)';
  }
}

export function compById(p: Project | null, id: string): Composition | undefined {
  return p?.compositions.find((c) => c.id === id);
}
