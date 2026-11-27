// Canvas-based graph editor: value and speed graphs with editable keys and bezier handles.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, Magnet, Maximize, Minus, ScanSearch, Spline, Square, TrendingUp } from 'lucide-react';
import '../timeline/timeline.css';
import type { Composition, Handle, Keyframe, Layer, Prop, Project } from '../../types/project';
import { draftComp, getPath, useComp, useEditor, type KeySel } from '../../store/editor';
import { EASINGS, evalKeys, HANDLE_IN_LINEAR, HANDLE_OUT_LINEAR } from '../../lib/anim';
import { NumberField } from '../ui/primitives';
import { animatedProps, graphId, niceStep, parseGraphId } from '../timeline/model';
import { applyEasingToSelection, isKeySelected, setInterp } from '../timeline/keyops';

const S = () => useEditor.getState();
const COMP_COLORS = ['#e46470', '#8fbf9a', '#7fb2e5', '#c9c9c9'];

interface Curve { id: string; layer: Layer; path: string; label: string; prop: Prop<unknown>; n: number }

function components(v: unknown): number[] | null {
  if (typeof v === 'number') return [v];
  if (Array.isArray(v) && v.length && typeof v[0] === 'number') return v as number[];
  return null;
}

function useCurves(comp: Composition | undefined): Curve[] {
  const graphProps = useEditor((s) => s.graphProps);
  const selected = useEditor((s) => s.selectedLayers);
  const defs = useEditor((s) => s.effectDefs);
  return useMemo(() => {
    if (!comp) return [];
    const out: Curve[] = [];
    const push = (layer: Layer, path: string, label: string) => {
      const p = getPath(layer, path) as Prop<unknown> | undefined;
      if (!p || !p.keys?.length) return;
      const c = components(p.keys[0].v);
      if (!c) return;
      out.push({ id: graphId(layer.id, path), layer, path, label: `${layer.name} › ${label}`, prop: p, n: c.length });
    };
    if (graphProps.length) {
      for (const g of graphProps) {
        const { layerId, path } = parseGraphId(g);
        const l = comp.layers.find((x) => x.id === layerId);
        if (!l) continue;
        const ap = animatedProps(l, defs).find((a) => a.path === path);
        push(l, path, ap?.label ?? path);
      }
    } else {
      for (const l of comp.layers.filter((x) => selected.includes(x.id))) for (const ap of animatedProps(l, defs)) push(l, ap.path, ap.label);
    }
    return out;
  }, [comp, graphProps, selected, defs]);
}

interface View { t0: number; t1: number; v0: number; v1: number }

type Hit =
  | { type: 'key'; curve: Curve; t: number; c: number }
  | { type: 'handle'; curve: Curve; keyIndex: number; side: 'out' | 'in'; c: number }
  | null;

