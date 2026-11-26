// Masks list + properties.
import type { Draft } from 'immer';
import { Plus, Trash2 } from 'lucide-react';
import type { Layer, Mask, MaskMode } from '../../types/project';
import { useEditor } from '../../store/editor';
import { api } from '../../lib/api';
import { Select, Toggle } from '../ui/primitives';
import { NumRow, PropRow } from './PropRow';
import { editLayers } from './util';
import { layerSize } from '../viewer/geom';
import type { BezPath } from '../../types/project';

const S = () => useEditor.getState();
const MODES: MaskMode[] = ['add', 'subtract', 'intersect', 'difference', 'lighten', 'darken', 'none'];

export function MasksSection({ layer }: { layer: Layer }) {
  const selMask = useEditor((s) => s.selectedMask);
  const project = useEditor((s) => s.project)!;
  const comp = project.compositions.find((c) => c.id === S().compId)!;
  const ed = (label: string, fn: (m: Draft<Mask>) => void, id: string, co?: string) =>
    editLayers([layer.id], label, (l) => { const m = l.masks.find((x) => x.id === id); if (m) fn(m); }, co);
  const add = async (kind: 'rect' | 'ellipse') => {
    const [w, h] = layerSize(project, comp, layer);
    const m = await api.createMask(kind, w, h);
    m.name = `Mask ${layer.masks.length + 1}`;
    editLayers([layer.id], 'Add Mask', (l) => { l.masks.push(m as Draft<Mask>); });
    S().set({ selectedMask: m.id, tool: 'select' });
  };
  return (
    <div className="col" style={{ gap: 2 }}>
      {layer.masks.map((m) => {
        const open = selMask === m.id;
        return (
          <div key={m.id} className={`mask-card ${open ? 'on' : ''}`}>
            <div className="row mask-head" onClick={() => S().set({ selectedMask: open ? null : m.id })}>
              <span onClick={(e) => e.stopPropagation()}><Toggle on={m.enabled} onChange={(v) => ed(v ? 'Enable Mask' : 'Disable Mask', (x) => { x.enabled = v; }, m.id)} /></span>
              <input className="input grow" value={m.name} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => ed('Rename Mask', (x) => { x.name = e.target.value; }, m.id, `mname:${m.id}`)} />
              <span onClick={(e) => e.stopPropagation()}>
                <Select value={m.mode} onChange={(v) => ed('Mask Mode', (x) => { x.mode = v; }, m.id)} options={MODES.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }))} />
              </span>
              <label className="row label" onClick={(e) => e.stopPropagation()} title="Invert">
                <input type="checkbox" checked={m.inverted} onChange={(e) => ed('Invert Mask', (x) => { x.inverted = e.target.checked; }, m.id)} />Inv
              </label>
              <button className="icon-btn sm" title="Delete mask" onClick={(e) => { e.stopPropagation(); editLayers([layer.id], 'Delete Mask', (l) => { l.masks = l.masks.filter((x) => x.id !== m.id); }); }}><Trash2 size={11} /></button>
            </div>
            {open && (
              <div className="mask-body">
                <PropRow<BezPath> layers={[layer]} path={`masks.${m.id}.path`} label="Mask Path" title="Keyframe the path to animate the mask shape (rotoscoping)">
                  {(v) => <span className="muted">{v.vertices.length} vertices · edit in viewer</span>}
                </PropRow>
                <NumRow layers={[layer]} path={`masks.${m.id}.feather`} label="Feather" min={0} max={500} unit="px" />
                <NumRow layers={[layer]} path={`masks.${m.id}.expansion`} label="Expansion" min={-500} max={500} unit="px" />
                <NumRow layers={[layer]} path={`masks.${m.id}.opacity`} label="Opacity" min={0} max={100} unit="%" slider />
              </div>
            )}
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn sm" onClick={() => add('rect')}><Plus size={12} /> Rectangle</button>
        <button className="btn sm" onClick={() => add('ellipse')}><Plus size={12} /> Ellipse</button>
        <button className="btn sm ghost" onClick={() => S().set({ tool: 'maskPen' })} title="Draw a bezier mask in the viewer">Pen…</button>
      </div>
      {layer.masks.length > 0 && <div className="muted hint">Select a mask to edit its vertices in the viewer: drag points/handles, double-click the outline to add a point, Delete removes the selected point.</div>}
    </div>
  );
}
