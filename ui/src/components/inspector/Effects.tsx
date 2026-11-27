// Effect stack: registry-driven parameter editors, curves, colour wheels, presets, reordering.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Draft } from 'immer';
import { ChevronDown, ChevronRight, ClipboardPaste, Copy, CopyPlus, FolderOpen, GripVertical, Palette, Plus, RotateCcw, Save, Star, Trash2 } from 'lucide-react';
import type { Effect, EffectDef, Layer, ParamDef, ParamValue } from '../../types/project';
import { getPath, newLocalId, useEditor } from '../../store/editor';
import { NONE } from '../../store/editor';
import { api, isTauri } from '../../lib/api';
import { paramNum, propAt } from '../../lib/anim';
import { ColorField, NumberField, Popover, SearchBox, Select, Slider, Toggle } from '../ui/primitives';
import { PlainRow, PropRow } from './PropRow';
import { editLayers, writeProps } from './util';

const S = () => useEditor.getState();

export function defFor(defs: EffectDef[], kind: string) {
  return defs.find((d) => d.kind === kind);
}

/** Effect stack for a layer (visual effects) or its audio chain (`audio` = true). */
export function EffectsList({ layer, audio = false }: { layer: Layer; audio?: boolean }) {
  const defs = useEditor((s) => s.effectDefs);
  const clip = useEditor((s) => s.clipboard.effects);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const list = audio ? layer.audio.effects : layer.effects;
  const base = audio ? 'audio.effects' : 'effects';

  const mutate = (label: string, fn: (arr: Draft<Effect>[]) => void) =>
    editLayers([layer.id], label, (l) => fn((audio ? l.audio.effects : l.effects) as Draft<Effect>[]));

  const add = async (kind: string) => {
    const e = await api.createEffect(kind);
    mutate('Add Effect', (arr) => { arr.push(e as Draft<Effect>); });
  };
  const addFromPreset = (data: unknown) => {
    const e = JSON.parse(JSON.stringify(data)) as Effect;
    e.id = newLocalId();
    mutate('Apply Effect Preset', (arr) => { arr.push(e as Draft<Effect>); });
  };

  return (
    <div className="fx-list">
      {list.length === 0 && <div className="muted fx-empty">{audio ? 'No audio effects.' : 'No effects. Add one below or drag from the Effects library.'}</div>}
      {list.map((e, i) => (
        <div key={e.id} className={`fx-card ${dragIdx === i ? 'dragging' : ''}`}
          onDragOver={(ev) => { if (dragIdx != null) ev.preventDefault(); }}
          onDrop={(ev) => {
            ev.preventDefault();
            if (dragIdx == null || dragIdx === i) return;
            const from = dragIdx;
            mutate('Reorder Effects', (arr) => { const [m] = arr.splice(from, 1); arr.splice(i, 0, m); });
            setDragIdx(null);
          }}>
          <EffectCard layer={layer} effect={e} index={i} count={list.length} base={base} def={defFor(defs, e.kind)} mutate={mutate}
            onDragStart={() => setDragIdx(i)} onDragEnd={() => setDragIdx(null)} />
        </div>
      ))}
      <div className="row fx-actions">
        <button className="btn sm" onClick={(e) => setAdding(e.currentTarget)}><Plus size={12} /> Add {audio ? 'Audio ' : ''}Effect</button>
        {!audio && !list.some((e) => e.kind === 'colorGrade') && (
          <button className="btn sm" title="Colour wheels, exposure, contrast, saturation, temperature and curves" onClick={() => void add('colorGrade')}><Palette size={12} /> Color Grade</button>
        )}
        {!audio && clip?.length ? (
          <button className="btn sm ghost" title="Paste effects" onClick={() => mutate('Paste Effects', (arr) => { for (const e of clip) arr.push({ ...JSON.parse(JSON.stringify(e)), id: newLocalId() }); })}>
            <ClipboardPaste size={12} /> Paste {clip.length}
          </button>
        ) : null}
        {!audio && list.length > 0 && (
          <button className="btn sm ghost" title="Copy all effects" onClick={() => S().set({ clipboard: { ...S().clipboard, effects: JSON.parse(JSON.stringify(list)) } })}><Copy size={12} /> Copy All</button>
        )}
        {!audio && list.length > 0 && (
          <button className="btn sm ghost danger" title="Remove all effects" onClick={() => mutate('Reset Effects', (arr) => { arr.splice(0, arr.length); })}>Clear</button>
        )}
      </div>
      {adding && (
        <Popover anchor={adding} onClose={() => setAdding(null)}>
          <AddEffectMenu audio={audio} onPick={(k) => { void add(k); setAdding(null); }} onPreset={(d) => { addFromPreset(d); setAdding(null); }} />
        </Popover>
      )}
    </div>
  );
}

