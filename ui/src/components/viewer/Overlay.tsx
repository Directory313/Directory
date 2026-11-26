// Interactive overlay: selection/transform handles, shape/text/pen/mask tools, mask editing,
// guides, grid, safe areas and track points. Coordinates inside the SVG group are comp pixels.
import { useEffect, useRef, useState } from 'react';
import type { Draft } from 'immer';
import type { BezPath, Composition, Layer, PathVertex, Vec3 } from '../../types/project';
import { draftComp, useEditor } from '../../store/editor';
import { api } from '../../lib/api';
import { propAt } from '../../lib/anim';
import { writeProps, editLayers } from '../inspector/util';
import { apply, applyLinear, contentBounds, ellipsePath, inv, layerSize, mul, parentMatrix, pathD, pick, rectPath, rotate, translate, worldMatrix, type M, type P } from './geom';

export interface View { left: number; top: number; z: number }
export interface Guide { axis: 'x' | 'y'; pos: number }
export interface TrackPoint { layerId: string; p: P }

type Drag =
  | { kind: 'move'; start: P; items: { id: string; pos: Vec3; pinv: M }[]; key: string }
  | { kind: 'scale'; id: string; corner: P; mask: [number, number]; s0: Vec3; key: string }
  | { kind: 'rotate'; id: string; center: P; a0: number; r0: Vec3; key: string }
  | { kind: 'anchor'; id: string; key: string }
  | { kind: 'rubber'; start: P; cur: P }
  | { kind: 'vertex'; maskId: string; idx: number; key: string }
  | { kind: 'tangent'; maskId: string; idx: number; which: 'i' | 'o'; key: string }
  | { kind: 'penHandle'; idx: number }
  | { kind: 'pan'; x: number; y: number; px: number; py: number }
  | { kind: 'orbit'; x: number; y: number; camId: string; pos0: Vec3; poi: Vec3; key: string }
  | { kind: 'guide'; idx: number };

