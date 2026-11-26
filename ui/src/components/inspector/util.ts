// Inspector/viewer editing helpers (single undo step for multi-layer writes).
import type { Draft } from 'immer';
import type { Layer, Prop } from '../../types/project';
import { draftComp, getPath, useEditor } from '../../store/editor';
import { setKey } from '../../lib/anim';

const S = () => useEditor.getState();

export interface PropWrite { layerId: string; path: string; value: unknown }

/** Write property values at the playhead (keyframe when animated / auto-key) in one undo step. */
export function writeProps(writes: PropWrite[], label = 'Edit', coalesce?: string) {
  const s = S();
  const interp = (s.settings?.defaultInterpolation ?? 'linear') as 'linear';
  s.edit(label, (d) => {
    const c = draftComp(d);
    if (!c) return;
    for (const w of writes) {
      const l = c.layers.find((x) => x.id === w.layerId);
      if (!l) continue;
      const p = getPath(l, w.path) as Prop<unknown> | undefined;
      if (!p || typeof p !== 'object' || !('value' in p)) continue;
      const lt = Math.round((s.time - l.start) * 1e5) / 1e5;
      if ((p.keys?.length ?? 0) > 0 || s.autoKey) setKey(p, lt, w.value, interp);
      else p.value = w.value as never;
    }
  }, coalesce ?? `${writes.map((w) => w.layerId).join(',')}:${writes[0]?.path}`);
}

/** Edit non-animated fields of one or more layers. */
export function editLayers(ids: string[], label: string, fn: (l: Draft<Layer>) => void, coalesce?: string) {
  S().edit(label, (d) => {
    const c = draftComp(d);
    if (!c) return;
    for (const id of ids) {
      const l = c.layers.find((x) => x.id === id);
      if (l) fn(l);
    }
  }, coalesce);
}

export const P = <T,>(value: T): Prop<T> => ({ value, keys: [] });

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
