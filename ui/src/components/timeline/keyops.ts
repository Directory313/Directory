// Keyframe editing operations shared by the timeline and graph editor.
import type { Draft } from 'immer';
import type { Keyframe, Layer, Project, Prop } from '../../types/project';
import { activeComp, draftComp, getPath, useEditor, type KeySel } from '../../store/editor';
import { applyEasing, EASE_IN_HANDLE, EASE_OUT_HANDLE, HANDLE_IN_LINEAR, HANDLE_OUT_LINEAR, propAt, setKey, type Easing } from '../../lib/anim';

const S = () => useEditor.getState();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

export function isKeySelected(sel: KeySel[], layerId: string, path: string, t: number) {
  return sel.some((k) => k.layerId === layerId && k.path === path && near(k.t, t));
}

/** Group selected keys by layer+path. */
export function groupSel(sel: KeySel[]) {
  const m = new Map<string, { layerId: string; path: string; times: number[] }>();
  for (const k of sel) {
    const id = `${k.layerId}|${k.path}`;
    if (!m.has(id)) m.set(id, { layerId: k.layerId, path: k.path, times: [] });
    m.get(id)!.times.push(k.t);
  }
  return [...m.values()];
}

function propIn(d: Draft<Project>, layerId: string, path: string): Draft<Prop<unknown>> | undefined {
  const l = draftComp(d)?.layers.find((x) => x.id === layerId);
  return l ? (getPath(l, path) as Draft<Prop<unknown>> | undefined) : undefined;
}

export function deleteSelectedKeys() {
  const sel = S().selectedKeys;
  if (!sel.length) return false;
  S().edit('Delete Keyframes', (d) => {
    for (const g of groupSel(sel)) {
      const p = propIn(d, g.layerId, g.path);
      if (!p?.keys) continue;
      const remaining = p.keys.filter((k) => !g.times.some((t) => near(t, k.t)));
      if (!remaining.length && p.keys.length) p.value = p.keys[0].v as never;
      p.keys = remaining;
    }
  });
  S().set({ selectedKeys: [] });
  return true;
}

export type InterpMode = 'linear' | 'hold' | 'bezier' | 'easy' | 'easeIn' | 'easeOut';

export function setInterp(mode: InterpMode, sel = S().selectedKeys) {
  if (!sel.length) return;
  S().edit('Keyframe Interpolation', (d) => {
    for (const g of groupSel(sel)) {
      const p = propIn(d, g.layerId, g.path);
      if (!p?.keys) continue;
      p.keys.forEach((k, i) => {
        if (!g.times.some((t) => near(t, k.t))) return;
        const prev = i > 0 ? p.keys![i - 1] : null;
        switch (mode) {
          case 'linear': k.interp = 'linear'; k.outH = HANDLE_OUT_LINEAR; k.inH = HANDLE_IN_LINEAR; break;
          case 'hold': k.interp = 'hold'; break;
          case 'bezier': k.interp = 'bezier'; break;
          case 'easy':
            k.interp = 'bezier'; k.outH = { ...EASE_OUT_HANDLE }; k.inH = { ...EASE_IN_HANDLE };
            if (prev && prev.interp !== 'hold') prev.interp = 'bezier';
            break;
          case 'easeIn':
            k.inH = { ...EASE_IN_HANDLE };
            if (prev && prev.interp !== 'hold') prev.interp = 'bezier';
            break;
          case 'easeOut': k.interp = 'bezier'; k.outH = { ...EASE_OUT_HANDLE }; break;
        }
      });
    }
  });
}

/** Move a set of keys (captured from `snapshot`) by dt seconds; optionally keep originals (duplicate). */
export function moveKeysFrom(snapshot: Project, sel: KeySel[], dt: number, fps: number, duplicate: boolean, coalesce: string): KeySel[] {
  const snapComp = snapshot.compositions.find((c) => c.id === S().compId);
  const newSel: KeySel[] = [];
  S().edit(duplicate ? 'Duplicate Keyframes' : 'Move Keyframes', (d) => {
    for (const g of groupSel(sel)) {
      const sl = snapComp?.layers.find((l) => l.id === g.layerId);
      const sp = sl ? (getPath(sl, g.path) as Prop<unknown> | undefined) : undefined;
      const p = propIn(d, g.layerId, g.path);
      if (!sp?.keys || !p) continue;
      const moved: Keyframe<unknown>[] = [];
      const kept: Keyframe<unknown>[] = [];
      for (const k of sp.keys) {
        if (g.times.some((t) => near(t, k.t))) {
          const nt = Math.round((k.t + dt) * fps) / fps;
          moved.push({ ...k, t: nt });
          newSel.push({ layerId: g.layerId, path: g.path, t: nt });
          if (duplicate) kept.push(k);
        } else kept.push(k);
      }
      // Moved keys replace any existing key at the same time.
      const merged = kept.filter((k) => !moved.some((m) => near(m.t, k.t))).concat(moved);
      merged.sort((a, b) => a.t - b.t);
      p.keys = merged as never;
    }
  }, coalesce);
  return newSel;
}

export function copyKeys() {
  const comp = activeComp();
  const sel = S().selectedKeys;
  if (!comp || !sel.length) return;
  const t0 = Math.min(...sel.map((k) => k.t));
  const out: { path: string; keys: unknown[] }[] = [];
  for (const g of groupSel(sel)) {
    const l = comp.layers.find((x) => x.id === g.layerId);
    const p = l ? (getPath(l, g.path) as Prop<unknown>) : undefined;
    if (!p?.keys) continue;
    out.push({ path: g.path, keys: p.keys.filter((k) => g.times.some((t) => near(t, k.t))).map((k) => ({ ...k, t: k.t - t0 })) });
  }
  S().set({ clipboard: { ...S().clipboard, keys: out } });
  S().toast('info', `Copied ${sel.length} keyframe${sel.length > 1 ? 's' : ''}`);
}