function AddEffectMenu({ audio, onPick, onPreset }: { audio: boolean; onPick: (kind: string) => void; onPreset: (data: unknown) => void }) {
  const defs = useEditor((s) => s.effectDefs);
  const favs = useEditor((s) => s.settings?.favoriteEffects ?? NONE);
  const [q, setQ] = useState('');
  const [presets, setPresets] = useState<{ name: string; data: unknown }[]>([]);
  useEffect(() => { if (isTauri && !audio) void api.listPresets('effect').then(setPresets).catch(() => {}); }, [audio]);
  const items = defs.filter((d) => d.audio === audio && (!q || `${d.name} ${d.category} ${d.description}`.toLowerCase().includes(q.toLowerCase())));
  const groups = useMemo(() => {
    const m = new Map<string, EffectDef[]>();
    const fav = items.filter((d) => favs.includes(d.kind));
    if (fav.length) m.set('Favourites', fav);
    for (const d of items) { const g = m.get(d.category) ?? []; g.push(d); m.set(d.category, g); }
    return [...m.entries()];
  }, [items, favs]);
  const pres = presets.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fx-add">
      <SearchBox value={q} onChange={setQ} placeholder={audio ? 'Search audio effects' : 'Search effects'} autoFocus />
      <div className="fx-add-list">
        {pres.length > 0 && <><div className="menu-head">Presets</div>{pres.map((p) => <div key={p.name} className="menu-item" onClick={() => onPreset(p.data)}><Save size={12} />{p.name}</div>)}</>}
        {groups.map(([g, ds]) => (
          <div key={g}>
            <div className="menu-head">{g}</div>
            {ds.map((d) => <div key={g + d.kind} className="menu-item" title={d.description} onClick={() => onPick(d.kind)}>{d.name}</div>)}
          </div>
        ))}
        {!groups.length && !pres.length && <div className="muted" style={{ padding: 8 }}>No matching effects</div>}
      </div>
    </div>
  );
}

