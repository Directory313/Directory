// Align / distribute selected layers, and the snapping targets used while dragging in the viewer.
// All geometry is in comp pixels using each layer's on-screen (world) bounding box.
import type { Composition, Layer, Project } from '../../types/project';
import { useEditor } from '../../store/editor';
import { propAt } from '../../lib/anim';
import { registerActions } from '../../lib/actions';
import { writeProps } from '../inspector/util';
import { apply, applyLinear, contentBounds, inv, isPickable, parentMatrix, worldMatrix, type P } from './geom';

export type Box = [number, number, number, number]; // x0, y0, x1, y1

const S = () => useEditor.getState();

/** Axis-aligned bounds of a layer as drawn in the comp. */
export function worldBox(p: Project, comp: Composition, l: Layer, t: number): Box {
  const m = worldMatrix(comp, l, t);
  const [x0, y0, x1, y1] = contentBounds(p, comp, l, t);
  const pts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as P[]).map((q) => apply(m, q));
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

const visibleAt = (l: Layer, t: number) => l.visible && t >= l.start && t < l.start + l.duration;

/** Lines a dragged selection can snap to: the frame's edges and centre, and every other visible
 *  layer's edges and centre. */
export function snapTargets(p: Project, comp: Composition, t: number, exclude: string[]): { x: number[]; y: number[] } {
  const x = [0, comp.width / 2, comp.width], y = [0, comp.height / 2, comp.height];
  for (const l of comp.layers) {
    if (exclude.includes(l.id) || !isPickable(l) || !visibleAt(l, t)) continue;
    const b = worldBox(p, comp, l, t);
    x.push(b[0], (b[0] + b[2]) / 2, b[2]);
    y.push(b[1], (b[1] + b[3]) / 2, b[3]);
  }
  return { x, y };
}

/** Best snap of a box's edges/centre to the targets within `threshold`: returns the offset to
 *  add and the line it snapped to (null when nothing is close enough). */
export function snapAxis(lo: number, hi: number, targets: number[], threshold: number): { offset: number; line: number | null } {
  let best = { offset: 0, line: null as number | null, d: threshold };
  for (const v of [lo, (lo + hi) / 2, hi]) {
    for (const tg of targets) {
      const d = Math.abs(tg - v);
      if (d <= best.d) best = { offset: tg - v, line: tg, d };
    }
  }
  return { offset: best.offset, line: best.line };
}

/** Move a layer by a comp-space delta (respects parenting, keyframes and auto-key via writeProps). */
function moveWrite(comp: Composition, l: Layer, t: number, dx: number, dy: number) {
  const pos = propAt(l.transform.position, t - l.start);
  const d = applyLinear(inv(parentMatrix(comp, l, t)), [dx, dy]);
  return { layerId: l.id, path: 'transform.position', value: [pos[0] + d[0], pos[1] + d[1], pos[2]] };
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align the selection. One layer aligns to the frame; several align to their combined bounds. */
export function alignSelected(mode: AlignMode) {
  const s = S();
  const comp = s.project?.compositions.find((c) => c.id === s.compId);
  if (!s.project || !comp) return;
  const t = s.time;
  const layers = comp.layers.filter((l) => s.selectedLayers.includes(l.id) && !l.locked);
  if (!layers.length) { s.toast('info', 'Select a layer to align'); return; }
  const boxes = layers.map((l) => worldBox(s.project!, comp, l, t));
  const ref: Box = layers.length === 1 ? [0, 0, comp.width, comp.height] : unionBox(boxes)!;
  const writes = layers.map((l, i) => {
    const b = boxes[i];
    let dx = 0, dy = 0;
    if (mode === 'left') dx = ref[0] - b[0];
    if (mode === 'right') dx = ref[2] - b[2];
    if (mode === 'hcenter') dx = (ref[0] + ref[2]) / 2 - (b[0] + b[2]) / 2;
    if (mode === 'top') dy = ref[1] - b[1];
    if (mode === 'bottom') dy = ref[3] - b[3];
    if (mode === 'vcenter') dy = (ref[1] + ref[3]) / 2 - (b[1] + b[3]) / 2;
    return moveWrite(comp, l, t, dx, dy);
  });
  writeProps(writes, 'Align');
}

/** Space three or more selected layers evenly (by their centres) between the outermost two. */
export function distributeSelected(axis: 'x' | 'y') {
  const s = S();
  const comp = s.project?.compositions.find((c) => c.id === s.compId);
  if (!s.project || !comp) return;
  const t = s.time;
  const layers = comp.layers.filter((l) => s.selectedLayers.includes(l.id) && !l.locked);
  if (layers.length < 3) { s.toast('info', 'Select three or more layers to distribute'); return; }
  const k = axis === 'x' ? 0 : 1;
  const items = layers.map((l) => { const b = worldBox(s.project!, comp, l, t); return { l, c: (b[k] + b[k + 2]) / 2 }; }).sort((a, b) => a.c - b.c);
  const first = items[0].c, last = items[items.length - 1].c, step = (last - first) / (items.length - 1);
  writeProps(items.map((it, i) => {
    const d = first + step * i - it.c;
    return moveWrite(comp, it.l, t, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
  }), 'Distribute');
}

const hasSel = () => S().selectedLayers.length > 0;
registerActions([
  { id: 'align.left', label: 'Align Left', group: 'Align', run: () => alignSelected('left'), enabled: hasSel },
  { id: 'align.hcenter', label: 'Align Horizontal Centre', group: 'Align', run: () => alignSelected('hcenter'), enabled: hasSel },
  { id: 'align.right', label: 'Align Right', group: 'Align', run: () => alignSelected('right'), enabled: hasSel },
  { id: 'align.top', label: 'Align Top', group: 'Align', run: () => alignSelected('top'), enabled: hasSel },
  { id: 'align.vcenter', label: 'Align Vertical Centre', group: 'Align', run: () => alignSelected('vcenter'), enabled: hasSel },
  { id: 'align.bottom', label: 'Align Bottom', group: 'Align', run: () => alignSelected('bottom'), enabled: hasSel },
  { id: 'align.center', label: 'Centre in Frame', group: 'Align', shortcut: 'Ctrl+Alt+Home', run: () => { alignSelected('hcenter'); alignSelected('vcenter'); }, enabled: hasSel },
  { id: 'align.distX', label: 'Distribute Horizontally', group: 'Align', run: () => distributeSelected('x'), enabled: () => S().selectedLayers.length >= 3 },
  { id: 'align.distY', label: 'Distribute Vertically', group: 'Align', run: () => distributeSelected('y'), enabled: () => S().selectedLayers.length >= 3 },
  { id: 'viewer.snap', label: 'Toggle Snapping in Viewer', group: 'Viewer', shortcut: 'Ctrl+;', run: () => S().set({ viewer: { ...S().viewer, snap: !S().viewer.snap } }) },
]);