/** Paste copied keys onto the selected layers at the playhead (matching property paths). */
export function pasteKeys() {
  const s = S();
  const clip = s.clipboard.keys;
  const comp = activeComp();
  if (!clip?.length || !comp) return false;
  const targets = s.selectedLayers.length ? s.selectedLayers : [...new Set(s.selectedKeys.map((k) => k.layerId))];
  if (!targets.length) return false;
  s.edit('Paste Keyframes', (d) => {
    for (const lid of targets) {
      const l = draftComp(d)?.layers.find((x) => x.id === lid);
      if (!l) continue;
      const base = s.time - l.start;
      for (const c of clip) {
        const p = getPath(l, c.path) as Draft<Prop<unknown>> | undefined;
        if (!p) continue;
        for (const k of c.keys as Keyframe<unknown>[]) {
          const t = Math.round((base + k.t) * comp.fps) / comp.fps;
          setKey(p as Prop<unknown>, t, k.v);
          const nk = p.keys!.find((x) => near(x.t, t));
          if (nk) { nk.interp = k.interp; nk.inH = k.inH; nk.outH = k.outH; }
        }
      }
    }
  });
  return true;
}

export function reverseKeys() {
  const sel = S().selectedKeys;
  if (sel.length < 2) return;
  S().edit('Reverse Keyframes', (d) => {
    for (const g of groupSel(sel)) {
      const p = propIn(d, g.layerId, g.path);
      if (!p?.keys) continue;
      const lo = Math.min(...g.times), hi = Math.max(...g.times);
      // Mirror times inside [lo, hi]; mirror bezier handles so eases play backwards correctly.
      for (const k of p.keys) {
        if (!g.times.some((t) => near(t, k.t))) continue;
        k.t = Math.round((lo + hi - k.t) * 1e6) / 1e6;
        const o = k.outH ?? HANDLE_OUT_LINEAR, i = k.inH ?? HANDLE_IN_LINEAR;
        k.outH = { x: 1 - i.x, y: 1 - i.y };
        k.inH = { x: 1 - o.x, y: 1 - o.y };
      }
      p.keys.sort((a, b) => a.t - b.t);
    }
  });
}

export function selectAllOnRow(layerId: string, path: string) {
  const comp = activeComp();
  const l = comp?.layers.find((x) => x.id === layerId);
  const p = l ? (getPath(l, path) as Prop<unknown>) : undefined;
  S().set({ selectedKeys: (p?.keys ?? []).map((k) => ({ layerId, path, t: k.t })) });
}

/** Value at a layer-local time (for "add key at playhead"). */
export function valueAt(layer: Layer, path: string, lt: number) {
  const p = getPath(layer, path) as Prop<unknown> | undefined;
  return p ? propAt(p, lt) : undefined;
}

/** Every animatable prop path (with 2+ keys) on a layer, found by walking the layer object. */
export function animatedPaths(l: Layer): string[] {
  const out: string[] = [];
  const walk = (o: unknown, path: string, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 7) return;
    if (!Array.isArray(o) && 'value' in (o as object) && Array.isArray((o as Prop<unknown>).keys)) {
      if (((o as Prop<unknown>).keys?.length ?? 0) > 1) out.push(path);
      return;
    }
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${path}.${(x as { id?: string })?.id ?? i}`, depth + 1)); return; }
    for (const [k, v] of Object.entries(o as object)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(l, '', 0);
  return out;
}

/**
 * Apply an easing curve to existing keyframe segments — never adds keys.
 * Targets: the segments leaving the selected keyframes; with no keys selected, every
 * segment of every animated property on the selected layers. Returns segments changed.
 */
export function applyEasingToSelection(e: Easing): number {
  const s = S();
  const comp = activeComp();
  if (!comp) return 0;
  let targets = groupSel(s.selectedKeys).map((g) => ({ ...g, all: false }));
  if (!targets.length) {
    targets = comp.layers.filter((l) => s.selectedLayers.includes(l.id))
      .flatMap((l) => animatedPaths(l).map((path) => ({ layerId: l.id, path, times: [] as number[], all: true })));
  }
  let n = 0;
  s.edit(`Easing: ${e.name}`, (d) => {
    for (const g of targets) {
      const p = propIn(d, g.layerId, g.path);
      if (!p?.keys || p.keys.length < 2) continue;
      const ks = p.keys as Keyframe<unknown>[];
      ks.forEach((k, i) => {
        if (i === ks.length - 1) return;
        // A selected last key eases the segment arriving at it instead.
        if (!g.all && !g.times.some((t) => near(t, k.t))) return;
        applyEasing(e, k, ks[i + 1]);
        n++;
      });
      if (!g.all) {
        const last = ks[ks.length - 1];
        if (g.times.some((t) => near(t, last.t)) && !g.times.some((t) => near(t, ks[ks.length - 2].t))) { applyEasing(e, ks[ks.length - 2], last); n++; }
      }
    }
  });
  if (!n) s.toast('info', 'Nothing to ease', 'Select keyframes (or a layer with at least two keyframes on a property) first. Easing changes the curve between existing keyframes.');
  else s.toast('success', `${e.name} applied to ${n} segment${n === 1 ? '' : 's'}`);
  return n;
}