function EffectCard({ layer, effect, index, count, base, def, mutate, onDragStart, onDragEnd }: {
  layer: Layer; effect: Effect; index: number; count: number; base: string; def?: EffectDef;
  mutate: (label: string, fn: (arr: Draft<Effect>[]) => void) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [adv, setAdv] = useState(false);
  const [saving, setSaving] = useState<HTMLElement | null>(null);
  const favs = useEditor((s) => s.settings?.favoriteEffects ?? NONE);
  const path = `${base}.${effect.id}.params`;
  const name = effect.name || def?.name || effect.kind;
  const at = (fn: (arr: Draft<Effect>[], i: number) => void) => (label: string) => mutate(label, (arr) => { const i = arr.findIndex((x) => x.id === effect.id); if (i >= 0) fn(arr, i); });
  const toggleFav = () => {
    const s = S().settings;
    if (!s) return;
    const next = { ...s, favoriteEffects: favs.includes(effect.kind) ? favs.filter((k) => k !== effect.kind) : [...favs, effect.kind] };
    S().set({ settings: next });
    if (isTauri) void api.setSettings(next);
  };
  const isGrade = effect.kind === 'colorGrade';
  const params = (def?.params ?? []).filter((p) => !(isGrade && ['lift', 'gamma', 'gain', 'offset'].includes(p.key)));
  const audioFx = def?.audio;
  return (
    <>
      <div className="fx-head">
        <span className="fx-grip" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd} title="Drag to reorder"><GripVertical size={12} /></span>
        <button className="icon-btn sm" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        <Toggle on={effect.enabled} onChange={(v) => at((arr, i) => { arr[i].enabled = v; })(v ? 'Enable Effect' : 'Disable Effect')} title="Enable / bypass" />
        <span className={`fx-name grow ${effect.enabled ? '' : 'off'}`} title={def?.description}>{name}</span>
        {!def && <span className="pill err">unknown</span>}
        <button className={`icon-btn sm ${favs.includes(effect.kind) ? 'active' : ''}`} title="Favourite" onClick={toggleFav}><Star size={11} /></button>
        <button className="icon-btn sm" title="Move up" disabled={index === 0} onClick={() => at((arr, i) => { const [m] = arr.splice(i, 1); arr.splice(i - 1, 0, m); })('Move Effect Up')}>↑</button>
        <button className="icon-btn sm" title="Move down" disabled={index === count - 1} onClick={() => at((arr, i) => { const [m] = arr.splice(i, 1); arr.splice(i + 1, 0, m); })('Move Effect Down')}>↓</button>
        <button className="icon-btn sm" title="Reset parameters" onClick={() => at((arr, i) => { if (def) for (const p of def.params) arr[i].params[p.key] = { value: p.default, keys: [] } as never; })('Reset Effect')}><RotateCcw size={11} /></button>
        <button className="icon-btn sm" title="Duplicate" onClick={() => at((arr, i) => { arr.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(arr[i])), id: newLocalId() }); })('Duplicate Effect')}><CopyPlus size={11} /></button>
        {!audioFx && <button className="icon-btn sm" title="Copy effect" onClick={() => S().set({ clipboard: { ...S().clipboard, effects: [JSON.parse(JSON.stringify(effect))] } })}><Copy size={11} /></button>}
        {!audioFx && <button className="icon-btn sm" title="Save as preset" onClick={(e) => setSaving(e.currentTarget)}><Save size={11} /></button>}
        <button className="icon-btn sm" title="Delete effect" onClick={() => at((arr, i) => { arr.splice(i, 1); })('Delete Effect')}><Trash2 size={11} /></button>
      </div>
      {saving && <Popover anchor={saving} onClose={() => setSaving(null)}><SavePreset initial={name} onSave={(n) => { void api.savePreset('effect', n, effect).then(() => S().toast('success', `Saved preset “${n}”`)).catch((e) => S().toast('error', 'Could not save preset', String(e))); setSaving(null); }} /></Popover>}
      {open && def && (
        <div className="fx-body">
          {isGrade && <ColorWheels layer={layer} path={path} />}
          {params.filter((p) => !p.advanced).map((p) => <ParamRow key={p.key} layer={layer} path={`${path}.${p.key}`} def={p} audio={!!audioFx} />)}
          {params.some((p) => p.advanced) && (
            <>
              <button className="fx-adv" onClick={() => setAdv(!adv)}>{adv ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Advanced</button>
              {adv && params.filter((p) => p.advanced).map((p) => <ParamRow key={p.key} layer={layer} path={`${path}.${p.key}`} def={p} audio={!!audioFx} />)}
            </>
          )}
        </div>
      )}
    </>
  );
}

function SavePreset({ initial, onSave }: { initial: string; onSave: (name: string) => void }) {
  const [n, setN] = useState(initial);
  return (
    <div className="row" style={{ padding: 2 }}>
      <input className="input" autoFocus value={n} onChange={(e) => setN(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && n.trim()) onSave(n.trim()); }} />
      <button className="btn sm primary" disabled={!n.trim()} onClick={() => onSave(n.trim())}>Save</button>
    </div>
  );
}

// ---------------------------------------------------------------- parameter editors

function ParamRow({ layer, path, def, audio }: { layer: Layer; path: string; def: ParamDef; audio: boolean }) {
  const exists = getPath(layer, path) != null;
  if (!exists) {
    return <PlainRow label={def.label}><button className="btn sm ghost" onClick={() => editLayers([layer.id], 'Add Parameter', (l) => {
      const parts = path.split('.'); const key = parts.pop()!; const params = getPath(l, parts.join('.')) as Record<string, unknown>;
      if (params) params[key] = { value: def.default, keys: [] };
    })}>Initialise</button></PlainRow>;
  }
  if (def.kind.type === 'curve') return <CurveRow layer={layer} path={path} def={def} />;
  // Audio effects are processed by the mixer from their static values: no keyframes offered.
  return (
    <PropRow<ParamValue> layers={[layer]} path={path} label={def.label} noKeys={audio} title={def.label}>
      {(v, set) => <ParamEditor def={def} v={v} set={set} />}
    </PropRow>
  );
}

