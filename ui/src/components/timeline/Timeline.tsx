import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Draft } from 'immer';
import {
  ArrowLeftRight, ArrowLeftToLine, ArrowRightToLine, BookmarkPlus, ChevronRight, Ghost, Magnet, Maximize2, Scissors, Zap, ZoomIn, ZoomOut,
} from 'lucide-react';
import './timeline.css';
import './tlactions';
import type { Asset, Composition, Layer, Transform, Prop } from '../../types/project';
import { draftComp, useComp, useEditor } from '../../store/editor';
import { NONE } from '../../store/editor';
import { addAssetLayer, openComp, splitAtPlayhead } from '../../lib/ops';
import { api, isTauri } from '../../lib/api';
import { formatTime, parseTime } from '../../lib/anim';
import { runAction } from '../../lib/actions';
import { SearchBox, Slider } from '../ui/primitives';
import { animatedProps, type AnimProp } from './model';
import { useTL, tlRefs, PROP_ROW_H, RULER_H } from './tlstore';
import { Ruler } from './Ruler';
import { LayerHeader, PropHeader, hasAudio } from './LayerHeader';
import { ClipRow, PropKeysRow } from './Tracks';
import { applyClipDrag, type ClipDrag, type DragMode } from './clipdrag';
import { isKeySelected, moveKeysFrom } from './keyops';
import { addMarker, fitTimeline, setWorkArea } from './tlactions';

const S = () => useEditor.getState();

type Row =
  | { kind: 'layer'; layer: Layer; index: number; y: number; h: number; keyTimes: number[] }
  | { kind: 'prop'; layer: Layer; ap: AnimProp; y: number; h: number };