export function GraphEditor() {
  const comp = useComp();
  const curves = useCurves(comp);
  const selKeys = useEditor((s) => s.selectedKeys);
  const time = useEditor((s) => s.time);
  const [mode, setMode] = useState<'value' | 'speed'>('value');
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [snap, setSnap] = useState(true);
  const [view, setView] = useState<View>({ t0: 0, t1: 10, v0: -10, v1: 110 });
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const PAD_L = 46, PAD_B = 18;

  const visible = curves.filter((c) => !hidden[c.id]);
  const tx = useCallback((t: number) => PAD_L + ((t - view.t0) / (view.t1 - view.t0)) * (size.w - PAD_L), [view, size.w]);
  const vy = useCallback((v: number) => (size.h - PAD_B) - ((v - view.v0) / (view.v1 - view.v0)) * (size.h - PAD_B), [view, size.h]);
  const xt = (x: number) => view.t0 + ((x - PAD_L) / (size.w - PAD_L)) * (view.t1 - view.t0);
  const yv = (y: number) => view.v0 + (((size.h - PAD_B) - y) / (size.h - PAD_B)) * (view.v1 - view.v0);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Value of a curve component at comp time t (keyframes only).
  const valueAt = (cv: Curve, t: number, c: number) => {
    const v = components(evalKeys(cv.prop.keys, cv.prop.value, t - cv.layer.start));
    return v ? v[Math.min(c, v.length - 1)] : 0;
  };
  const speedAt = (cv: Curve, t: number) => {
    const h = 1 / 240;
    const a = components(evalKeys(cv.prop.keys, cv.prop.value, t - cv.layer.start - h)) ?? [0];
    const b = components(evalKeys(cv.prop.keys, cv.prop.value, t - cv.layer.start + h)) ?? [0];
    return Math.sqrt(a.reduce((s, x, i) => s + ((b[i] - x) / (2 * h)) ** 2, 0));
  };

  const fit = useCallback((onlySelected: boolean) => {
    if (!comp) return;
    let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const cv of visible) {
      for (const k of cv.prop.keys ?? []) {
        if (onlySelected && !isKeySelected(S().selectedKeys, cv.layer.id, cv.path, k.t)) continue;
        const t = cv.layer.start + k.t;
        t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      }
    }
    // Fit composition (or nothing selected): span the whole comp plus any keys outside it.
    if (!onlySelected || !Number.isFinite(t0)) {
      t0 = Math.min(Number.isFinite(t0) ? t0 : 0, 0);
      t1 = Math.max(Number.isFinite(t1) ? t1 : comp.duration, comp.duration);
    }
    if (t1 - t0 < 0.1) { t0 -= 0.5; t1 += 0.5; }
    for (const cv of visible) {
      const steps = 200;
      for (let i = 0; i <= steps; i++) {
        const t = t0 + ((t1 - t0) * i) / steps;
        if (mode === 'speed') { const s = speedAt(cv, t); v0 = Math.min(v0, 0); v1 = Math.max(v1, s); }
        else for (let c = 0; c < cv.n; c++) { const v = valueAt(cv, t, c); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      }
    }
    if (!Number.isFinite(v0)) { v0 = 0; v1 = 100; }
    if (v1 - v0 < 1e-3) { v0 -= 1; v1 += 1; }
    const pv = (v1 - v0) * 0.1, pt = (t1 - t0) * 0.04;
    setView({ t0: t0 - pt, t1: t1 + pt, v0: v0 - pv, v1: v1 + pv });
  }, [visible, mode, comp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fit when the curve set or mode changes.
  const curveKey = visible.map((c) => c.id).join(',') + mode;
  useEffect(() => { fit(false); }, [curveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handles visible for selected keys: positions per component.
  const handlePos = (cv: Curve, i: number, side: 'out' | 'in', c: number): [number, number] | null => {
    const keys = cv.prop.keys ?? [];
    const a = side === 'out' ? keys[i] : keys[i - 1];
    const b = side === 'out' ? keys[i + 1] : keys[i];
    if (!a || !b || a.interp !== 'bezier') return null;
    const va = components(a.v)?.[c] ?? 0, vb = components(b.v)?.[c] ?? 0;
    const h = side === 'out' ? a.outH ?? HANDLE_OUT_LINEAR : b.inH ?? HANDLE_IN_LINEAR;
    const t = cv.layer.start + a.t + h.x * (b.t - a.t);
    return [t, va + h.y * (vb - va)];
  };

  // ---------------------------------------------------------------- draw
  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs || !comp) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = Math.round(size.w * dpr);
    cvs.height = Math.round(size.h * dpr);
    const g = cvs.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#141414';
    g.fillRect(0, 0, size.w, size.h);
    // grid
    const { major } = niceStep((size.w - PAD_L) / (view.t1 - view.t0), comp.fps);
    g.font = '10px Consolas, monospace';
    g.strokeStyle = '#222';
    g.fillStyle = '#6a6a6a';
    g.beginPath();
    for (let t = Math.ceil(view.t0 / major) * major; t <= view.t1; t += major) {
      const x = Math.round(tx(t)) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, size.h - PAD_B);
      g.fillText(`${+t.toFixed(2)}s`, x + 2, size.h - 5);
    }
    const vr = view.v1 - view.v0;
    const vstep = Math.pow(10, Math.floor(Math.log10(vr / 4)));
    const vs = [1, 2, 5, 10].map((m) => m * vstep).find((s) => vr / s <= 8) ?? vstep * 10;
    for (let v = Math.ceil(view.v0 / vs) * vs; v <= view.v1; v += vs) {
      const y = Math.round(vy(v)) + 0.5;
      g.moveTo(PAD_L, y); g.lineTo(size.w, y);
      g.fillText(`${+v.toFixed(3)}`, 3, y + 3);
    }
    g.stroke();
    // composition range
    g.fillStyle = 'rgba(0,0,0,0.3)';
    if (tx(0) > PAD_L) g.fillRect(PAD_L, 0, tx(0) - PAD_L, size.h - PAD_B);
    if (tx(comp.duration) < size.w) g.fillRect(tx(comp.duration), 0, size.w - tx(comp.duration), size.h - PAD_B);
    // curves
    for (const cv of visible) {
      const comps = mode === 'speed' ? 1 : cv.n;
      for (let c = 0; c < comps; c++) {
        g.strokeStyle = cv.n === 1 || mode === 'speed' ? '#ffffff' : COMP_COLORS[c] ?? '#ccc';
        g.lineWidth = 1.5;
        g.beginPath();
        for (let x = PAD_L; x <= size.w; x += 2) {
          const t = xt(x);
          const v = mode === 'speed' ? speedAt(cv, t) : valueAt(cv, t, c);
          const y = vy(v);
          if (x === PAD_L) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        // keys
        const keys = cv.prop.keys ?? [];
        keys.forEach((k, i) => {
          const t = cv.layer.start + k.t;
          const v = mode === 'speed' ? speedAt(cv, t + 1e-4) : components(k.v)?.[c] ?? 0;
          const x = tx(t), y = vy(v);
          const sel = isKeySelected(selKeys, cv.layer.id, cv.path, k.t);
          if (sel && mode === 'value') {
            for (const side of ['out', 'in'] as const) {
              const hp = handlePos(cv, i, side, c);
              if (!hp) continue;
              g.strokeStyle = '#888'; g.lineWidth = 1;
              g.beginPath(); g.moveTo(x, y); g.lineTo(tx(hp[0]), vy(hp[1])); g.stroke();
              g.fillStyle = '#ffffff';
              g.beginPath(); g.arc(tx(hp[0]), vy(hp[1]), 3.5, 0, Math.PI * 2); g.fill();
            }
          }
          g.fillStyle = sel ? '#ffffff' : '#9a9a9a';
          g.strokeStyle = '#111';
          g.lineWidth = 1;
          g.beginPath();
          if (k.interp === 'hold') g.rect(x - 4, y - 4, 8, 8);
          else { g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); }
          g.fill(); g.stroke();
        });
      }
    }
    // playhead
    const px = tx(time);
    g.strokeStyle = '#ffffff'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, size.h); g.stroke();
    if (!visible.length) {
      g.fillStyle = '#686868'; g.font = '12px Segoe UI, sans-serif';
      g.fillText('Select an animated layer, or double-click a property row in the timeline', PAD_L + 12, 28);
    }
  });

  // ---------------------------------------------------------------- hit testing
  const hitTest = (x: number, y: number): Hit => {
    if (mode === 'value') {
      for (const cv of visible) {
        const keys = cv.prop.keys ?? [];
        for (let i = 0; i < keys.length; i++) {
          if (!isKeySelected(S().selectedKeys, cv.layer.id, cv.path, keys[i].t)) continue;
          for (let c = 0; c < cv.n; c++) for (const side of ['out', 'in'] as const) {
            const hp = handlePos(cv, i, side, c);
            if (hp && Math.hypot(tx(hp[0]) - x, vy(hp[1]) - y) < 6) return { type: 'handle', curve: cv, keyIndex: i, side, c };
          }
        }
      }
    }
    for (const cv of visible) {
      for (const k of cv.prop.keys ?? []) {
        const t = cv.layer.start + k.t;
        const comps = mode === 'speed' ? 1 : cv.n;
        for (let c = 0; c < comps; c++) {
          const v = mode === 'speed' ? speedAt(cv, t + 1e-4) : components(k.v)?.[c] ?? 0;
          if (Math.hypot(tx(t) - x, vy(v) - y) < 7) return { type: 'key', curve: cv, t: k.t, c };
        }
      }
    }
    return null;
  };

  const localPt = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!comp) return;
    const p = localPt(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey && !hitTest(p.x, p.y))) {
      const v0 = view;
      const sx = (v0.t1 - v0.t0) / (size.w - PAD_L), sy = (v0.v1 - v0.v0) / (size.h - PAD_B);
      const move = (ev: PointerEvent) => {
        const q = localPt(ev);
        const dx = (q.x - p.x) * sx, dy = (q.y - p.y) * sy;
        setView({ t0: v0.t0 - dx, t1: v0.t1 - dx, v0: v0.v0 + dy, v1: v0.v1 + dy });
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    const hit = hitTest(p.x, p.y);
    const snapshot = S().project!;
    const coalesce = `graph-${Date.now()}`;
    if (hit?.type === 'handle') {
      const { curve, keyIndex, side, c } = hit;
      const move = (ev: PointerEvent) => {
        const q = localPt(ev);
        const t = xt(q.x), v = yv(q.y);
        S().edit('Edit Bezier Handle', (d) => {
          const l = draftComp(d)?.layers.find((x) => x.id === curve.layer.id);
          const pr = l ? (getPath(l, curve.path) as Prop<unknown>) : undefined;
          const keys = pr?.keys;
          if (!keys) return;
          const a = side === 'out' ? keys[keyIndex] : keys[keyIndex - 1];
          const b = side === 'out' ? keys[keyIndex + 1] : keys[keyIndex];
          if (!a || !b) return;
          const va = components(a.v)?.[c] ?? 0, vb = components(b.v)?.[c] ?? 0;
          const dv = vb - va;
          const hx = Math.min(1, Math.max(0, (t - curve.layer.start - a.t) / Math.max(b.t - a.t, 1e-9)));
          const prev = side === 'out' ? a.outH ?? HANDLE_OUT_LINEAR : b.inH ?? HANDLE_IN_LINEAR;
          const hy = Math.abs(dv) > 1e-9 ? (v - va) / dv : prev.y;
          const h: Handle = { x: hx, y: Math.max(-4, Math.min(5, hy)) };
          a.interp = 'bezier';
          if (side === 'out') a.outH = h; else b.inH = h;
        }, coalesce);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    if (hit?.type === 'key') {
      const { curve, t, c } = hit;
      let sel = S().selectedKeys;
      const already = isKeySelected(sel, curve.layer.id, curve.path, t);
      if (e.shiftKey) sel = already ? sel.filter((k) => !(k.layerId === curve.layer.id && k.path === curve.path && Math.abs(k.t - t) < 1e-3)) : [...sel, { layerId: curve.layer.id, path: curve.path, t }];
      else if (!already) sel = [{ layerId: curve.layer.id, path: curve.path, t }];
      S().set({ selectedKeys: sel });
      const startSel = sel;
      const fps = comp.fps;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const q = localPt(ev);
        if (!moved && Math.hypot(q.x - p.x, q.y - p.y) < 3) return;
        moved = true;
        let dt = xt(q.x) - xt(p.x);
        if (snap) dt = Math.round(dt * fps) / fps;
        let dv = mode === 'value' ? yv(q.y) - yv(p.y) : 0;
        if (ev.shiftKey) { if (Math.abs(q.x - p.x) > Math.abs(q.y - p.y)) dv = 0; else dt = 0; } // axis constrain
        const ns = moveKeysValue(snapshot, startSel, dt, dv, curve.id, c, snap ? fps : 1e6, coalesce);
        S().set({ selectedKeys: ns });
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    // marquee
    const base = e.shiftKey ? S().selectedKeys : [];
    let moved = false;
    const move = (ev: PointerEvent) => {
      const q = localPt(ev);
      if (!moved && Math.hypot(q.x - p.x, q.y - p.y) < 4) return;
      moved = true;
      setMarquee({ x0: p.x, y0: p.y, x1: q.x, y1: q.y });
      const [xa, xb, ya, yb] = [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.y, q.y), Math.max(p.y, q.y)];
      const out: KeySel[] = [...base];
      for (const cv of visible) for (const k of cv.prop.keys ?? []) {
        const t = cv.layer.start + k.t;
        const comps = mode === 'speed' ? 1 : cv.n;
        for (let c = 0; c < comps; c++) {
          const v = mode === 'speed' ? speedAt(cv, t + 1e-4) : components(k.v)?.[c] ?? 0;
          const x = tx(t), y = vy(v);
          if (x >= xa && x <= xb && y >= ya && y <= yb && !isKeySelected(out, cv.layer.id, cv.path, k.t)) out.push({ layerId: cv.layer.id, path: cv.path, t: k.t });
        }
      }
      S().set({ selectedKeys: out });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setMarquee(null);
      if (!moved) { S().set({ selectedKeys: base }); S().setTime(xt(p.x)); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = localPt(e);
    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    const t = xt(p.x), v = yv(p.y);
    const zt = !e.ctrlKey, zv = !e.shiftKey;
    setView((vw) => ({
      t0: zt ? t - (t - vw.t0) * f : vw.t0, t1: zt ? t + (vw.t1 - t) * f : vw.t1,
      v0: zv ? v - (v - vw.v0) * f : vw.v0, v1: zv ? v + (vw.v1 - v) * f : vw.v1,
    }));
  };

  // ---------------------------------------------------------------- selected key numeric fields
  const first = selKeys[0];
  const fc = first ? curves.find((c) => c.layer.id === first.layerId && c.path === first.path) : undefined;
  const fk = fc?.prop.keys?.find((k) => Math.abs(k.t - first!.t) < 1e-3);
  const fvals = fk ? components(fk.v) : null;

  const setFirstKey = (nt: number | null, comp_i: number | null, nv: number | null) => {
    if (!fc || !fk || !comp) return;
    const targetT = nt != null ? Math.round(nt * comp.fps) / comp.fps : fk.t;
    S().edit('Edit Keyframe', (d) => {
      const l = draftComp(d)?.layers.find((x) => x.id === fc.layer.id);
      const pr = l ? (getPath(l, fc.path) as Prop<unknown>) : undefined;
      const k = pr?.keys?.find((x) => Math.abs(x.t - fk.t) < 1e-3);
      if (!pr || !k) return;
      if (comp_i != null && nv != null) {
        if (typeof k.v === 'number') k.v = nv as never;
        else if (Array.isArray(k.v)) (k.v as number[])[comp_i] = nv;
      }
      if (nt != null) { k.t = targetT; pr.keys!.sort((a, b) => a.t - b.t); }
    }, `gfield-${fc.id}`);
    if (nt != null) S().set({ selectedKeys: [{ layerId: fc.layer.id, path: fc.path, t: targetT }] });
  };

  return (
    <div className="panel ge-root">
      <div className="panel-head">
        <div className="tabs">
          <button className={`tab ${mode === 'value' ? 'on' : ''}`} onClick={() => setMode('value')} title="Value graph"><TrendingUp size={12} /> Value</button>
          <button className={`tab ${mode === 'speed' ? 'on' : ''}`} onClick={() => setMode('speed')} title="Speed graph (rate of change)"><Activity size={12} /> Speed</button>
        </div>
        <span className="vsep" />
        <button className="icon-btn" title="Linear (selected keys)" onClick={() => setInterp('linear')}><Minus size={14} /></button>
        <button className="icon-btn" title="Easy Ease (F9)" onClick={() => setInterp('easy')}><Spline size={14} /></button>
        <button className="icon-btn" title="Hold" onClick={() => setInterp('hold')}><Square size={13} /></button>
        <button className="btn sm ghost" title="Ease in" onClick={() => setInterp('easeIn')}>In</button>
        <button className="btn sm ghost" title="Ease out" onClick={() => setInterp('easeOut')}>Out</button>
        <select className="input sm ge-ease" value="" title="Apply an easing curve to the selected keyframes (changes the curve only, adds no keys)"
          onChange={(e) => { const ez = EASINGS.find((x) => x.id === e.target.value); if (ez) applyEasingToSelection(ez); }}>
          <option value="">Easing curve…</option>
          {[...new Set(EASINGS.map((x) => x.group))].map((g) => (
            <optgroup key={g} label={g}>{EASINGS.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
          ))}
        </select>
        {fk && fc && /^(elastic|bounce)/.test(fk.interp ?? '') && (
          <span className="row" style={{ gap: 4 }} title="Strength of the elastic overshoot / bounce height">
            <span className="label">Amount</span>
            <NumberField value={(fk.amount ?? 1) * 100} min={0} max={400} step={5} precision={0} unit="%"
              onChange={(v) => S().edit('Easing Amount', (d) => {
                const l = draftComp(d)?.layers.find((x) => x.id === fc.layer.id);
                const p = l ? (getPath(l, fc.path) as Prop<unknown> | undefined) : undefined;
                const k = p?.keys?.find((x) => Math.abs(x.t - fk.t) < 1e-3);
                if (k) k.amount = Math.max(0, v / 100);
              }, `ease-amt:${fc.layer.id}:${fc.path}`)} />
          </span>
        )}
        <span className="vsep" />
        <button className={`icon-btn ${snap ? 'active' : ''}`} title="Snap key times to frames" onClick={() => setSnap(!snap)}><Magnet size={14} /></button>
        <button className="icon-btn" title="Fit selection" onClick={() => fit(true)}><ScanSearch size={14} /></button>
        <button className="icon-btn" title="Fit composition" onClick={() => fit(false)}><Maximize size={14} /></button>
        <span className="grow" />
        {fk && comp && fc && (
          <span className="ge-fields">
            <span className="label">Frame</span>
            <NumberField value={(fc.layer.start + fk.t) * comp.fps} step={1} precision={0} onChange={(f) => setFirstKey(f / comp.fps - fc.layer.start, null, null)} />
            {fvals?.map((v, i) => (
              <span key={i} className="row" style={{ gap: 2 }}>
                <span className="ge-dot" style={{ background: fvals.length === 1 ? 'var(--accent)' : COMP_COLORS[i] }} />
                <NumberField value={v} step={fvals.length === 4 ? 0.005 : 0.5} onChange={(nv) => setFirstKey(null, i, nv)} />
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="ge-main">
        <div className="ge-list">
          {curves.length === 0 && <div className="muted" style={{ padding: 8, fontSize: 'var(--fs-sm)' }}>No animated properties.</div>}
          {curves.map((cv) => (
            <label key={cv.id} className="ge-item" title={cv.label}>
              <input type="checkbox" checked={!hidden[cv.id]} onChange={(e) => setHidden({ ...hidden, [cv.id]: !e.target.checked })} />
              <span className="ge-dot" style={{ background: cv.n === 1 ? 'var(--accent)' : `linear-gradient(90deg, ${COMP_COLORS.slice(0, Math.min(cv.n, 3)).join(',')})` }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cv.label}</span>
            </label>
          ))}
        </div>
        <div className="ge-canvas-wrap" ref={wrap}>
          <canvas ref={canvas} style={{ width: size.w, height: size.h }} onPointerDown={onDown} onWheel={onWheel} onDoubleClick={() => fit(false)} />
          {marquee && <div className="tl-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
        </div>
      </div>
    </div>
  );
}

/** Move selected keys in time (all props) and value (component `c` of the dragged curve only). */
function moveKeysValue(snapshot: Project, sel: KeySel[], dt: number, dv: number, curveId: string, c: number, fps: number, coalesce: string): KeySel[] {
  const s = S();
  const snapComp = snapshot.compositions.find((x) => x.id === s.compId);
  const out: KeySel[] = [];
  const groups = new Map<string, KeySel[]>();
  for (const k of sel) { const id = graphId(k.layerId, k.path); groups.set(id, [...(groups.get(id) ?? []), k]); }
  s.edit('Move Keyframes', (d) => {
    for (const [id, ks] of groups) {
      const { layerId, path } = parseGraphId(id);
      const sl = snapComp?.layers.find((l) => l.id === layerId);
      const sp = sl ? (getPath(sl, path) as Prop<unknown>) : undefined;
      const l = draftComp(d)?.layers.find((x) => x.id === layerId);
      const p = l ? (getPath(l, path) as Prop<unknown>) : undefined;
      if (!sp?.keys || !p) continue;
      const moved: Keyframe<unknown>[] = [], kept: Keyframe<unknown>[] = [];
      for (const k of sp.keys) {
        if (ks.some((x) => Math.abs(x.t - k.t) < 1e-3)) {
          const nt = Math.round((k.t + dt) * fps) / fps;
          let v = k.v;
          if (id === curveId && dv !== 0) {
            if (typeof v === 'number') v = v + dv;
            else if (Array.isArray(v)) { v = [...(v as number[])]; (v as number[])[c] += dv; }
          }
          moved.push({ ...k, t: nt, v });
          out.push({ layerId, path, t: nt });
        } else kept.push(k);
      }
      p.keys = kept.filter((k) => !moved.some((m) => Math.abs(m.t - k.t) < 1e-3)).concat(moved).sort((a, b) => a.t - b.t) as never;
    }
  }, coalesce);
  return out;
}