function ParamEditor({ def, v, set }: { def: ParamDef; v: ParamValue; set: (v: ParamValue) => void }) {
  const k = def.kind;
  switch (k.type) {
    case 'float': {
      const n = paramNum(v);
      const finite = Number.isFinite(k.min) && Number.isFinite(k.max);
      return <>
        <NumberField value={n} onChange={set} min={k.min} max={k.max} step={k.step || 0.01} unit={k.unit ? ` ${k.unit}` : undefined} precision={k.step >= 1 ? 1 : 2} />
        {finite && <Slider value={n} min={k.min} max={k.max} step={k.step || 0.01} onChange={set} width={70} />}
      </>;
    }
    case 'angle': return <NumberField value={paramNum(v)} onChange={set} step={1} unit="°" precision={1} />;
    case 'color': {
      const c = (Array.isArray(v) ? v : [0, 0, 0, 1]) as number[];
      return <ColorField value={[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1]} onChange={(x) => set([...x])} />;
    }
    case 'point': {
      const p = (Array.isArray(v) ? v : [0.5, 0.5]) as number[];
      return <>
        <NumberField value={(p[0] ?? 0) * 100} onChange={(x) => set([x / 100, p[1] ?? 0])} step={0.5} unit="%" precision={1} />
        <NumberField value={(p[1] ?? 0) * 100} onChange={(x) => set([p[0] ?? 0, x / 100])} step={0.5} unit="%" precision={1} />
      </>;
    }
    case 'bool': return <Toggle on={!!(typeof v === 'boolean' ? v : paramNum(v))} onChange={set} />;
    case 'choice': return <Select value={Math.round(paramNum(v))} onChange={set} options={k.options.map((o, i) => ({ value: i, label: o }))} />;
    case 'file': return <FileParam value={typeof v === 'string' ? v : ''} exts={k.extensions} set={set} />;
    default: return null;
  }
}

function FileParam({ value, exts, set }: { value: string; exts: string[]; set: (v: string) => void }) {
  const [luts, setLuts] = useState<string[]>([]);
  useEffect(() => { if (isTauri && exts.includes('cube')) void api.listLuts().then(setLuts).catch(() => {}); }, [exts]);
  const browse = async () => {
    if (!isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ multiple: false, filters: [{ name: exts.join(', ').toUpperCase(), extensions: exts }] });
    if (typeof p === 'string') set(p);
  };
  const short = value ? value.split(/[\\/]/).pop() : 'None';
  return <>
    <span className="fx-file" title={value || 'No file'}>{short}</span>
    <button className="icon-btn sm" title="Browse" onClick={browse}><FolderOpen size={12} /></button>
    {luts.length > 0 && (
      <Select value={luts.includes(value) ? value : ''} onChange={(x) => x && set(x)} width={70}
        options={[{ value: '', label: 'Library…' }, ...luts.map((l) => ({ value: l, label: l.split(/[\\/]/).pop() ?? l }))]} />
    )}
  </>;
}

// ---------------------------------------------------------------- curve editor

function monotone(points: [number, number][], x: number): number {
  const p = [...points].filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).sort((a, b) => a[0] - b[0]);
  if (p.length === 0) return x;
  if (p.length === 1 || x <= p[0][0]) return p[0][1];
  if (x >= p[p.length - 1][0]) return p[p.length - 1][1];
  const n = p.length;
  const d = p.slice(0, -1).map((q, i) => (p[i + 1][1] - q[1]) / Math.max(p[i + 1][0] - q[0], 1e-9));
  const m = p.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  let i = 0;
  while (i < n - 2 && x > p[i + 1][0]) i++;
  const h = p[i + 1][0] - p[i][0];
  const t = (x - p[i][0]) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
}

const CURVE_COLOR: Record<string, string> = { red: '#e4646c', green: '#8fbf9a', blue: '#7fb2e5' };