const TRANSFORM_KEYS: (keyof Transform)[] = ['anchor', 'position', 'scale', 'rotation', 'opacity'];
const TRANSFORM_LABEL: Record<string, string> = { anchor: 'Anchor Point', position: 'Position', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity' };

export function Timeline() {
  const comp = useComp();
  if (!comp) return <div className="panel"><div className="empty">Open or create a project to start editing.</div></div>;
  return <TimelineInner comp={comp} />;
}

function TimelineInner({ comp }: { comp: Composition }) {
  const pps = useTL((s) => s.pps);
  const trackH = useTL((s) => s.trackH);
  const expanded = useTL((s) => s.expanded);
  const hideShy = useTL((s) => s.hideShy);
  const search = useTL((s) => s.search);
  const leftW = useTL((s) => s.leftW);
  const scrollY = useTL((s) => s.scrollY);
  const viewH = useTL((s) => s.viewH);
  const defs = useEditor((s) => s.effectDefs);
  const selected = useEditor((s) => s.selectedLayers);
  const assets = useEditor((s) => s.project?.assets ?? NONE);
  const scroller = useRef<HTMLDivElement>(null);
  const leftList = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropY, setDropY] = useState<number | null>(null);

  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  // ---- rows
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = 0;
    const q = search.trim().toLowerCase();
    comp.layers.forEach((layer, index) => {
      if (hideShy && layer.shy) return;
      if (q && !layer.name.toLowerCase().includes(q)) return;
      const props = animatedProps(layer, defs);
      const keyTimes = expanded[layer.id] ? [] : [...new Set(props.flatMap((p) => (p.prop.keys ?? []).map((k) => +(layer.start + k.t).toFixed(4))))];
      out.push({ kind: 'layer', layer, index, y, h: trackH, keyTimes });
      y += trackH;
      if (expanded[layer.id]) {
        const list: AnimProp[] = [...props];
        // Always offer the transform properties so they can be keyframed from here.
        for (const k of TRANSFORM_KEYS) {
          const path = `transform.${k}`;
          if (!list.some((p) => p.path === path)) list.push({ path, label: TRANSFORM_LABEL[k], prop: layer.transform[k] as Prop<unknown> });
        }
        list.sort((a, b) => (a.path.startsWith('transform') ? TRANSFORM_KEYS.indexOf(a.path.split('.')[1] as keyof Transform) : 10) - (b.path.startsWith('transform') ? TRANSFORM_KEYS.indexOf(b.path.split('.')[1] as keyof Transform) : 10));
        for (const ap of list) {
          out.push({ kind: 'prop', layer, ap, y, h: PROP_ROW_H });
          y += PROP_ROW_H;
        }
      }
    });
    return { rows: out, height: y };
  }, [comp.layers, defs, expanded, trackH, hideShy, search]);

  const visible = rows.rows.filter((r) => r.y + r.h >= scrollY - 100 && r.y <= scrollY + viewH + 100);
  const contentW = Math.max(comp.duration * pps + 400, 2000);

  // ---- viewport tracking
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    tlRefs.scroller = el;
    const ro = new ResizeObserver(() => useTL.getState().set({ viewW: el.clientWidth, viewH: el.clientHeight }));
    ro.observe(el);
    useTL.getState().set({ viewW: el.clientWidth, viewH: el.clientHeight });
    return () => { ro.disconnect(); if (tlRefs.scroller === el) tlRefs.scroller = null; };
  }, []);

  // Fit the first time a composition is shown.
  useEffect(() => { const h = window.setTimeout(fitTimeline, 30); return () => window.clearTimeout(h); }, [comp.id]);

  const onScroll = () => {
    const el = scroller.current!;
    useTL.getState().set({ scrollX: el.scrollLeft, scrollY: el.scrollTop });
    if (leftList.current) leftList.current.scrollTop = el.scrollTop;
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current!;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const tAt = (el.scrollLeft + cx) / pps;
      const np = Math.max(1, Math.min(4000, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      useTL.getState().set({ pps: np });
      requestAnimationFrame(() => { el.scrollLeft = tAt * np - cx; });
    } else if (e.shiftKey) {
      el.scrollLeft += e.deltaY;
    }
  };

  // ---- clip dragging
  const onClipDown = useCallback((e: React.PointerEvent, id: string, mode: DragMode) => {
    e.stopPropagation();
    const s = S();
    const c = s.project?.compositions.find((x) => x.id === s.compId);
    const layer = c?.layers.find((l) => l.id === id);
    if (!layer || !s.project) return;
    let sel = s.selectedLayers;
    const wasSelected = sel.includes(id);
    if (e.shiftKey) { s.select([...new Set([...sel, id])]); sel = [...new Set([...sel, id])]; }
    else if (!wasSelected) { s.select(e.ctrlKey ? [...sel, id] : [id]); sel = e.ctrlKey ? [...sel, id] : [id]; }
    if (layer.locked) return;
    const drag: ClipDrag = { mode, layerId: id, ids: mode === 'move' ? sel.filter((x) => !c!.layers.find((l) => l.id === x)?.locked) : sel.slice(0, 2), snapshot: s.project, x0: e.clientX, coalesce: `clip-${id}-${Date.now()}` };
    if (mode !== 'trimL' && mode !== 'trimR') drag.ids = mode === 'move' ? drag.ids : [id];
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - drag.x0) < 3) return;
      started = true;
      applyClipDrag(drag, ev.clientX, ev.altKey && mode !== 'slip');
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      // Ctrl+click (no drag) toggles selection; Ctrl+drag is a slide edit.
      if (!started && e.ctrlKey && wasSelected) S().select(S().selectedLayers.filter((x) => x !== id));
      // Plain click on an already-selected clip in a multi-selection selects just that clip.
      else if (!started && !e.ctrlKey && !e.shiftKey && wasSelected && S().selectedLayers.length > 1) S().select([id]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const onTransitionDown = useCallback((e: React.PointerEvent, id: string, side: 'transitionIn' | 'transitionOut') => {
    const x0 = e.clientX;
    const c = S().project?.compositions.find((x) => x.id === S().compId);
    const l = c?.layers.find((x) => x.id === id);
    const tr = l?.[side];
    if (!c || !l || !tr) return;
    const coalesce = `tr-${id}-${Date.now()}`;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / useTL.getState().pps;
      const nd = Math.max(1 / c.fps, Math.min(l.duration, Math.round((tr.duration + (side === 'transitionIn' ? dx : -dx)) * c.fps) / c.fps));
      S().edit('Transition Duration', (d) => { const dl = draftComp(d)?.layers.find((x) => x.id === id); if (dl?.[side]) dl[side]!.duration = nd; }, coalesce);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // ---- keyframe dragging
  const onKeyDown = useCallback((e: React.PointerEvent, layerId: string, path: string, t: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = S();
    let sel = s.selectedKeys;
    const already = isKeySelected(sel, layerId, path, t);
    if (e.shiftKey) sel = already ? sel.filter((k) => !(k.layerId === layerId && k.path === path && Math.abs(k.t - t) < 1e-3)) : [...sel, { layerId, path, t }];
    else if (!already) sel = [{ layerId, path, t }];
    s.set({ selectedKeys: sel, selectedLayers: s.selectedLayers.includes(layerId) ? s.selectedLayers : [layerId] });
    if (!s.project) return;
    const snapshot = s.project;
    const fps = s.project.compositions.find((c) => c.id === s.compId)?.fps ?? 30;
    const x0 = e.clientX;
    const coalesce = `keys-${Date.now()}`;
    let started = false;
    const startSel = sel;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - x0) < 3) return;
      started = true;
      const dt = Math.round(((ev.clientX - x0) / useTL.getState().pps) * fps) / fps;
      const ns = moveKeysFrom(snapshot, startSel, dt, fps, ev.altKey, coalesce);
      S().set({ selectedKeys: ns });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // ---- header selection + reorder
  const onHeaderDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const s = S();
    const c = s.project?.compositions.find((x) => x.id === s.compId);
    if (!c) return;
    if (e.ctrlKey) { s.select(s.selectedLayers.includes(id) ? s.selectedLayers.filter((x) => x !== id) : [...s.selectedLayers, id]); return; }
    if (e.shiftKey && s.selectedLayers.length) {
      const ids = c.layers.map((l) => l.id);
      const a = ids.indexOf(s.selectedLayers[s.selectedLayers.length - 1]), b = ids.indexOf(id);
      s.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      return;
    }
    if (!s.selectedLayers.includes(id)) s.select([id]);
    const y0 = e.clientY;
    const list = leftList.current!;
    let dragging = false;
    let target: number | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - y0) < 5) return;
      dragging = true;
      const y = ev.clientY - list.getBoundingClientRect().top + list.scrollTop;
      const layerRows = rowsRef.current.filter((r) => r.kind === 'layer') as Extract<Row, { kind: 'layer' }>[];
      let idx = layerRows.length ? layerRows[layerRows.length - 1].index + 1 : 0;
      let lineY = layerRows.length ? layerRows[layerRows.length - 1].y + layerRows[layerRows.length - 1].h : 0;
      for (const r of layerRows) { if (y < r.y + r.h / 2) { idx = r.index; lineY = r.y; break; } }
      target = idx;
      setDropY(lineY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDropY(null);
      if (!dragging) { if (!e.shiftKey && !e.ctrlKey) S().select([id]); return; }
      if (target == null) return;
      const ids = S().selectedLayers;
      const tgt = target;
      S().edit('Reorder Layers', (d) => {
        const dc = draftComp(d);
        if (!dc) return;
        const before = dc.layers[tgt]?.id;
        const moving = dc.layers.filter((l) => ids.includes(l.id));
        const rest = dc.layers.filter((l) => !ids.includes(l.id));
        let at = before ? rest.findIndex((l) => l.id === before) : rest.length;
        if (at < 0) at = rest.length;
        rest.splice(at, 0, ...moving);
        dc.layers = rest as Draft<Layer>[];
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
  const rowsRef = useRef(rows.rows);
  rowsRef.current = rows.rows;

  // ---- background: marquee keyframe selection / deselect
  const onBgDown = (e: React.PointerEvent) => {
    if (e.button === 1) { // middle-drag pans
      const el = scroller.current!;
      const x0 = e.clientX, y0 = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
      const move = (ev: PointerEvent) => { el.scrollLeft = sl - (ev.clientX - x0); el.scrollTop = st - (ev.clientY - y0); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const pt = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - rect.left + el.scrollLeft, y: ev.clientY - rect.top + el.scrollTop });
    const p0 = pt(e);
    let moved = false;
    const base = e.shiftKey ? S().selectedKeys : [];
    const move = (ev: PointerEvent) => {
      const p = pt(ev);
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
      moved = true;
      setMarquee({ x0: p0.x, y0: p0.y, x1: p.x, y1: p.y });
      const [xa, xb] = [Math.min(p0.x, p.x), Math.max(p0.x, p.x)], [ya, yb] = [Math.min(p0.y, p.y), Math.max(p0.y, p.y)];
      const out = [...base];
      for (const r of rowsRef.current) {
        if (r.kind !== 'prop' || r.y + r.h < ya || r.y > yb) continue;
        for (const k of r.ap.prop.keys ?? []) {
          const kx = (r.layer.start + k.t) * useTL.getState().pps;
          if (kx >= xa && kx <= xb && !isKeySelected(out, r.layer.id, r.ap.path, k.t)) out.push({ layerId: r.layer.id, path: r.ap.path, t: k.t });
        }
      }
      S().set({ selectedKeys: out });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setMarquee(null);
      if (!moved) S().set({ selectedKeys: [], selectedLayers: e.shiftKey ? S().selectedLayers : [] });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---- drop media from the media panel (HTML drag with asset id) onto the timeline
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('application/x-veyra-asset');
    if (!id) return;
    e.preventDefault();
    const el = scroller.current!;
    const t = Math.max(0, (e.clientX - el.getBoundingClientRect().left + el.scrollLeft) / pps);
    const asset = S().project?.assets.find((a) => a.id === id);
    if (asset) addAssetLayer(asset, Math.round(t * comp.fps) / comp.fps).catch((err) => S().toast('error', 'Could not add media', String(err)));
  };

  const splitLeft = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = leftW;
    const move = (ev: PointerEvent) => useTL.getState().set({ leftW: Math.max(260, Math.min(700, w0 + ev.clientX - x0)) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (
    <div className="panel tl-root" onWheel={onWheel}>
      <Toolbar comp={comp} />
      <div className="tl-main">
        <div className="tl-left" style={{ width: leftW }}>
          <div className="tl-left-head" style={{ height: RULER_H }}>
            <Breadcrumb />
            <span className="grow" />
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{comp.layers.length} layers</span>
          </div>
          <div className="tl-left-list" ref={leftList}>
            <div style={{ height: rows.height + 200, position: 'relative' }}>
              {visible.map((r) => (
                <div key={r.kind === 'layer' ? r.layer.id : `${r.layer.id}|${r.ap.path}`} style={{ position: 'absolute', top: r.y, left: 0, right: 0 }}>
                  {r.kind === 'layer'
                    ? <LayerHeader layer={r.layer} comp={comp} index={r.index} selected={selected.includes(r.layer.id)} expanded={!!expanded[r.layer.id]} height={r.h} audio={hasAudio(r.layer, comp, assets)} onPointerDown={onHeaderDown} />
                    : <PropHeader layer={r.layer} ap={r.ap} height={r.h} />}
                </div>
              ))}
              {dropY != null && <div className="tl-drop" style={{ top: dropY }} />}
            </div>
          </div>
          <div className="tl-splitter" onPointerDown={splitLeft} title="Resize" />
        </div>
        <div className="tl-right">
          <Ruler comp={comp} />
          <div className="tl-scroller" ref={scroller} onScroll={onScroll} onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-veyra-asset')) e.preventDefault(); }} onDrop={onDrop}>
            <div className="tl-content" style={{ width: contentW, height: rows.height + 200 }} onPointerDown={onBgDown}>
              <div className="tl-end" style={{ left: comp.duration * pps }} />
              {comp.workArea && <><div className="tl-wa-shade" style={{ left: 0, width: comp.workArea[0] * pps }} /><div className="tl-wa-shade" style={{ left: comp.workArea[1] * pps, right: 0 }} /></>}
              {visible.map((r) => r.kind === 'layer' ? (
                <div key={r.layer.id} className={`tl-track ${selected.includes(r.layer.id) ? 'sel' : ''}`} style={{ top: r.y, height: r.h }}>
                  <ClipRow layer={r.layer} asset={layerAsset(r.layer, assetMap)} height={r.h} selected={selected.includes(r.layer.id)} pps={pps} keyTimes={r.keyTimes} onClipDown={onClipDown} onTransitionDown={onTransitionDown} />
                </div>
              ) : (
                <div key={`${r.layer.id}|${r.ap.path}`} className="tl-track prop" style={{ top: r.y, height: r.h }}>
                  <PropKeysRow layer={r.layer} ap={r.ap} height={r.h} pps={pps} onKeyDown={onKeyDown} />
                </div>
              ))}
              {comp.markers.map((m) => <div key={m.id} className="tl-marker-line" style={{ left: m.t * pps }} />)}
              {marquee && <div className="tl-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
              {comp.layers.length === 0 && <div className="tl-empty-hint">Drag media here from the Media panel or Windows Explorer</div>}
            </div>
          </div>
          <Playhead fps={comp.fps} />
        </div>
      </div>
    </div>
  );
}

function layerAsset(l: Layer, m: Map<string, Asset>) {
  return l.kind.type === 'media' || l.kind.type === 'audio' ? m.get(l.kind.asset) : undefined;
}

const Playhead = memo(function Playhead({ fps }: { fps: number }) {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const pps = useTL((s) => s.pps);
  const scrollX = useTL((s) => s.scrollX);
  const viewW = useTL((s) => s.viewW);
  const x = time * pps - scrollX;
  useEffect(() => {
    const el = tlRefs.scroller;
    if (!el) return;
    const px = time * pps;
    if (playing && (px > el.scrollLeft + el.clientWidth * 0.92 || px < el.scrollLeft)) el.scrollLeft = px - el.clientWidth * 0.08;
  }, [time, playing, pps]);
  void fps;
  if (x < -2 || x > viewW + 2) return null;
  return (
    <div className="tl-playhead" style={{ transform: `translateX(${x}px)` }}>
      <span className="tl-playhead-head" />
    </div>
  );
});

function Breadcrumb() {
  const stack = useEditor((s) => s.compStack);
  const compId = useEditor((s) => s.compId);
  const comps = useEditor((s) => s.project?.compositions ?? NONE);
  const chain = stack.length ? stack : [compId];
  return (
    <span className="tl-crumbs">
      {chain.map((id, i) => {
        const c = comps.find((x) => x.id === id);
        if (!c) return null;
        return (
          <span key={id} className="row" style={{ gap: 2 }}>
            {i > 0 && <ChevronRight size={11} className="muted" />}
            <button className={`tl-crumb ${id === compId ? 'on' : ''}`} onClick={() => openComp(id)} title={`${c.width}×${c.height} · ${c.fps} fps`}>{c.name}</button>
          </span>
        );
      })}
    </span>
  );
}

function TimeDisplay({ comp }: { comp: Composition }) {
  const time = useEditor((s) => s.time);
  const mode = useEditor((s) => s.settings?.timeDisplay ?? 'timecode');
  const [edit, setEdit] = useState<string | null>(null);
  if (edit != null) {
    return (
      <input className="input mono tl-tc-input" autoFocus value={edit} onChange={(e) => setEdit(e.target.value)}
        onBlur={() => setEdit(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { const t = parseTime(edit, comp.fps); if (t != null) S().setTime(t); setEdit(null); }
          if (e.key === 'Escape') setEdit(null);
        }} />
    );
  }
  return (
    <button className="tl-tc mono" title="Current time — click to type (timecode, frames, or 2.5s)" onClick={() => setEdit(formatTime(time, comp.fps, mode))}>
      {formatTime(time, comp.fps, mode)}
    </button>
  );
}

function Toolbar({ comp }: { comp: Composition }) {
  const snapping = useEditor((s) => s.snapping);
  const ripple = useTL((s) => s.ripple);
  const hideShy = useTL((s) => s.hideShy);
  const search = useTL((s) => s.search);
  const pps = useTL((s) => s.pps);
  const trackH = useTL((s) => s.trackH);
  const settings = useEditor((s) => s.settings);
  const autoRender = !!settings?.backgroundRender;
  const zoomV = Math.log(pps) / Math.log(4000);
  return (
    <div className="panel-head tl-toolbar">
      <TimeDisplay comp={comp} />
      <span className="muted mono" style={{ fontSize: 'var(--fs-xs)' }}>{comp.fps} fps</span>
      <span className="vsep" />
      <button className={`icon-btn ${snapping ? 'active' : ''}`} title="Snapping (N)" onClick={() => S().set({ snapping: !snapping })}><Magnet size={14} /></button>
      <button className={`icon-btn ${ripple ? 'active' : ''}`} title="Ripple editing: trims and deletes close gaps" onClick={() => useTL.getState().set({ ripple: !ripple })}><ArrowLeftRight size={14} /></button>
      <button className="icon-btn" title="Split at playhead (S)" onClick={() => splitAtPlayhead()}><Scissors size={14} /></button>
      <button className="icon-btn" title="Add marker (M)" onClick={() => addMarker()}><BookmarkPlus size={14} /></button>
      <button className="icon-btn" title="Set work area start (I)" onClick={() => setWorkArea('in')}><ArrowLeftToLine size={14} /></button>
      <button className="icon-btn" title="Set work area end (O)" onClick={() => setWorkArea('out')}><ArrowRightToLine size={14} /></button>
      <button className={`icon-btn ${hideShy ? 'active' : ''}`} title="Hide shy layers" onClick={() => useTL.getState().set({ hideShy: !hideShy })}><Ghost size={14} /></button>
      <button className="btn sm ghost" title="Render the work area once for smooth playback (Enter). Kept in memory only." disabled={!isTauri}
        onClick={() => runAction('playback.renderPreview')}>
        <Zap size={12} /> Render preview
      </button>
      <button className={`btn sm ${autoRender ? 'primary' : 'ghost'}`} disabled={!isTauri || !settings}
        title={autoRender ? 'Auto render is ON: after each edit, the work area is rendered ahead in memory. Click to turn off.' : 'Auto render is OFF: the preview renders live as it plays. Click to render ahead automatically after each edit (uses memory).'}
        onClick={() => { if (!settings) return; const next = { ...settings, backgroundRender: !autoRender }; S().set({ settings: next }); void api.setSettings(next); if (autoRender) void api.stopPrerender(); }}>
        Auto
      </button>
      <span className="grow" />
      <div style={{ width: 170 }}><SearchBox value={search} onChange={(v) => useTL.getState().set({ search: v })} placeholder="Filter layers" /></div>
      <span className="vsep" />
      <span className="label" title="Track height">H</span>
      <Slider value={trackH} min={22} max={80} step={1} width={60} onChange={(v) => useTL.getState().set({ trackH: v })} />
      <button className="icon-btn" title="Zoom out (-)" onClick={() => useTL.getState().set({ pps: Math.max(1, pps / 1.4) })}><ZoomOut size={14} /></button>
      <Slider value={zoomV} min={0} max={1} step={0.001} width={90} onChange={(v) => useTL.getState().set({ pps: Math.max(1, Math.pow(4000, v)) })} />
      <button className="icon-btn" title="Zoom in (=)" onClick={() => useTL.getState().set({ pps: Math.min(4000, pps * 1.4) })}><ZoomIn size={14} /></button>
      <button className="icon-btn" title="Fit composition (Shift+Z)" onClick={fitTimeline}><Maximize2 size={14} /></button>
    </div>
  );
}
