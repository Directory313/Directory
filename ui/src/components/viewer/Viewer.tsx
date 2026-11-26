// Composition viewer: GPU-rendered frames, zoom/pan, overlays, tools and transport controls.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Box, ChevronLeft, ChevronRight, Circle, Crosshair, Grid3x3, Hand, MousePointer2, Orbit, PenTool, Play, Pause,
  Repeat, Ruler, ScanLine, SkipBack, SkipForward, Square, Star, StepBack, StepForward, Type, Hexagon, Layers, ZoomIn, CircleDashed, SquareDashed, Spline,
} from 'lucide-react';
import { useComp, useEditor, type Tool } from '../../store/editor';
import { api, isTauri } from '../../lib/api';
import { formatTime } from '../../lib/anim';
import { registerActions } from '../../lib/actions';
import { adaptiveFactor, frameShown, goTo, onAdaptiveChange, step, toggle } from '../../lib/playback';
import { Select } from '../ui/primitives';
import { Overlay, nudge, type Guide, type TrackPoint } from './Overlay';
import { TrackPanel } from './TrackPanel';
import './viewer.css';

const S = () => useEditor.getState();

const TOOLS: { id: Tool; icon: typeof Hand; label: string; key?: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select / Transform', key: 'V' },
  { id: 'hand', icon: Hand, label: 'Hand (pan)', key: 'H' },
  { id: 'zoom', icon: ZoomIn, label: 'Zoom (click in, Alt-click out)', key: 'Z' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'rect', icon: Square, label: 'Rectangle (Shift = square)', key: 'Q' },
  { id: 'ellipse', icon: Circle, label: 'Ellipse (Shift = circle)' },
  { id: 'polygon', icon: Hexagon, label: 'Polygon' },
  { id: 'star', icon: Star, label: 'Star' },
  { id: 'pen', icon: PenTool, label: 'Pen (click points, drag for curves, Enter to finish)', key: 'G' },
  { id: 'maskRect', icon: SquareDashed, label: 'Rectangle Mask on selected layer' },
  { id: 'maskEllipse', icon: CircleDashed, label: 'Ellipse Mask on selected layer' },
  { id: 'maskPen', icon: Spline, label: 'Pen Mask on selected layer' },
  { id: 'track', icon: Crosshair, label: 'Point Tracker' },
  { id: 'orbit', icon: Orbit, label: 'Orbit active camera (3D)' },
];