function CurveRow({ layer, path, def }: { layer: Layer; path: string; def: ParamDef }) {
  const time = useEditor((s) => s.time);
  const prop = getPath(layer, path) as { value: ParamValue; keys?: { t: number; v: ParamValue }[] };
  const raw = propAt(prop as never, time - layer.start) as unknown as string;
  let pts: [number, number][];
  try { pts = JSON.parse(typeof raw === 'string' ? raw : String(def.default)); } catch { pts = [[0, 0], [1, 1]]; }
  const set = (np: [number, number][]) => writeProps([{ layerId: layer.id, path, value: JSON.stringify(np.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])) }], `Edit ${def.label}`, `curve:${layer.id}:${path}`);
  const key = path.split('.').pop()!;
  const W = 220, H = 110;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const toUnit = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const d = Array.from({ length: 65 }, (_, i) => { const x = i / 64; return `${i ? 'L' : 'M'}${(x * W).toFixed(1)} ${((1 - Math.min(1, Math.max(0, monotone(pts, x)))) * H).toFixed(1)}`; }).join(' ');
  return (
    <div className="curve-row">
      <div className="row"><span className="label grow">{def.label}</span>
        <button className="icon-btn sm" title="Reset curve" onClick={() => set(JSON.parse(String(def.default)))}><RotateCcw size={11} /></button>
      </div>
      <svg ref={svg} className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const u = toUnit(e);
          let idx = pts.findIndex((p) => Math.hypot((p[0] - u[0]) * W, (p[1] - u[1]) * H) < 8);
          if (idx < 0) { const np = [...pts, u].sort((a, b) => a[0] - b[0]); idx = np.indexOf(u); set(np); pts = np; }
          drag.current = idx;
        }}
        onPointerMove={(e) => {
          if (drag.current == null) return;
          const u = toUnit(e);
          const np = pts.map((p, i) => (i === drag.current ? u : p));
          set(np);
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const u = toUnit(e as unknown as React.PointerEvent);
          const idx = pts.findIndex((p) => Math.hypot((p[0] - u[0]) * W, (p[1] - u[1]) * H) < 8);
          if (idx >= 0 && pts.length > 2) set(pts.filter((_, i) => i !== idx));
        }}>
        {[0.25, 0.5, 0.75].map((g) => <g key={g}><line x1={g * W} y1={0} x2={g * W} y2={H} className="curve-grid" /><line x1={0} y1={g * H} x2={W} y2={g * H} className="curve-grid" /></g>)}
        <path d={d} className="curve-line" style={{ stroke: CURVE_COLOR[key] }} />
        {pts.map((p, i) => <circle key={i} cx={p[0] * W} cy={(1 - p[1]) * H} r={3.5} className="curve-pt" />)}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- colour wheels (lift / gamma / gain / offset)

const K = 0.3;
function ColorWheels({ layer, path }: { layer: Layer; path: string }) {
  return (
    <div className="wheels">
      {['lift', 'gamma', 'gain', 'offset'].map((k) => <Wheel key={k} layer={layer} path={`${path}.${k}`} label={k[0].toUpperCase() + k.slice(1)} />)}
    </div>
  );
}

function Wheel({ layer, path, label }: { layer: Layer; path: string; label: string }) {
  const time = useEditor((s) => s.time);
  const prop = getPath(layer, path) as { value: ParamValue } | undefined;
  const ref = useRef<HTMLDivElement>(null);
  if (!prop) return null;
  const v = (propAt(prop as never, time - layer.start) as unknown as number[]) ?? [0, 0, 0, 0];
  const [r, g, b, m] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0];
  const x = (r - (g + b) / 2) / (1.5 * K), y = (g - b) / (Math.sqrt(3) * K);
  const set = (nv: number[]) => writeProps([{ layerId: layer.id, path, value: nv }], `Grade ${label}`, `wheel:${layer.id}:${path}`);
  const fromPointer = (e: React.PointerEvent) => {
    const rc = ref.current!.getBoundingClientRect();
    let px = ((e.clientX - rc.left) / rc.width) * 2 - 1, py = -(((e.clientY - rc.top) / rc.height) * 2 - 1);
    const len = Math.hypot(px, py);
    if (len > 1) { px /= len; py /= len; }
    const s = e.shiftKey ? 0.25 : 1;
    set([px * K * s, (-px / 2 + (py * Math.sqrt(3)) / 2) * K * s, (-px / 2 - (py * Math.sqrt(3)) / 2) * K * s, m]);
  };
  return (
    <div className="wheel-wrap">
      <div ref={ref} className="wheel" onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); fromPointer(e); }} onPointerMove={(e) => e.buttons && fromPointer(e)}
        onDoubleClick={() => set([0, 0, 0, m])} title={`${label}: drag to push colour, double-click to reset`}>
        <i className="wheel-puck" style={{ left: `${50 + Math.max(-1, Math.min(1, x)) * 50}%`, top: `${50 - Math.max(-1, Math.min(1, y)) * 50}%` }} />
      </div>
      <span className="label">{label}</span>
      <Slider value={m} min={-0.5} max={0.5} step={0.005} onChange={(nm) => set([r, g, b, nm])} width={64} />
      <span className="mono muted wheel-val">{m >= 0 ? '+' : ''}{m.toFixed(2)}</span>
    </div>
  );
}