const S = () => useEditor.getState();
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function Overlay({ comp, view, onPan, guides, setGuides, trackPts, setTrackPts }: {
  comp: Composition; view: View; onPan: (dx: number, dy: number) => void;
  guides: Guide[]; setGuides: (g: Guide[]) => void; trackPts: TrackPoint[]; setTrackPts: (t: TrackPoint[]) => void;
}) {
  const project = useEditor((s) => s.project)!;
  const time = useEditor((s) => s.time);
  const tool = useEditor((s) => s.tool);
  const sel = useEditor((s) => s.selectedLayers);
  const selMask = useEditor((s) => s.selectedMask);
  const vflags = useEditor((s) => s.viewer);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [pen, setPen] = useState<PathVertex[]>([]);
  const [hoverPt, setHoverPt] = useState<P | null>(null);
  const [selVertex, setSelVertex] = useState<number | null>(null);
  const [textEdit, setTextEdit] = useState<{ layerId: string; value: string } | null>(null);
  const { z } = view;
  const hs = 5 / z; // handle half-size in comp px

  const toComp = (e: { clientX: number; clientY: number }): P => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left - view.left) / z, (e.clientY - r.top - view.top) / z];
  };
  const setD = (d: Drag | null) => { dragRef.current = d; setDrag(d); };

  const selectedLayers = comp.layers.filter((l) => sel.includes(l.id));
  const single = selectedLayers.length === 1 ? selectedLayers[0] : undefined;
  const editMask = single && selMask ? single.masks.find((m) => m.id === selMask) : undefined;

  // Finish/cancel pen and delete vertices from the keyboard (capture phase so global shortcuts don't fire).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') return;
      if (pen.length && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Enter' && pen.length >= 2) void finishPen(false); else setPen([]);
      } else if (editMask && selVertex != null && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); e.stopImmediatePropagation();
        const path = propAt(editMask.path, time - single!.start);
        if (path.vertices.length <= 2) return;
        const next: BezPath = { ...path, vertices: path.vertices.filter((_, i) => i !== selVertex) };
        writeProps([{ layerId: single!.id, path: `masks.${editMask.id}.path`, value: next }], 'Delete Mask Vertex');
        setSelVertex(null);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  useEffect(() => { if (tool !== 'pen' && tool !== 'maskPen') setPen([]); }, [tool]);

  // ------------------------------------------------------------ creation helpers
  async function drawShape(a: P, b: P, square: boolean) {
    let w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    if (square) w = h = Math.max(w, h);
    if (w < 4 || h < 4) return;
    const cx = (b[0] >= a[0] ? a[0] + w / 2 : a[0] - w / 2), cy = (b[1] >= a[1] ? a[1] + h / 2 : a[1] - h / 2);
    const variant = tool === 'rect' ? 'rect' : tool === 'ellipse' ? 'ellipse' : tool === 'polygon' ? 'polygon' : 'star';
    const layer = await api.createLayer(comp, { kind: 'shape', variant, start: S().time });
    if (layer.kind.type === 'shape') {
      const g = layer.kind.items[0].geometry;
      if (g.type === 'rect' || g.type === 'ellipse') g.size.value = [w, h];
      if (g.type === 'polygon') { g.outerRadius.value = Math.min(w, h) / 2; g.innerRadius.value = Math.min(w, h) / (g.star ? 4.5 : 4); }
    }
    layer.transform.position.value = [cx, cy, 0];
    S().edit('Draw Shape', (d) => { draftComp(d, comp.id)?.layers.unshift(layer as Draft<Layer>); });
    S().select([layer.id]);
  }

  async function createText(pt: P) {
    const layer = await api.createLayer(comp, { kind: 'text', text: 'Text', start: S().time });
    layer.transform.position.value = [pt[0], pt[1], 0];
    S().edit('Add Text', (d) => { draftComp(d, comp.id)?.layers.unshift(layer as Draft<Layer>); });
    S().select([layer.id]);
    setTextEdit({ layerId: layer.id, value: 'Text' });
  }

  function commitText() {
    if (!textEdit) return;
    const value = textEdit.value;
    editLayers([textEdit.layerId], 'Edit Text', (l) => {
      if (l.kind.type !== 'text') return;
      if ((l.kind.text.keys?.length ?? 0) > 0) {
        const lt = S().time - l.start;
        const k = l.kind.text.keys!.find((x) => Math.abs(x.t - lt) < 1e-3);
        if (k) k.v = value; else l.kind.text.value = value;
      } else l.kind.text.value = value;
      l.name = value.split('\n')[0].slice(0, 24) || 'Text';
    });
    setTextEdit(null);
  }

  async function finishPen(closed: boolean) {
    const pts = pen;
    setPen([]);
    if (pts.length < 2) return;
    if (tool === 'maskPen' && single) {
      const m = inv(worldMatrix(comp, single, time));
      const path: BezPath = { closed: true, vertices: pts.map((v) => ({ p: apply(m, v.p as P), i: applyLinear(m, v.i as P), o: applyLinear(m, v.o as P) })) };
      const [w, h] = layerSize(project, comp, single);
      const mask = await api.createMask('rect', w, h);
      mask.path.value = path;
      mask.name = `Mask ${single.masks.length + 1}`;
      editLayers([single.id], 'Add Mask', (l) => { l.masks.push(mask as Draft<typeof mask>); });
      S().set({ selectedMask: mask.id });
      return;
    }
    const layer = await api.createLayer(comp, { kind: 'shape', variant: 'path', start: S().time });
    if (layer.kind.type === 'shape') {
      const g = layer.kind.items[0].geometry;
      if (g.type === 'path') g.path.value = { closed, vertices: pts.map((v) => ({ p: [v.p[0] - comp.width / 2, v.p[1] - comp.height / 2], i: v.i, o: v.o })) };
      if (!closed) layer.kind.items[0].fills.forEach((f) => (f.enabled = false));
      layer.name = 'Path';
    }
    S().edit('Draw Path', (d) => { draftComp(d, comp.id)?.layers.unshift(layer as Draft<Layer>); });
    S().select([layer.id]);
  }

  async function addMaskRect(a: P, b: P, ellipse: boolean) {
    if (!single) { S().toast('info', 'Select a layer first, then draw a mask on it'); return; }
    const m = inv(worldMatrix(comp, single, time));
    const corners = [a, [b[0], a[1]] as P, b, [a[0], b[1]] as P].map((p) => apply(m, p));
    let path: BezPath;
    if (ellipse) {
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      path = ellipsePath((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2);
    } else {
      path = rectPath(0, 0, 1, 1);
      path.vertices.forEach((v, i) => (v.p = corners[i]));
    }
    if (dist(a, b) < 3) return;
    const [w, h] = layerSize(project, comp, single);
    const mask = await api.createMask(ellipse ? 'ellipse' : 'rect', w, h);
    mask.path.value = path;
    mask.name = `Mask ${single.masks.length + 1}`;
    editLayers([single.id], 'Add Mask', (l) => { l.masks.push(mask as Draft<typeof mask>); });
    S().set({ selectedMask: mask.id });
  }

  // ------------------------------------------------------------ pointer handling
  function onDown(e: React.PointerEvent) {
    if (e.button === 1) { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setD({ kind: 'pan', x: e.clientX, y: e.clientY, px: 0, py: 0 }); return; }
    if (e.button !== 0) return;
    if (textEdit) { commitText(); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const pt = toComp(e);
    const target = (e.target as Element).closest('[data-h]') as HTMLElement | SVGElement | null;
    const h = target?.getAttribute('data-h') ?? '';
    const key = `vw-${Math.random()}`;

    if (tool === 'hand') { setD({ kind: 'pan', x: e.clientX, y: e.clientY, px: 0, py: 0 }); return; }
    if (tool === 'zoom') return; // handled by Viewer wheel/click
    if (h.startsWith('guide:')) { setD({ kind: 'guide', idx: Number(h.slice(6)) }); return; }
    if (tool === 'orbit') {
      const cam = comp.layers.find((l) => l.kind.type === 'camera' && l.visible && time >= l.start && time < l.start + l.duration);
      if (!cam || cam.kind.type !== 'camera') { S().toast('info', 'Add a camera layer to orbit the 3D view'); return; }
      setD({ kind: 'orbit', x: e.clientX, y: e.clientY, camId: cam.id, pos0: propAt(cam.transform.position, time - cam.start), poi: propAt(cam.kind.pointOfInterest, time - cam.start), key });
      return;
    }
    if (['rect', 'ellipse', 'polygon', 'star', 'maskRect', 'maskEllipse'].includes(tool)) { setD({ kind: 'rubber', start: pt, cur: pt }); return; }
    if (tool === 'text') {
      const hit = pick(project, comp, pt, time);
      if (hit && hit.kind.type === 'text') { S().select([hit.id]); setTextEdit({ layerId: hit.id, value: propAt(hit.kind.text, time - hit.start) }); }
      else void createText(pt);
      return;
    }
    if (tool === 'pen' || tool === 'maskPen') {
      if (tool === 'maskPen' && !single) { S().toast('info', 'Select a layer to draw a mask on'); return; }
      if (pen.length >= 2 && dist(pt, pen[0].p as P) < 8 / z) { void finishPen(true); return; }
      setPen([...pen, { p: pt, i: [0, 0], o: [0, 0] }]);
      setD({ kind: 'penHandle', idx: pen.length });
      return;
    }
    if (tool === 'track') {
      const hit = pick(project, comp, pt, time);
      if (!hit || hit.kind.type !== 'media') { S().toast('info', 'Click a video layer to place a track point'); return; }
      const lp = apply(inv(worldMatrix(comp, hit, time)), pt);
      const pts = trackPts.filter((t) => t.layerId === hit.id);
      setTrackPts([...pts, { layerId: hit.id, p: lp }]);
      S().select([hit.id]);
      return;
    }

    // ---- select tool
    if (h === 'mask') return;
    if (h.startsWith('v:') && editMask && single) { const idx = Number(h.slice(2)); setSelVertex(idx); setD({ kind: 'vertex', maskId: editMask.id, idx, key }); return; }
    if (h.startsWith('t:') && editMask && single) { const [, i, w] = h.split(':'); setD({ kind: 'tangent', maskId: editMask.id, idx: Number(i), which: w as 'i' | 'o', key }); return; }
    if (single && h === 'anchor') { setD({ kind: 'anchor', id: single.id, key }); return; }
    if (single && h.startsWith('s:')) {
      const [, mx, my] = h.split(':').map(Number);
      const [x0, y0, x1, y1] = contentBounds(project, comp, single, time);
      const corner: P = [mx < 0 ? x0 : mx > 0 ? x1 : (x0 + x1) / 2, my < 0 ? y0 : my > 0 ? y1 : (y0 + y1) / 2];
      setD({ kind: 'scale', id: single.id, corner, mask: [mx !== 0 ? 1 : 0, my !== 0 ? 1 : 0], s0: propAt(single.transform.scale, time - single.start), key });
      return;
    }
    if (single && h.startsWith('r:')) {
      const a = propAt(single.transform.anchor, time - single.start);
      const c = apply(worldMatrix(comp, single, time), [a[0], a[1]]);
      setD({ kind: 'rotate', id: single.id, center: c, a0: Math.atan2(pt[1] - c[1], pt[0] - c[0]), r0: propAt(single.transform.rotation, time - single.start), key });
      return;
    }
    const hit = pick(project, comp, pt, time);
    if (e.altKey && single && hit?.id === single.id) { setD({ kind: 'anchor', id: single.id, key }); return; }
    if (!hit) { if (!e.shiftKey) S().set({ selectedLayers: [], selectedMask: null }); setSelVertex(null); return; }
    let ids = sel;
    if (e.shiftKey) { ids = sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]; S().select(ids); }
    else if (!sel.includes(hit.id)) { ids = [hit.id]; S().select(ids); }
    const items = comp.layers.filter((l) => ids.includes(l.id) && !l.locked).map((l) => ({ id: l.id, pos: propAt(l.transform.position, time - l.start), pinv: inv(parentMatrix(comp, l, time)) }));
    setD({ kind: 'move', start: pt, items, key });
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const pt = toComp(e);
    if (tool === 'pen' || tool === 'maskPen') setHoverPt(pt);
    if (!d) return;
    switch (d.kind) {
      case 'pan': { onPan(e.clientX - d.x, e.clientY - d.y); d.x = e.clientX; d.y = e.clientY; break; }
      case 'move': {
        let delta = sub(pt, d.start);
        if (e.shiftKey) delta = Math.abs(delta[0]) > Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]];
        writeProps(d.items.map((it) => {
          const ld = applyLinear(it.pinv, delta);
          return { layerId: it.id, path: 'transform.position', value: [it.pos[0] + ld[0], it.pos[1] + ld[1], it.pos[2]] };
        }), 'Move', d.key);
        break;
      }
      case 'scale': {
        const l = comp.layers.find((x) => x.id === d.id)!;
        const lt = time - l.start;
        const pos = propAt(l.transform.position, lt), rot = propAt(l.transform.rotation, lt), a = propAt(l.transform.anchor, lt);
        const q = apply(inv(mul(mul(parentMatrix(comp, l, time), translate(pos[0], pos[1])), rotate(rot[2]))), pt);
        const cr: P = [d.corner[0] - a[0], d.corner[1] - a[1]];
        let rx = Math.abs(cr[0]) > 1e-6 ? q[0] / cr[0] : d.s0[0] / 100;
        let ry = Math.abs(cr[1]) > 1e-6 ? q[1] / cr[1] : d.s0[1] / 100;
        if (!d.mask[0]) rx = d.s0[0] / 100;
        if (!d.mask[1]) ry = d.s0[1] / 100;
        if (e.shiftKey && d.mask[0] && d.mask[1]) { const m = (Math.abs(rx) + Math.abs(ry)) / 2; rx = Math.sign(rx || 1) * m; ry = Math.sign(ry || 1) * m; }
        writeProps([{ layerId: l.id, path: 'transform.scale', value: [rx * 100, ry * 100, d.s0[2]] }], 'Scale', d.key);
        break;
      }
      case 'rotate': {
        let deg = d.r0[2] + ((Math.atan2(pt[1] - d.center[1], pt[0] - d.center[0]) - d.a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        writeProps([{ layerId: d.id, path: 'transform.rotation', value: [d.r0[0], d.r0[1], deg] }], 'Rotate', d.key);
        break;
      }
      case 'anchor': {
        const l = comp.layers.find((x) => x.id === d.id)!;
        const lt = time - l.start;
        const a = propAt(l.transform.anchor, lt), pos = propAt(l.transform.position, lt);
        const na = apply(inv(worldMatrix(comp, l, time)), pt);
        const np = apply(inv(parentMatrix(comp, l, time)), pt);
        writeProps([
          { layerId: l.id, path: 'transform.anchor', value: [na[0], na[1], a[2]] },
          { layerId: l.id, path: 'transform.position', value: [np[0], np[1], pos[2]] },
        ], 'Move Anchor Point', d.key);
        break;
      }
      case 'rubber': setD({ ...d, cur: pt }); break;
      case 'penHandle': {
        const v = pen[d.idx];
        if (!v) break;
        const o = sub(pt, v.p as P);
        if (Math.hypot(o[0], o[1]) < 2 / z) break;
        setPen(pen.map((x, i) => (i === d.idx ? { ...x, o, i: [-o[0], -o[1]] } : x)));
        break;
      }
      case 'vertex': case 'tangent': {
        if (!single || !editMask) break;
        const m = inv(worldMatrix(comp, single, time));
        const lp = apply(m, pt);
        const path = propAt(editMask.path, time - single.start);
        const verts = path.vertices.map((v) => ({ p: [...v.p] as P, i: [...v.i] as P, o: [...v.o] as P }));
        const v = verts[d.idx];
        if (!v) break;
        if (d.kind === 'vertex') v.p = lp;
        else {
          const t = sub(lp, v.p);
          v[d.which] = t;
          if (!e.altKey) v[d.which === 'o' ? 'i' : 'o'] = [-t[0], -t[1]];
        }
        writeProps([{ layerId: single.id, path: `masks.${d.maskId}.path`, value: { ...path, vertices: verts } }], 'Edit Mask Path', d.key);
        break;
      }
      case 'orbit': {
        const dx = (e.clientX - d.x) * 0.4, dy = (e.clientY - d.y) * 0.4;
        const off = [d.pos0[0] - d.poi[0], d.pos0[1] - d.poi[1], d.pos0[2] - d.poi[2]];
        const r = Math.hypot(off[0], off[1], off[2]) || 1;
        let yaw = Math.atan2(off[0], -off[2]) + (dx * Math.PI) / 180;
        let pitch = Math.asin(Math.max(-1, Math.min(1, off[1] / r))) + (dy * Math.PI) / 180;
        pitch = Math.max(-1.45, Math.min(1.45, pitch));
        yaw = yaw % (Math.PI * 2);
        const np: Vec3 = [d.poi[0] + r * Math.cos(pitch) * Math.sin(yaw), d.poi[1] + r * Math.sin(pitch), d.poi[2] - r * Math.cos(pitch) * Math.cos(yaw)];
        writeProps([{ layerId: d.camId, path: 'transform.position', value: np }], 'Orbit Camera', d.key);
        break;
      }
      case 'guide': {
        const g = guides[d.idx];
        if (!g) break;
        setGuides(guides.map((x, i) => (i === d.idx ? { ...x, pos: Math.round(g.axis === 'x' ? pt[0] : pt[1]) } : x)));
        break;
      }
    }
  }

  function onUp(e: React.PointerEvent) {
    const d = dragRef.current;
    setD(null);
    if (!d) return;
    if (d.kind === 'rubber') {
      if (tool === 'maskRect' || tool === 'maskEllipse') void addMaskRect(d.start, toComp(e), tool === 'maskEllipse');
      else void drawShape(d.start, toComp(e), e.shiftKey);
    }
    if (d.kind === 'guide') {
      const g = guides[d.idx];
      if (g && (g.pos < -10 || g.pos > (g.axis === 'x' ? comp.width : comp.height) + 10)) setGuides(guides.filter((_, i) => i !== d.idx));
    }
  }

  function onDouble(e: React.MouseEvent) {
    const pt = toComp(e);
    if (tool === 'select' && editMask && single) {
      // Insert a vertex on the nearest segment.
      const lp = apply(inv(worldMatrix(comp, single, time)), pt);
      const path = propAt(editMask.path, time - single.start);
      const n = path.vertices.length;
      let best = 0, bd = Infinity;
      for (let i = 0; i < (path.closed ? n : n - 1); i++) {
        const a = path.vertices[i].p, b = path.vertices[(i + 1) % n].p;
        const ab = sub(b as P, a as P), ap = sub(lp, a as P);
        const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1)));
        const dd = dist(lp, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
        if (dd < bd) { bd = dd; best = i; }
      }
      if (bd * z > 20) return;
      const verts = [...path.vertices];
      verts.splice(best + 1, 0, { p: lp, i: [0, 0], o: [0, 0] });
      writeProps([{ layerId: single.id, path: `masks.${editMask.id}.path`, value: { ...path, vertices: verts } }], 'Add Mask Vertex');
      return;
    }
    if (tool === 'select') {
      const hit = pick(project, comp, pt, time);
      if (hit?.kind.type === 'text') setTextEdit({ layerId: hit.id, value: propAt(hit.kind.text, time - hit.start) });
      else if (hit?.kind.type === 'comp') {
        const id = hit.kind.comp;
        S().set({ compId: id, compStack: [...S().compStack.filter((c) => c !== id), id], selectedLayers: [], selectedMask: null, time: 0 });
      }
    }
  }

  // ------------------------------------------------------------ drawing
  const box = (l: Layer, emphasis: boolean) => {
    const m = worldMatrix(comp, l, time);
    const [x0, y0, x1, y1] = contentBounds(project, comp, l, time);
    const pts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as P[]).map((p) => apply(m, p));
    const a = propAt(l.transform.anchor, time - l.start);
    const ac = apply(m, [a[0], a[1]]);
    const handles: { id: string; p: P }[] = [];
    if (emphasis && !l.locked) {
      for (const [mx, my] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
        handles.push({ id: `s:${mx}:${my}`, p: apply(m, [mx < 0 ? x0 : mx > 0 ? x1 : (x0 + x1) / 2, my < 0 ? y0 : my > 0 ? y1 : (y0 + y1) / 2]) });
      }
    }
    return (
      <g key={l.id}>
        <polygon points={pts.map((p) => p.join(',')).join(' ')} className={`ov-box ${l.is3d ? 'ov-3d' : ''}`} />
        {handles.slice(0, 4).map((hd) => <circle key={`r${hd.id}`} data-h={`r:${hd.id}`} cx={hd.p[0]} cy={hd.p[1]} r={hs * 3.2} className="ov-rot" />)}
        {handles.map((hd) => <rect key={hd.id} data-h={hd.id} x={hd.p[0] - hs} y={hd.p[1] - hs} width={hs * 2} height={hs * 2} className="ov-handle" />)}
        {emphasis && (
          <g data-h="anchor" className="ov-anchor">
            <circle cx={ac[0]} cy={ac[1]} r={hs * 1.4} />
            <line x1={ac[0] - hs * 2.6} y1={ac[1]} x2={ac[0] + hs * 2.6} y2={ac[1]} />
            <line x1={ac[0]} y1={ac[1] - hs * 2.6} x2={ac[0]} y2={ac[1] + hs * 2.6} />
          </g>
        )}
      </g>
    );
  };

  const maskDraw = (l: Layer) => {
    const m = worldMatrix(comp, l, time);
    return l.masks.map((mk) => {
      const path = propAt(mk.path, time - l.start);
      const on = mk.id === selMask && l.id === single?.id;
      return (
        <g key={mk.id}>
          <path d={pathD(path, m)} data-h="mask" className={`ov-mask ${on ? 'on' : ''}`} onPointerDown={() => { if (tool === 'select') S().set({ selectedMask: mk.id }); }} />
          {on && tool === 'select' && path.vertices.map((v, i) => {
            const p = apply(m, v.p as P), po = apply(m, [v.p[0] + v.o[0], v.p[1] + v.o[1]]), pi = apply(m, [v.p[0] + v.i[0], v.p[1] + v.i[1]]);
            const hasT = v.o[0] || v.o[1] || v.i[0] || v.i[1];
            return (
              <g key={i}>
                {hasT && <><line x1={pi[0]} y1={pi[1]} x2={po[0]} y2={po[1]} className="ov-tan" />
                  <circle data-h={`t:${i}:i`} cx={pi[0]} cy={pi[1]} r={hs * 0.8} className="ov-tanh" />
                  <circle data-h={`t:${i}:o`} cx={po[0]} cy={po[1]} r={hs * 0.8} className="ov-tanh" /></>}
                <rect data-h={`v:${i}`} x={p[0] - hs * 0.9} y={p[1] - hs * 0.9} width={hs * 1.8} height={hs * 1.8} className={`ov-vtx ${selVertex === i ? 'on' : ''}`} />
              </g>
            );
          })}
        </g>
      );
    });
  };

  const rubber = drag?.kind === 'rubber' ? drag : null;
  const W = comp.width, H = comp.height;
  const gridStep = Math.max(10, Math.round(W / 16));
  const cursor = tool === 'hand' ? (drag ? 'grabbing' : 'grab') : ['rect', 'ellipse', 'polygon', 'star', 'pen', 'maskPen', 'maskRect', 'maskEllipse', 'track'].includes(tool) ? 'crosshair' : tool === 'text' ? 'text' : tool === 'orbit' ? 'move' : 'default';
  const textLayer = textEdit ? comp.layers.find((l) => l.id === textEdit.layerId) : undefined;
  let textPos: P | null = null;
  if (textLayer) { const b = contentBounds(project, comp, textLayer, time); const m = worldMatrix(comp, textLayer, time); textPos = apply(m, [b[0], b[3]]); }

  return (
    <div ref={ref} className="ov-root" style={{ cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDouble}>
      <svg className="ov-svg">
        <g transform={`translate(${view.left} ${view.top}) scale(${z})`}>
          {vflags.grid && (
            <g className="ov-grid">
              {Array.from({ length: Math.floor(W / gridStep) + 1 }, (_, i) => <line key={`gx${i}`} x1={i * gridStep} y1={0} x2={i * gridStep} y2={H} />)}
              {Array.from({ length: Math.floor(H / gridStep) + 1 }, (_, i) => <line key={`gy${i}`} x1={0} y1={i * gridStep} x2={W} y2={i * gridStep} />)}
            </g>
          )}
          {vflags.safe && (
            <g className="ov-safe">
              <rect x={W * 0.05} y={H * 0.05} width={W * 0.9} height={H * 0.9} />
              <rect x={W * 0.1} y={H * 0.1} width={W * 0.8} height={H * 0.8} />
              <line x1={W / 2 - 12 / z} y1={H / 2} x2={W / 2 + 12 / z} y2={H / 2} />
              <line x1={W / 2} y1={H / 2 - 12 / z} x2={W / 2} y2={H / 2 + 12 / z} />
            </g>
          )}
          {guides.map((g, i) => g.axis === 'x'
            ? <line key={i} data-h={`guide:${i}`} x1={g.pos} y1={-1e4} x2={g.pos} y2={1e4} className="ov-guide" />
            : <line key={i} data-h={`guide:${i}`} x1={-1e4} y1={g.pos} x2={1e4} y2={g.pos} className="ov-guide" />)}
          {selectedLayers.filter((l) => l.visible && time >= l.start && time < l.start + l.duration).map((l) => (
            <g key={l.id}>{maskDraw(l)}{box(l, !!single && tool === 'select' && !editMask)}</g>
          ))}
          {trackPts.map((tp, i) => {
            const l = comp.layers.find((x) => x.id === tp.layerId);
            if (!l) return null;
            const p = apply(worldMatrix(comp, l, time), tp.p);
            return (
              <g key={i} className="ov-track">
                <rect x={p[0] - 16} y={p[1] - 16} width={32} height={32} />
                <rect x={p[0] - 40} y={p[1] - 40} width={80} height={80} className="search" />
                <line x1={p[0] - 6} y1={p[1]} x2={p[0] + 6} y2={p[1]} /><line x1={p[0]} y1={p[1] - 6} x2={p[0]} y2={p[1] + 6} />
              </g>
            );
          })}
          {pen.length > 0 && (
            <g className="ov-pen">
              <path d={pathD({ closed: false, vertices: hoverPt && !drag ? [...pen, { p: hoverPt, i: [0, 0], o: [0, 0] }] : pen }, [1, 0, 0, 1, 0, 0])} />
              {pen.map((v, i) => <rect key={i} x={v.p[0] - hs} y={v.p[1] - hs} width={hs * 2} height={hs * 2} className={i === 0 ? 'first' : ''} />)}
            </g>
          )}
          {rubber && (
            tool === 'ellipse' || tool === 'maskEllipse'
              ? <ellipse className="ov-rubber" cx={(rubber.start[0] + rubber.cur[0]) / 2} cy={(rubber.start[1] + rubber.cur[1]) / 2} rx={Math.abs(rubber.cur[0] - rubber.start[0]) / 2} ry={Math.abs(rubber.cur[1] - rubber.start[1]) / 2} />
              : <rect className="ov-rubber" x={Math.min(rubber.start[0], rubber.cur[0])} y={Math.min(rubber.start[1], rubber.cur[1])} width={Math.abs(rubber.cur[0] - rubber.start[0])} height={Math.abs(rubber.cur[1] - rubber.start[1])} />
          )}
        </g>
      </svg>
      {textEdit && textPos && (
        <textarea
          className="ov-text" autoFocus value={textEdit.value}
          // Select the existing text so typing replaces the placeholder (and edits replace on retype).
          onFocus={(e) => e.currentTarget.select()}
          style={{ left: view.left + textPos[0] * z, top: view.top + textPos[1] * z + 6 }}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) commitText(); }}
          onBlur={commitText}
        />
      )}
    </div>
  );
}

/** Nudge selected layers in comp pixels (arrow keys). */
export function nudge(dx: number, dy: number) {
  const s = S();
  const comp = s.project?.compositions.find((c) => c.id === s.compId);
  if (!comp) return;
  const writes = comp.layers.filter((l) => s.selectedLayers.includes(l.id) && !l.locked).map((l) => {
    const pos = propAt(l.transform.position, s.time - l.start);
    const d = applyLinear(inv(parentMatrix(comp, l, s.time)), [dx, dy]);
    return { layerId: l.id, path: 'transform.position', value: [pos[0] + d[0], pos[1] + d[1], pos[2]] };
  });
  if (writes.length) writeProps(writes, 'Nudge', 'nudge');
}