registerActions([
  ...TOOLS.filter((t) => t.key).map((t) => ({ id: `tool.${t.id}`, label: `Tool: ${t.label}`, group: 'Tools', shortcut: t.key, run: () => S().set({ tool: t.id }) })),
  { id: 'viewer.nudgeLeft', label: 'Nudge Left', group: 'Viewer', shortcut: 'ArrowLeft', run: () => nudge(-1, 0), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeRight', label: 'Nudge Right', group: 'Viewer', shortcut: 'ArrowRight', run: () => nudge(1, 0), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeUp', label: 'Nudge Up', group: 'Viewer', shortcut: 'ArrowUp', run: () => nudge(0, -1), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeDown', label: 'Nudge Down', group: 'Viewer', shortcut: 'ArrowDown', run: () => nudge(0, 1), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeLeft10', label: 'Nudge Left ×10', group: 'Viewer', shortcut: 'Shift+ArrowLeft', run: () => nudge(-10, 0), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeRight10', label: 'Nudge Right ×10', group: 'Viewer', shortcut: 'Shift+ArrowRight', run: () => nudge(10, 0), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeUp10', label: 'Nudge Up ×10', group: 'Viewer', shortcut: 'Shift+ArrowUp', run: () => nudge(0, -10), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.nudgeDown10', label: 'Nudge Down ×10', group: 'Viewer', shortcut: 'Shift+ArrowDown', run: () => nudge(0, 10), enabled: () => S().selectedLayers.length > 0 },
  { id: 'viewer.fit', label: 'Zoom to Fit', group: 'Viewer', shortcut: 'Shift+?', run: () => S().set({ viewer: { ...S().viewer, zoom: 0, panX: 0, panY: 0 } }) },
  { id: 'viewer.zoom100', label: 'Zoom 100%', group: 'Viewer', shortcut: '/', run: () => S().set({ viewer: { ...S().viewer, zoom: 1, panX: 0, panY: 0 } }) },
  { id: 'viewer.safe', label: 'Toggle Safe Areas', group: 'Viewer', shortcut: "'", run: () => S().set({ viewer: { ...S().viewer, safe: !S().viewer.safe } }) },
  { id: 'viewer.grid', label: 'Toggle Grid', group: 'Viewer', shortcut: 'Ctrl+\'', run: () => S().set({ viewer: { ...S().viewer, grid: !S().viewer.grid } }) },
  { id: 'viewer.rulers', label: 'Toggle Rulers', group: 'Viewer', shortcut: 'Ctrl+R', run: () => S().set({ viewer: { ...S().viewer, rulers: !S().viewer.rulers } }) },
  { id: 'viewer.draft', label: 'Toggle Draft Preview', group: 'Viewer', run: () => S().set({ draft: !S().draft }) },
]);

const RULER = 18;

export function Viewer() {
  const comp = useComp();
  const time = useEditor((s) => s.time);
  const revision = useEditor((s) => s.revision);
  const previewScale = useEditor((s) => s.previewScale);
  const draft = useEditor((s) => s.draft);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const tool = useEditor((s) => s.tool);
  const vflags = useEditor((s) => s.viewer);
  const fps = useEditor((s) => s.playbackFps);
  const dropped = useEditor((s) => s.droppedFrames);
  const cached = useEditor((s) => (comp ? s.cached[comp.id] : undefined));
  const compStack = useEditor((s) => s.compStack);
  const project = useEditor((s) => s.project);
  const timeDisplay = useEditor((s) => s.settings?.timeDisplay ?? 'timecode');

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [frameInfo, setFrameInfo] = useState<{ w: number; h: number } | null>(null);
  const [trackPts, setTrackPts] = useState<TrackPoint[]>([]);
  const [guides, setGuidesState] = useState<Guide[]>([]);
  const [, force] = useState(0);
  const busy = useRef(false);
  const pending = useRef(false);

  useEffect(() => { const off = onAdaptiveChange(() => force((x) => x + 1)); return () => { off(); }; }, []);

  // Guides persist per composition.
  useEffect(() => {
    if (!comp) return;
    try { setGuidesState(JSON.parse(localStorage.getItem(`veyra.guides.${comp.id}`) ?? '[]')); } catch { setGuidesState([]); }
  }, [comp?.id]);
  const setGuides = (g: Guide[]) => {
    setGuidesState(g);
    if (comp) try { localStorage.setItem(`veyra.guides.${comp.id}`, JSON.stringify(g)); } catch { /* storage unavailable */ }
  };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------ frame requests (in-flight coalescing = natural frame skipping)
  const request = useCallback(async () => {
    if (busy.current) { pending.current = true; return; }
    busy.current = true;
    setRendering(true);
    try {
      do {
        pending.current = false;
        const s = S();
        const c = s.project?.compositions.find((x) => x.id === s.compId);
        if (!c || !isTauri) break;
        await s.ensureSynced();
        const st = S();
        const scale = Math.max(0.05, st.previewScale * (st.playing ? adaptiveFactor : 1));
        const f = await api.renderFrame(c.id, st.time, scale, st.draft);
        const cv = canvasRef.current;
        if (cv) {
          if (cv.width !== f.width || cv.height !== f.height) { cv.width = f.width; cv.height = f.height; }
          cv.getContext('2d')!.putImageData(new ImageData(f.data as Uint8ClampedArray<ArrayBuffer>, f.width, f.height), 0, 0);
          setFrameInfo({ w: f.width, h: f.height });
        }
        setError(null);
        frameShown();
      } while (pending.current);
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setRendering(false);
    }
  }, []);

  useEffect(() => { void request(); }, [request, comp?.id, time, revision, previewScale, draft, adaptiveFactor]);

  // Surface renderer warnings (missing media, bad LUTs...) without interrupting work.
  useEffect(() => {
    if (!isTauri) return;
    const id = window.setInterval(() => {
      if (S().playing) return;
      void api.renderWarnings().then((w) => { if (w.length) setWarnings((old) => Array.from(new Set([...old, ...w])).slice(-20)); }).catch(() => {});
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  if (!comp) return <div className="panel"><div className="empty">No composition</div></div>;

  // ------------------------------------------------------------ view transform
  const rul = vflags.rulers ? RULER : 0;
  const availW = Math.max(50, size.w - rul), availH = Math.max(50, size.h - rul);
  const fitZ = Math.min((availW - 32) / comp.width, (availH - 32) / comp.height);
  const z = vflags.zoom > 0 ? vflags.zoom : Math.max(0.01, fitZ);
  const panX = vflags.zoom > 0 ? vflags.panX : 0, panY = vflags.zoom > 0 ? vflags.panY : 0;
  const left = rul + (availW - comp.width * z) / 2 + panX;
  const top = rul + (availH - comp.height * z) / 2 + panY;

  const setZoom = (nz: number, anchor?: { x: number; y: number }) => {
    nz = Math.min(32, Math.max(0.02, nz));
    const ax = anchor?.x ?? size.w / 2, ay = anchor?.y ?? size.h / 2;
    const px = (ax - left) / z, py = (ay - top) / z;
    const nl = ax - px * nz, nt = ay - py * nz;
    S().set({ viewer: { ...S().viewer, zoom: nz, panX: nl - rul - (availW - comp.width * nz) / 2, panY: nt - rul - (availH - comp.height * nz) / 2 } });
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    if (e.ctrlKey || e.altKey || !e.shiftKey) setZoom(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), { x: e.clientX - r.left, y: e.clientY - r.top });
    else S().set({ viewer: { ...S().viewer, zoom: z, panX: panX - e.deltaY, panY } });
  };
  const pan = (dx: number, dy: number) => S().set({ viewer: { ...S().viewer, zoom: z, panX: panX + dx, panY: panY + dy } });
  const onZoomClick = (e: React.MouseEvent) => {
    if (tool !== 'zoom') return;
    const r = wrapRef.current!.getBoundingClientRect();
    setZoom(z * (e.altKey ? 0.5 : 2), { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const frame = Math.round(time * comp.fps);
  const isCached = cached?.includes(frame);
  const has3d = comp.layers.some((l) => l.is3d);
  const zoomLabel = vflags.zoom > 0 ? `${Math.round(z * 100)}%` : `Fit (${Math.round(z * 100)}%)`;
  const crumbs = compStack.map((id) => project?.compositions.find((c) => c.id === id)).filter(Boolean);

  return (
    <div className="panel viewer" data-drop="viewer">
      <div className="panel-head vw-head">
        <div className="row vw-crumbs">
          <Layers size={13} className="muted" />
          {crumbs.map((c, i) => (
            <span key={c!.id} className="row">
              {i > 0 && <ChevronRight size={11} className="muted" />}
              <button className={`vw-crumb ${c!.id === comp.id ? 'on' : ''}`} onClick={() => S().set({ compId: c!.id, compStack: compStack.slice(0, i + 1), selectedLayers: [] })}>{c!.name}</button>
            </span>
          ))}
          <span className="muted mono vw-dim">{comp.width}×{comp.height} · {+comp.fps.toFixed(3)} fps</span>
        </div>
        <span className="grow" />
        {has3d && <span className="pill" title="3D layers render through the active camera; on-canvas handles show their 2D footprint">3D</span>}
        {warnings.length > 0 && (
          <button className="pill warn" title={warnings.join('\n')} onClick={() => { S().toast('warning', `${warnings.length} render warning(s)`, warnings.join('\n')); setWarnings([]); }}>
            <AlertTriangle size={11} /> {warnings.length}
          </button>
        )}
        <Select value={previewScale} onChange={(v) => S().set({ previewScale: v })} options={[{ value: 1, label: 'Full' }, { value: 0.5, label: 'Half' }, { value: 0.25, label: 'Quarter' }, { value: 0.125, label: 'Eighth' }]} />
        <button className={`icon-btn ${draft ? 'active' : ''}`} title="Draft preview (skips motion blur & depth of field)" onClick={() => S().set({ draft: !draft })}><ScanLine size={14} /></button>
        <Select value={vflags.zoom > 0 ? String(vflags.zoom) : 'fit'} onChange={(v) => v === 'fit' ? S().set({ viewer: { ...vflags, zoom: 0, panX: 0, panY: 0 } }) : setZoom(Number(v))}
          options={[{ value: 'fit', label: zoomLabel }, ...[0.25, 0.5, 1, 2, 4].map((x) => ({ value: String(x), label: `${x * 100}%` }))]} />
        <div className="vsep" />
        <button className={`icon-btn ${vflags.checker ? 'active' : ''}`} title="Transparency checkerboard" onClick={() => S().set({ viewer: { ...vflags, checker: !vflags.checker } })}><Grid3x3 size={14} /></button>
        <button className={`icon-btn ${vflags.grid ? 'active' : ''}`} title="Grid" onClick={() => S().set({ viewer: { ...vflags, grid: !vflags.grid } })}><Box size={14} /></button>
        <button className={`icon-btn ${vflags.safe ? 'active' : ''}`} title="Action & title safe areas" onClick={() => S().set({ viewer: { ...vflags, safe: !vflags.safe } })}><SquareDashed size={14} /></button>
        <button className={`icon-btn ${vflags.rulers ? 'active' : ''}`} title="Rulers & guides (drag from a ruler to add a guide)" onClick={() => S().set({ viewer: { ...vflags, rulers: !vflags.rulers } })}><Ruler size={14} /></button>
      </div>

      <div className="vw-main">
        <div className="vw-tools" role="toolbar" aria-label="Viewer tools">
          {TOOLS.map((t, i) => (
            <span key={t.id} style={{ display: 'contents' }}>
              {(i === 3 || i === 9 || i === 12) && <div className="vw-tool-sep" />}
              <button className={`icon-btn ${tool === t.id ? 'active' : ''}`} title={`${t.label}${t.key ? ` (${t.key})` : ''}`} onClick={() => S().set({ tool: t.id })}><t.icon size={15} /></button>
            </span>
          ))}
        </div>
        <div ref={wrapRef} className="vw-stage" onWheel={onWheel} onClick={onZoomClick}>
          <div className={`vw-frame ${comp.transparent && vflags.checker ? 'checker' : ''}`}
            style={{ left, top, width: comp.width * z, height: comp.height * z, background: comp.transparent ? undefined : '#000' }}>
            <canvas ref={canvasRef} className="vw-canvas" style={{ imageRendering: z * (frameInfo ? comp.width / frameInfo.w : 1) > 2 ? 'pixelated' : 'auto' }} />
          </div>
          <Overlay comp={comp} view={{ left, top, z }} onPan={pan} guides={guides} setGuides={setGuides} trackPts={trackPts} setTrackPts={setTrackPts} />
          {vflags.rulers && <Rulers z={z} left={left} top={top} w={size.w} h={size.h} onAddGuide={(g) => setGuides([...guides, g])} />}
          {!isTauri && <div className="vw-note">Preview renders in the VEYRA desktop app.</div>}
          {error && <div className="vw-error" title={error}><AlertTriangle size={13} /> {error.slice(0, 160)}</div>}
          {(tool === 'track' || trackPts.length > 0) && <TrackPanel comp={comp} points={trackPts} setPoints={setTrackPts} onClose={() => { setTrackPts([]); S().set({ tool: 'select' }); }} />}
        </div>
      </div>

      <div className="vw-transport">
        <button className="icon-btn" title="Go to start (Ctrl+←)" onClick={() => goTo('start')}><SkipBack size={15} /></button>
        <button className="icon-btn" title="Previous frame (PgUp / ,)" onClick={() => step(-1)}><StepBack size={15} /></button>
        <button className="icon-btn vw-play" title="Play / Pause (Space)" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <button className="icon-btn" title="Next frame (PgDn / .)" onClick={() => step(1)}><StepForward size={15} /></button>
        <button className="icon-btn" title="Go to end (Ctrl+→)" onClick={() => goTo('end')}><SkipForward size={15} /></button>
        <button className={`icon-btn ${loop ? 'active' : ''}`} title="Loop work area" onClick={() => S().set({ loop: !loop })}><Repeat size={14} /></button>
        <span className="mono vw-tc" title="Current time">{formatTime(time, comp.fps, timeDisplay)}</span>
        <span className="muted mono">/ {formatTime(comp.duration, comp.fps, timeDisplay)}</span>
        <span className="grow" />
        {playing && <span className={`mono vw-fps ${fps < comp.fps * 0.9 ? 'slow' : ''}`} title="Achieved preview frame rate / dropped frames">{fps.toFixed(1)} fps{dropped > 0 ? ` · ${dropped} dropped` : ''}{adaptiveFactor < 1 ? ` · adaptive ${Math.round(previewScale * adaptiveFactor * 100)}%` : ''}</span>}
        <span className={`vw-cache ${isCached ? 'on' : ''}`} title={isCached ? 'Frame is cached' : 'Frame not cached'} />
        <span className={`vw-busy ${rendering ? 'on' : ''}`} title="Rendering" />
        <button className="icon-btn sm" title="Previous frame" onClick={() => step(-1)}><ChevronLeft size={12} /></button>
        <span className="mono muted">{frame}</span>
        <button className="icon-btn sm" title="Next frame" onClick={() => step(1)}><ChevronRight size={12} /></button>
      </div>
    </div>
  );
}

function Rulers({ z, left, top, w, h, onAddGuide }: { z: number; left: number; top: number; w: number; h: number; onAddGuide: (g: Guide) => void }) {
  // Choose a tick spacing (comp px) that is ~80 screen px apart.
  const raw = 80 / z;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const stepPx = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks = (from: number, to: number, origin: number) => {
    const out: number[] = [];
    const start = Math.ceil((from - origin) / z / stepPx) * stepPx;
    for (let v = start; origin + v * z <= to; v += stepPx) out.push(v);
    return out;
  };
  const drag = (axis: 'x' | 'y') => (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget.parentElement!;
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      const r = el.getBoundingClientRect();
      const v = axis === 'x' ? (ev.clientX - r.left - left) / z : (ev.clientY - r.top - top) / z;
      if ((axis === 'y' ? ev.clientY - r.top : ev.clientX - r.left) > RULER) onAddGuide({ axis, pos: Math.round(v) });
    };
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="vw-ruler top" style={{ height: RULER }} onPointerDown={drag('y')} title="Drag down to add a horizontal guide">
        {ticks(RULER, w, left).map((v) => <span key={v} style={{ left: left + v * z }}>{Math.round(v)}</span>)}
      </div>
      <div className="vw-ruler left" style={{ width: RULER }} onPointerDown={drag('x')} title="Drag right to add a vertical guide">
        {ticks(RULER, h, top).map((v) => <span key={v} style={{ top: top + v * z }}>{Math.round(v)}</span>)}
      </div>
      <div className="vw-ruler-corner" style={{ width: RULER, height: RULER }} />
    </>
  );
}
