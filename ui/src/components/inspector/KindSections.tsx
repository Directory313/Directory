// Layer-type specific inspector sections.
import { useEffect, useState, type ReactNode } from 'react';
import type { Draft } from 'immer';
import { Plus, Trash2, Upload } from 'lucide-react';
import type { Color, Fill, Geometry, Keyframe, Layer, LayerKind, ShapeItem, Stroke, TextAnimator, TextUnit, Gradient } from '../../types/project';
import { newLocalId, useEditor } from '../../store/editor';
import { api, isTauri } from '../../lib/api';
import { propAt, EASE_IN_HANDLE, EASE_OUT_HANDLE, HANDLE_IN_LINEAR, HANDLE_OUT_LINEAR } from '../../lib/anim';
import { ColorField, NumberField, Popover, Section, Select, Toggle, Menu } from '../ui/primitives';
import { ColorRow, NumRow, PlainRow, PropRow, VecRow } from './PropRow';
import { editLayers, P, writeProps } from './util';

const S = () => useEditor.getState();
type K<T extends LayerKind['type']> = Extract<LayerKind, { type: T }>;
const ed = (l: Layer, label: string, fn: (d: Draft<Layer>) => void, co?: string) => editLayers([l.id], label, fn, co);
const kf = <T,>(t: number, v: T, ease = false): Keyframe<T> => ({ t, v, interp: ease ? 'bezier' : 'linear', outH: ease ? EASE_OUT_HANDLE : HANDLE_OUT_LINEAR, inH: ease ? EASE_IN_HANDLE : HANDLE_IN_LINEAR });
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).replace(/([A-Z])/g, ' $1');

function Num({ value, onChange, ...rest }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; precision?: number }) {
  return <NumberField value={value} onChange={onChange} {...rest} />;
}

// ---------------------------------------------------------------- text

let fontCache: string[] | null = null;
function useFonts() {
  const [fonts, setFonts] = useState<string[]>(fontCache ?? []);
  useEffect(() => { if (!fontCache && isTauri) void api.fonts().then((f) => { fontCache = f; setFonts(f); }).catch(() => {}); }, []);
  return [fonts, () => { fontCache = null; if (isTauri) void api.fonts().then((f) => { fontCache = f; setFonts(f); }); }] as const;
}

function makeAnimator(name: string, unit: TextUnit, lt: number, preset?: string): TextAnimator {
  const a: TextAnimator = {
    id: newLocalId(), name, unit, start: P(0), end: P(100), offset: P(0), smoothness: 0,
    opacity: P(100), position: P([0, 0]), scale: P(100), rotation: P(0), tracking: P(0), fill: null,
  };
  switch (preset) {
    case 'typewriter': a.opacity = P(0); a.start = { value: 0, keys: [kf(lt, 0), kf(lt + 2, 100)] }; break;
    case 'fadeUp': a.opacity = P(0); a.position = P([0, 40]); a.smoothness = 100; a.start = { value: 0, keys: [kf(lt, 0, true), kf(lt + 1.5, 100, true)] }; break;
    case 'scalePop': a.opacity = P(0); a.scale = P(0); a.smoothness = 100; a.start = { value: 0, keys: [kf(lt, 0, true), kf(lt + 1.2, 100, true)] }; break;
    case 'trackingIn': a.tracking = { value: 0, keys: [kf(lt, 400, true), kf(lt + 1.5, 0, true)] }; a.opacity = { value: 100, keys: [kf(lt, 0), kf(lt + 0.8, 100)] }; break;
  }
  return a;
}

export function TextSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'text'>;
  const time = useEditor((s) => s.time);
  const [fonts, refreshFonts] = useFonts();
  const [presetMenu, setPresetMenu] = useState<HTMLElement | null>(null);
  const lt = time - layer.start;
  const L = [layer];
  const text = propAt(k.text, lt);
  const importFont = async () => {
    if (!isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ multiple: false, filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'woff2'] }] });
    if (typeof p !== 'string') return;
    try { await api.importFont(p); refreshFonts(); S().toast('success', 'Font imported'); } catch (e) { S().toast('error', 'Font import failed', String(e)); }
  };
  const addAnim = (preset?: string, label = 'Animator') => ed(layer, 'Add Text Animator', (l) => {
    if (l.kind.type === 'text') l.kind.animators.push(makeAnimator(`${label} ${l.kind.animators.length + 1}`, preset === 'fadeUp' ? 'words' : 'characters', lt, preset) as Draft<TextAnimator>);
  });
  return (
    <>
      <Section title="Text" id="insp-text">
        <PropRow<string> layers={L} path="kind.text" label="Source Text">{() => null}</PropRow>
        <textarea className="input text-src" rows={3} value={text} onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => { const v = e.target.value; writeProps([{ layerId: layer.id, path: 'kind.text', value: v }], 'Edit Text', `text:${layer.id}`); ed(layer, 'Rename', (l) => { l.name = v.split('\n')[0].slice(0, 24) || 'Text'; }, `text:${layer.id}`); }} />
        <PlainRow label="Font">
          <input className="input grow" list="veyra-fonts" value={k.fontFamily} onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => ed(layer, 'Font', (l) => { if (l.kind.type === 'text') l.kind.fontFamily = e.target.value; }, `font:${layer.id}`)} />
          <datalist id="veyra-fonts">{fonts.map((f) => <option key={f} value={f} />)}</datalist>
          <button className="icon-btn sm" title="Import font file" onClick={importFont}><Upload size={11} /></button>
        </PlainRow>
        <PlainRow label="Weight / Style">
          <Select value={k.fontWeight} onChange={(v) => ed(layer, 'Font Weight', (l) => { if (l.kind.type === 'text') l.kind.fontWeight = v; })}
            options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: String(w) }))} />
          <label className="row label"><input type="checkbox" checked={k.italic} onChange={(e) => ed(layer, 'Italic', (l) => { if (l.kind.type === 'text') l.kind.italic = e.target.checked; })} />Italic</label>
        </PlainRow>
        <NumRow layers={L} path="kind.fontSize" label="Size" min={1} max={2000} unit="px" />
        <NumRow layers={L} path="kind.tracking" label="Tracking" min={-500} max={2000} />
        <NumRow layers={L} path="kind.lineHeight" label="Line Spacing" min={0.3} max={5} step={0.01} precision={2} />
        <ColorRow layers={L} path="kind.fill" label="Fill" />
        <ColorRow layers={L} path="kind.stroke" label="Stroke" />
        <NumRow layers={L} path="kind.strokeWidth" label="Stroke Width" min={0} max={200} unit="px" />
        <GradientRow value={k.gradient ?? null} set={(g) => ed(layer, 'Text Gradient', (l) => { if (l.kind.type === 'text') l.kind.gradient = g as Draft<Gradient> | null; })} base={propAt(k.fill, lt)} />
        <PlainRow label="Align">
          <Select value={k.align} onChange={(v) => ed(layer, 'Align', (l) => { if (l.kind.type === 'text') l.kind.align = v; })} options={['left', 'center', 'right'].map((x) => ({ value: x as 'left', label: cap(x) }))} />
          <Select value={k.valign} onChange={(v) => ed(layer, 'Vertical Align', (l) => { if (l.kind.type === 'text') l.kind.valign = v; })} options={['top', 'middle', 'bottom'].map((x) => ({ value: x as 'top', label: cap(x) }))} />
        </PlainRow>
        <PlainRow label="Box Width" title="0 = point text (no wrapping)">
          <Num value={k.boxWidth} min={0} max={16000} unit="px" precision={0} onChange={(v) => ed(layer, 'Text Box', (l) => { if (l.kind.type === 'text') l.kind.boxWidth = v; }, `tbw:${layer.id}`)} />
        </PlainRow>
        <PlainRow label="Background">
          <Toggle on={!!k.background} onChange={(v) => ed(layer, 'Text Background', (l) => { if (l.kind.type === 'text') l.kind.background = v ? { color: P<Color>([0, 0, 0, 0.6]), padding: 16, radius: 8 } as never : null; })} />
          {k.background && <>
            <Num value={k.background.padding} min={0} max={400} unit="px pad" precision={0} onChange={(v) => ed(layer, 'Background Padding', (l) => { if (l.kind.type === 'text' && l.kind.background) l.kind.background.padding = v; }, `tbp:${layer.id}`)} />
            <Num value={k.background.radius} min={0} max={400} unit="px r" precision={0} onChange={(v) => ed(layer, 'Background Radius', (l) => { if (l.kind.type === 'text' && l.kind.background) l.kind.background.radius = v; }, `tbr:${layer.id}`)} />
          </>}
        </PlainRow>
        {k.background && <ColorRow layers={L} path="kind.background.color" label="Background Colour" />}
        {layer.is3d && (
          <PlainRow label="Extrude" title="Extrusion depth for real 3D text geometry (0 = flat card)">
            <Num value={k.extrude} min={0} max={2000} unit="px" precision={0} onChange={(v) => ed(layer, 'Extrude', (l) => { if (l.kind.type === 'text') l.kind.extrude = v; }, `ext:${layer.id}`)} />
          </PlainRow>
        )}
      </Section>
      <Section title="Text Animators" id="insp-textanim" actions={<>
        <button className="icon-btn sm" title="Add animator" onClick={() => addAnim()}><Plus size={12} /></button>
        <button className="btn sm ghost" onClick={(e) => setPresetMenu(e.currentTarget)}>Presets</button>
      </>}>
        {presetMenu && <Popover anchor={presetMenu} onClose={() => setPresetMenu(null)}><Menu onClose={() => setPresetMenu(null)} items={[
          { label: 'Typewriter', action: () => addAnim('typewriter', 'Typewriter') },
          { label: 'Fade Up by Word', action: () => addAnim('fadeUp', 'Fade Up') },
          { label: 'Scale Pop by Character', action: () => addAnim('scalePop', 'Scale Pop') },
          { label: 'Tracking In', action: () => addAnim('trackingIn', 'Tracking In') },
        ]} /></Popover>}
        {k.animators.length === 0 && <div className="muted hint">Animate characters, words or lines with range selectors. Try a preset.</div>}
        {k.animators.map((a) => {
          const b = `kind.animators.${a.id}`;
          return (
            <div key={a.id} className="sub-card">
              <div className="row sub-head">
                <input className="input grow" value={a.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => ed(layer, 'Rename Animator', (l) => { if (l.kind.type === 'text') { const x = l.kind.animators.find((q) => q.id === a.id); if (x) x.name = e.target.value; } }, `an:${a.id}`)} />
                <Select value={a.unit} onChange={(v) => ed(layer, 'Animator Unit', (l) => { if (l.kind.type === 'text') { const x = l.kind.animators.find((q) => q.id === a.id); if (x) x.unit = v; } })} options={(['characters', 'words', 'lines'] as TextUnit[]).map((u) => ({ value: u, label: cap(u) }))} />
                <button className="icon-btn sm" title="Remove animator" onClick={() => ed(layer, 'Remove Animator', (l) => { if (l.kind.type === 'text') l.kind.animators = l.kind.animators.filter((q) => q.id !== a.id); })}><Trash2 size={11} /></button>
              </div>
              <NumRow layers={L} path={`${b}.start`} label="Range Start" min={0} max={100} unit="%" />
              <NumRow layers={L} path={`${b}.end`} label="Range End" min={0} max={100} unit="%" />
              <NumRow layers={L} path={`${b}.offset`} label="Offset" min={-100} max={100} unit="%" />
              <PlainRow label="Smoothness"><Num value={a.smoothness} min={0} max={100} unit="%" precision={0} onChange={(v) => ed(layer, 'Smoothness', (l) => { if (l.kind.type === 'text') { const x = l.kind.animators.find((q) => q.id === a.id); if (x) x.smoothness = v; } }, `as:${a.id}`)} /></PlainRow>
              <NumRow layers={L} path={`${b}.opacity`} label="Opacity" min={0} max={100} unit="%" />
              <VecRow layers={L} path={`${b}.position`} label="Position" />
              <NumRow layers={L} path={`${b}.scale`} label="Scale" unit="%" />
              <NumRow layers={L} path={`${b}.rotation`} label="Rotation" unit="°" />
              <NumRow layers={L} path={`${b}.tracking`} label="Tracking" />
              <PlainRow label="Fill Colour">
                <Toggle on={!!a.fill} onChange={(v) => ed(layer, 'Animator Fill', (l) => { if (l.kind.type === 'text') { const x = l.kind.animators.find((q) => q.id === a.id); if (x) x.fill = v ? P<Color>([0.95, 0.55, 0.59, 1]) as never : null; } })} />
              </PlainRow>
              {a.fill && <ColorRow layers={L} path={`${b}.fill`} label="Animated Fill" />}
            </div>
          );
        })}
      </Section>
    </>
  );
}

function GradientRow({ value, set, base }: { value: Gradient | null; set: (g: Gradient | null) => void; base: Color }) {
  return (
    <>
      <PlainRow label="Gradient">
        <Toggle on={!!value} onChange={(v) => set(v ? { radial: false, start: [-150, 0], end: [150, 0], stops: [{ pos: 0, color: base }, { pos: 1, color: [0.95, 0.55, 0.59, 1] }] } : null)} />
        {value && <>
          <ColorField value={value.stops[0]?.color ?? base} onChange={(c) => set({ ...value, stops: [{ pos: 0, color: c }, ...value.stops.slice(1)] })} />
          <ColorField value={value.stops[value.stops.length - 1]?.color ?? base} onChange={(c) => set({ ...value, stops: [...value.stops.slice(0, -1), { pos: 1, color: c }] })} />
          <label className="row label"><input type="checkbox" checked={value.radial} onChange={(e) => set({ ...value, radial: e.target.checked })} />Radial</label>
        </>}
      </PlainRow>
      {value && (
        <PlainRow label="Gradient Span">
          <Num value={value.start[0]} onChange={(x) => set({ ...value, start: [x, value.start[1]] })} precision={0} />
          <Num value={value.start[1]} onChange={(y) => set({ ...value, start: [value.start[0], y] })} precision={0} />
          <span className="muted">→</span>
          <Num value={value.end[0]} onChange={(x) => set({ ...value, end: [x, value.end[1]] })} precision={0} />
          <Num value={value.end[1]} onChange={(y) => set({ ...value, end: [value.end[0], y] })} precision={0} />
        </PlainRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------- shapes

export function ShapeSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'shape'>;
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const time = useEditor((s) => s.time);
  const L = [layer];
  const item = (id: string, label: string, fn: (it: Draft<ShapeItem>) => void, co?: string) =>
    ed(layer, label, (l) => { if (l.kind.type === 'shape') { const it = l.kind.items.find((x) => x.id === id); if (it) fn(it); } }, co);
  const addItem = async (kind: string) => {
    const it = await api.createShapeItem(kind, 200);
    ed(layer, 'Add Shape', (l) => { if (l.kind.type === 'shape') l.kind.items.unshift(it as Draft<ShapeItem>); });
  };
  return (
    <Section title="Shape" id="insp-shape" actions={<button className="icon-btn sm" title="Add shape item" onClick={(e) => setAdding(e.currentTarget)}><Plus size={12} /></button>}>
      {adding && <Popover anchor={adding} onClose={() => setAdding(null)}><Menu onClose={() => setAdding(null)} items={['rect', 'roundedRect', 'ellipse', 'polygon', 'star', 'triangle', 'line', 'arrow'].map((x) => ({ label: cap(x), action: () => { void addItem(x); } }))} /></Popover>}
      <PlainRow label="Combine" title="How items combine (pixel boolean operation)">
        <Select value={k.combine} onChange={(v) => ed(layer, 'Shape Combine', (l) => { if (l.kind.type === 'shape') l.kind.combine = v; })}
          options={(['none', 'union', 'subtract', 'intersect', 'exclude'] as const).map((x) => ({ value: x, label: cap(x) }))} />
      </PlainRow>
      {layer.is3d && <PlainRow label="Extrude"><Num value={k.extrude} min={0} max={2000} unit="px" precision={0} onChange={(v) => ed(layer, 'Extrude', (l) => { if (l.kind.type === 'shape') l.kind.extrude = v; }, `sext:${layer.id}`)} /></PlainRow>}
      {k.items.map((it) => {
        const b = `kind.items.${it.id}`;
        return (
          <div key={it.id} className="sub-card">
            <div className="row sub-head">
              <input className="input grow" value={it.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => item(it.id, 'Rename Shape', (x) => { x.name = e.target.value; }, `sn:${it.id}`)} />
              <span className="pill">{it.geometry.type}</span>
              <button className="icon-btn sm" title="Delete shape item" disabled={k.items.length <= 1} onClick={() => ed(layer, 'Delete Shape', (l) => { if (l.kind.type === 'shape') l.kind.items = l.kind.items.filter((x) => x.id !== it.id); })}><Trash2 size={11} /></button>
            </div>
            <GeometryRows layer={layer} g={it.geometry} base={`${b}.geometry`} star={(v) => item(it.id, 'Star', (x) => { if (x.geometry.type === 'polygon') x.geometry.star = v; })} />
            <VecRow layers={L} path={`${b}.offset`} label="Offset" />
            <NumRow layers={L} path={`${b}.rotation`} label="Rotation" unit="°" />
            {it.fills.map((f, i) => (
              <FillRows key={`f${i}`} layer={layer} f={f} base={`${b}.fills.${i}`} lt={time - layer.start}
                set={(fn) => item(it.id, 'Edit Fill', (x) => fn(x.fills[i]))} remove={() => item(it.id, 'Remove Fill', (x) => { x.fills.splice(i, 1); })} />
            ))}
            {it.strokes.map((s, i) => (
              <StrokeRows key={`s${i}`} layer={layer} s={s} base={`${b}.strokes.${i}`}
                set={(fn, co) => item(it.id, 'Edit Stroke', (x) => fn(x.strokes[i]), co)} remove={() => item(it.id, 'Remove Stroke', (x) => { x.strokes.splice(i, 1); })} />
            ))}
            <div className="row" style={{ margin: '4px 0' }}>
              <button className="btn sm ghost" onClick={() => item(it.id, 'Add Fill', (x) => { x.fills.push({ color: P<Color>([1, 1, 1, 1]), gradient: null, opacity: P(100), enabled: true } as Draft<Fill>); })}><Plus size={11} /> Fill</button>
              <button className="btn sm ghost" onClick={() => item(it.id, 'Add Stroke', (x) => { x.strokes.push({ color: P<Color>([1, 1, 1, 1]), gradient: null, width: P(4), opacity: P(100), cap: 'round', join: 'round', align: 'center', dashes: [], dashOffset: P(0), enabled: true } as Draft<Stroke>); })}><Plus size={11} /> Stroke</button>
              <label className="row label"><input type="checkbox" checked={!!it.repeater} onChange={(e) => item(it.id, 'Repeater', (x) => { x.repeater = e.target.checked ? { copies: P(5), offset: P([60, 0]), rotation: P(0), scale: P(100), opacityEnd: P(100), radial: false, radius: P(150) } as never : null; })} />Repeater</label>
              <label className="row label"><input type="checkbox" checked={!!it.trim} onChange={(e) => item(it.id, 'Trim Paths', (x) => { x.trim = e.target.checked ? { start: P(0), end: P(100), offset: P(0) } as never : null; })} />Trim</label>
            </div>
            {it.repeater && <>
              <NumRow layers={L} path={`${b}.repeater.copies`} label="Copies" min={1} max={1000} precision={0} />
              <PlainRow label="Radial"><Toggle on={it.repeater.radial} onChange={(v) => item(it.id, 'Radial Repeater', (x) => { if (x.repeater) x.repeater.radial = v; })} /></PlainRow>
              {it.repeater.radial ? <NumRow layers={L} path={`${b}.repeater.radius`} label="Radius" unit="px" /> : <VecRow layers={L} path={`${b}.repeater.offset`} label="Copy Offset" />}
              <NumRow layers={L} path={`${b}.repeater.rotation`} label="Copy Rotation" unit="°" />
              {!it.repeater.radial && <NumRow layers={L} path={`${b}.repeater.scale`} label="Copy Scale" unit="%" />}
              <NumRow layers={L} path={`${b}.repeater.opacityEnd`} label="End Opacity" min={0} max={100} unit="%" />
            </>}
            {it.trim && <>
              <NumRow layers={L} path={`${b}.trim.start`} label="Trim Start" min={0} max={100} unit="%" slider />
              <NumRow layers={L} path={`${b}.trim.end`} label="Trim End" min={0} max={100} unit="%" slider />
              <NumRow layers={L} path={`${b}.trim.offset`} label="Trim Offset" unit="°" />
            </>}
          </div>
        );
      })}
    </Section>
  );
}

function GeometryRows({ layer, g, base, star }: { layer: Layer; g: Geometry; base: string; star: (v: boolean) => void }) {
  const L = [layer];
  switch (g.type) {
    case 'rect': return <><VecRow layers={L} path={`${base}.size`} label="Size" /><NumRow layers={L} path={`${base}.roundness`} label="Roundness" min={0} unit="px" /></>;
    case 'ellipse': return <VecRow layers={L} path={`${base}.size`} label="Size" />;
    case 'polygon': return <>
      <PlainRow label="Star"><Toggle on={g.star} onChange={star} /></PlainRow>
      <NumRow layers={L} path={`${base}.points`} label="Points" min={3} max={100} precision={0} />
      <NumRow layers={L} path={`${base}.outerRadius`} label="Outer Radius" min={0} unit="px" />
      {g.star && <NumRow layers={L} path={`${base}.innerRadius`} label="Inner Radius" min={0} unit="px" />}
      <NumRow layers={L} path={`${base}.roundness`} label="Roundness" unit="%" />
    </>;
    case 'line': return <VecRow layers={L} path={`${base}.to`} label="End Point" />;
    case 'arrow': return <><VecRow layers={L} path={`${base}.to`} label="End Point" /><NumRow layers={L} path={`${base}.head`} label="Head Size" min={0} unit="px" /></>;
    case 'path': return <PropRow<{ vertices: unknown[] }> layers={L} path={`${base}.path`} label="Path" title="Keyframe the path to morph the shape">{(v) => <span className="muted">{v.vertices.length} points · draw with the Pen tool</span>}</PropRow>;
  }
}

function FillRows({ layer, f, base, set, remove, lt }: { layer: Layer; f: Fill; base: string; lt: number; set: (fn: (f: Draft<Fill>) => void) => void; remove: () => void }) {
  const L = [layer];
  return (
    <div className="sub-group">
      <PlainRow label={<span className="row">Fill <Toggle on={f.enabled} onChange={(v) => set((x) => { x.enabled = v; })} /></span>}>
        <span className="grow" />
        <button className="icon-btn sm" title="Remove fill" onClick={remove}><Trash2 size={11} /></button>
      </PlainRow>
      <ColorRow layers={L} path={`${base}.color`} label="Colour" />
      <NumRow layers={L} path={`${base}.opacity`} label="Opacity" min={0} max={100} unit="%" slider />
      <GradientRow value={f.gradient ?? null} set={(g) => set((x) => { x.gradient = g as Draft<Gradient> | null; })} base={propAt(f.color, lt)} />
    </div>
  );
}

function StrokeRows({ layer, s, base, set, remove }: { layer: Layer; s: Stroke; base: string; set: (fn: (s: Draft<Stroke>) => void, co?: string) => void; remove: () => void }) {
  const L = [layer];
  const [dash, setDash] = useState(s.dashes.join(' '));
  useEffect(() => setDash(s.dashes.join(' ')), [s.dashes]);
  return (
    <div className="sub-group">
      <PlainRow label={<span className="row">Stroke <Toggle on={s.enabled} onChange={(v) => set((x) => { x.enabled = v; })} /></span>}>
        <span className="grow" />
        <button className="icon-btn sm" title="Remove stroke" onClick={remove}><Trash2 size={11} /></button>
      </PlainRow>
      <ColorRow layers={L} path={`${base}.color`} label="Colour" />
      <NumRow layers={L} path={`${base}.width`} label="Width" min={0} max={500} unit="px" />
      <NumRow layers={L} path={`${base}.opacity`} label="Opacity" min={0} max={100} unit="%" slider />
      <PlainRow label="Cap / Join / Align">
        <Select value={s.cap} onChange={(v) => set((x) => { x.cap = v; })} options={(['butt', 'round', 'square'] as const).map((x) => ({ value: x, label: cap(x) }))} />
        <Select value={s.join} onChange={(v) => set((x) => { x.join = v; })} options={(['miter', 'round', 'bevel'] as const).map((x) => ({ value: x, label: cap(x) }))} />
        <Select value={s.align} onChange={(v) => set((x) => { x.align = v; })} options={(['center', 'inside', 'outside'] as const).map((x) => ({ value: x, label: cap(x) }))} />
      </PlainRow>
      <PlainRow label="Dashes" title="Dash and gap lengths in px, e.g. “20 10”">
        <input className="input grow mono" value={dash} placeholder="none" onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => setDash(e.target.value)}
          onBlur={() => set((x) => { x.dashes = dash.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0); })} />
      </PlainRow>
      {s.dashes.length > 0 && <NumRow layers={L} path={`${base}.dashOffset`} label="Dash Offset" unit="px" />}
    </div>
  );
}

// ---------------------------------------------------------------- solid / camera / light / mesh / material

export function SolidSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'solid'>;
  return (
    <Section title="Solid" id="insp-solid">
      <ColorRow layers={[layer]} path="kind.color" label="Colour" />
      <PlainRow label="Size">
        <Num value={k.width} min={1} max={16384} precision={0} onChange={(v) => ed(layer, 'Solid Size', (l) => { if (l.kind.type === 'solid') l.kind.width = Math.round(v); }, `sw:${layer.id}`)} />
        <Num value={k.height} min={1} max={16384} precision={0} onChange={(v) => ed(layer, 'Solid Size', (l) => { if (l.kind.type === 'solid') l.kind.height = Math.round(v); }, `sh:${layer.id}`)} />
      </PlainRow>
    </Section>
  );
}

export function CameraSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'camera'>;
  const L = [layer];
  const time = useEditor((s) => s.time);
  const compH = useEditor((s) => s.project?.compositions.find((c) => c.id === s.compId)?.height ?? 1080);
  const set = (label: string, fn: (c: Draft<K<'camera'>>) => void, co?: string) => ed(layer, label, (l) => { if (l.kind.type === 'camera') fn(l.kind); }, co);
  return (
    <Section title="Camera" id="insp-camera">
      <PlainRow label="Projection"><Select value={k.projection} onChange={(v) => set('Projection', (c) => { c.projection = v; })} options={[{ value: 'perspective', label: 'Perspective' }, { value: 'orthographic', label: 'Orthographic' }]} /></PlainRow>
      <NumRow layers={L} path="kind.zoom" label="Zoom" min={1} unit="px" />
      <PlainRow label="Field of View">
        <span className="muted mono">{((2 * Math.atan(compH / 2 / Math.max(1, propAt(k.zoom, time - layer.start))) * 180) / Math.PI).toFixed(1)}° vertical</span>
      </PlainRow>
      <PlainRow label="Point of Interest"><Toggle on={k.usePointOfInterest} onChange={(v) => set('Point of Interest', (c) => { c.usePointOfInterest = v; })} /></PlainRow>
      {k.usePointOfInterest && <VecRow layers={L} path="kind.pointOfInterest" label="Target" dims={3} />}
      <PlainRow label="Depth of Field"><Toggle on={k.depthOfField} onChange={(v) => set('Depth of Field', (c) => { c.depthOfField = v; })} /></PlainRow>
      {k.depthOfField && <>
        <NumRow layers={L} path="kind.focusDistance" label="Focus Distance" min={1} unit="px" />
        <NumRow layers={L} path="kind.aperture" label="Aperture" min={0} unit="px" />
      </>}
      <PlainRow label="Clipping">
        <Num value={k.near} min={0.1} unit=" near" onChange={(v) => set('Camera Clipping', (c) => { c.near = v; }, `cn:${layer.id}`)} />
        <Num value={k.far} min={1} unit=" far" precision={0} onChange={(v) => set('Camera Clipping', (c) => { c.far = v; }, `cf:${layer.id}`)} />
      </PlainRow>
    </Section>
  );
}

export function LightSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'light'>;
  const L = [layer];
  const point = ['point', 'spot', 'area'].includes(k.light);
  return (
    <Section title="Light" id="insp-light">
      <PlainRow label="Type">
        <Select value={k.light} onChange={(v) => ed(layer, 'Light Type', (l) => { if (l.kind.type === 'light') l.kind.light = v; })}
          options={(['point', 'directional', 'spot', 'area', 'ambient', 'environment'] as const).map((x) => ({ value: x, label: cap(x) }))} />
      </PlainRow>
      <ColorRow layers={L} path="kind.color" label="Colour" alpha={false} />
      <NumRow layers={L} path="kind.intensity" label="Intensity" min={0} unit="%" />
      {point && <NumRow layers={L} path="kind.range" label="Range" min={1} unit="px" />}
      {point && <NumRow layers={L} path="kind.falloff" label="Falloff" min={0.01} max={8} step={0.01} precision={2} />}
      {k.light === 'spot' && <>
        <NumRow layers={L} path="kind.coneAngle" label="Cone Angle" min={1} max={179} unit="°" />
        <NumRow layers={L} path="kind.coneFeather" label="Cone Feather" min={0} max={100} unit="%" />
      </>}
      {k.light === 'area' && <NumRow layers={L} path="kind.size" label="Size" min={1} unit="px" />}
      <div className="muted hint">Lights illuminate mesh and extruded 3D layers. Direction follows the layer's rotation. Shadows are not rendered in this beta.</div>
    </Section>
  );
}

export function MeshSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'mesh'>;
  const prim = k.primitive as unknown as Record<string, unknown>;
  const fields = Object.keys(prim).filter((f) => typeof prim[f] === 'number' && f !== 'node');
  const project = useEditor((s) => s.project);
  return (
    <Section title="Mesh" id="insp-mesh">
      <PlainRow label="Primitive"><span className="pill">{k.primitive.type}</span>
        {k.primitive.type === 'imported' && <span className="muted">{project?.assets.find((a) => a.id === (k.primitive as { asset: string }).asset)?.name}</span>}
      </PlainRow>
      {fields.map((f) => (
        <PlainRow key={f} label={cap(f)}>
          <Num value={prim[f] as number} min={['segments', 'rings', 'sides', 'subdivisions', 'cells'].includes(f) ? 1 : 0.1} precision={['segments', 'rings', 'sides', 'subdivisions', 'cells'].includes(f) ? 0 : 1}
            onChange={(v) => ed(layer, `Mesh ${cap(f)}`, (l) => { if (l.kind.type === 'mesh') (l.kind.primitive as unknown as Record<string, number>)[f] = ['segments', 'rings', 'sides', 'subdivisions', 'cells'].includes(f) ? Math.max(1, Math.round(v)) : v; }, `mesh:${layer.id}:${f}`)} />
        </PlainRow>
      ))}
      <PlainRow label="Smooth Shading"><Toggle on={k.smooth} onChange={(v) => ed(layer, 'Smooth Shading', (l) => { if (l.kind.type === 'mesh') l.kind.smooth = v; })} /></PlainRow>
      <PlainRow label="Wireframe"><Toggle on={k.wireframe} onChange={(v) => ed(layer, 'Wireframe', (l) => { if (l.kind.type === 'mesh') l.kind.wireframe = v; })} /></PlainRow>
    </Section>
  );
}

export function MaterialSection({ layer }: { layer: Layer }) {
  const L = [layer];
  const m = layer.material;
  const images = useEditor((s) => s.project?.assets.filter((a) => a.kind === 'image' || a.kind === 'video') ?? []);
  const set = (label: string, fn: (mm: Draft<Layer['material']>) => void, co?: string) => ed(layer, label, (l) => fn(l.material), co);
  return (
    <Section title="Material" id="insp-material">
      <PlainRow label="Lit" title="Respond to lights (off = flat, unlit colour)"><Toggle on={m.lit} onChange={(v) => set('Material Lit', (x) => { x.lit = v; })} /></PlainRow>
      {layer.kind.type === 'mesh' && <ColorRow layers={L} path="material.baseColor" label="Base Colour" />}
      <NumRow layers={L} path="material.metallic" label="Metallic" min={0} max={1} step={0.01} precision={2} slider />
      <NumRow layers={L} path="material.roughness" label="Roughness" min={0} max={1} step={0.01} precision={2} slider />
      <NumRow layers={L} path="material.specular" label="Specular" min={0} max={1} step={0.01} precision={2} slider />
      <ColorRow layers={L} path="material.emission" label="Emission" alpha={false} />
      <NumRow layers={L} path="material.emissionStrength" label="Emission Strength" min={0} max={20} step={0.01} precision={2} />
      {layer.kind.type === 'mesh' && <>
        <PlainRow label="Base Texture">
          <Select value={m.baseTexture ?? ''} onChange={(v) => set('Base Texture', (x) => { x.baseTexture = v || null; })} options={[{ value: '', label: 'None' }, ...images.map((a) => ({ value: a.id, label: a.name }))]} width="100%" />
        </PlainRow>
        <PlainRow label="UV Tiling">
          <Num value={m.uvTiling[0]} step={0.01} precision={2} onChange={(v) => set('UV Tiling', (x) => { x.uvTiling[0] = v; }, `uvt:${layer.id}`)} />
          <Num value={m.uvTiling[1]} step={0.01} precision={2} onChange={(v) => set('UV Tiling', (x) => { x.uvTiling[1] = v; }, `uvt:${layer.id}`)} />
        </PlainRow>
        <PlainRow label="UV Offset">
          <Num value={m.uvOffset[0]} step={0.01} precision={2} onChange={(v) => set('UV Offset', (x) => { x.uvOffset[0] = v; }, `uvo:${layer.id}`)} />
          <Num value={m.uvOffset[1]} step={0.01} precision={2} onChange={(v) => set('UV Offset', (x) => { x.uvOffset[1] = v; }, `uvo:${layer.id}`)} />
        </PlainRow>
      </>}
    </Section>
  );
}

// ---------------------------------------------------------------- particles / generator

export function ParticlesSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'particles'>;
  const L = [layer];
  const set = (label: string, fn: (p: Draft<K<'particles'>>) => void, co?: string) => ed(layer, label, (l) => { if (l.kind.type === 'particles') fn(l.kind); }, co);
  const num = (label: string, key: keyof K<'particles'>, o: { min?: number; max?: number; step?: number; precision?: number; unit?: string } = {}): ReactNode => (
    <PlainRow label={label}><Num value={k[key] as number} {...o} onChange={(v) => set(label, (p) => { (p as unknown as Record<string, number>)[key as string] = o.precision === 0 ? Math.round(v) : v; }, `pp:${layer.id}:${String(key)}`)} /></PlainRow>
  );
  return (
    <>
      <Section title="Emitter" id="insp-emitter">
        <PlainRow label="Shape"><Select value={k.emitter} onChange={(v) => set('Emitter Shape', (p) => { p.emitter = v; })} options={(['point', 'line', 'box', 'circle'] as const).map((x) => ({ value: x, label: cap(x) }))} /></PlainRow>
        {k.emitter !== 'point' && <VecRow layers={L} path="kind.emitterSize" label="Emitter Size" />}
        <NumRow layers={L} path="kind.rate" label="Birth Rate" min={0} unit="/s" />
        {num('Max Particles', 'maxParticles', { min: 1, max: 200000, precision: 0 })}
        <NumRow layers={L} path="kind.lifetime" label="Lifetime" min={0.01} step={0.01} unit="s" precision={2} />
        {num('Lifetime Random', 'lifetimeRandom', { min: 0, max: 1, step: 0.01, precision: 2 })}
        {num('Seed', 'seed', { min: 0, precision: 0 })}
      </Section>
      <Section title="Motion" id="insp-pmotion">
        <NumRow layers={L} path="kind.speed" label="Speed" min={0} unit="px/s" />
        {num('Speed Random', 'speedRandom', { min: 0, max: 1, step: 0.01, precision: 2 })}
        <NumRow layers={L} path="kind.direction" label="Direction" unit="°" />
        <NumRow layers={L} path="kind.spread" label="Spread" min={0} max={360} unit="°" />
        <VecRow layers={L} path="kind.gravity" label="Gravity" />
        {num('Drag', 'drag', { min: 0, max: 20, step: 0.01, precision: 2 })}
        <NumRow layers={L} path="kind.turbulence" label="Turbulence" min={0} unit="px" />
        {num('Turbulence Scale', 'turbulenceScale', { min: 1, precision: 0 })}
        {num('Rotation Speed', 'rotationSpeed', { unit: '°/s' })}
        <PlainRow label="Floor / Collision">
          <Toggle on={k.floor != null} onChange={(v) => set('Particle Floor', (p) => { p.floor = v ? 300 : null; })} />
          {k.floor != null && <Num value={k.floor} unit=" y" precision={0} onChange={(v) => set('Particle Floor', (p) => { p.floor = v; }, `pf:${layer.id}`)} />}
          {k.floor != null && <Num value={k.bounce} min={0} max={1} step={0.01} precision={2} unit=" bounce" onChange={(v) => set('Bounce', (p) => { p.bounce = v; }, `pb:${layer.id}`)} />}
        </PlainRow>
      </Section>
      <Section title="Appearance" id="insp-plook">
        <PlainRow label="Particle"><Select value={k.shape} onChange={(v) => set('Particle Shape', (p) => { p.shape = v; })} options={(['circle', 'square', 'star', 'spark'] as const).map((x) => ({ value: x, label: cap(x) }))} /></PlainRow>
        <NumRow layers={L} path="kind.size" label="Size" min={0} unit="px" />
        {num('Size Random', 'sizeRandom', { min: 0, max: 1, step: 0.01, precision: 2 })}
        {num('Size at Death', 'sizeEnd', { min: 0, max: 10, step: 0.01, precision: 2, unit: '×' })}
        <ColorRow layers={L} path="kind.color" label="Birth Colour" />
        <PlainRow label="Death Colour"><ColorField value={k.colorEnd} onChange={(c) => set('Death Colour', (p) => { p.colorEnd = c; }, `pce:${layer.id}`)} /></PlainRow>
        <NumRow layers={L} path="kind.opacity" label="Opacity" min={0} max={100} unit="%" slider />
        <PlainRow label="Fade Out"><Toggle on={k.fadeOut} onChange={(v) => set('Fade Out', (p) => { p.fadeOut = v; })} /></PlainRow>
        {num('Trail Length', 'trail', { min: 0, max: 16, precision: 0 })}
      </Section>
    </>
  );
}

export function GeneratorSection({ layer }: { layer: Layer }) {
  const k = layer.kind as K<'generator'>;
  const L = [layer];
  return (
    <Section title={`${cap(k.generator)} Generator`} id="insp-gen">
      {Object.entries(k.params).map(([key, p]) => {
        const path = `kind.params.${key}`;
        if (Array.isArray(p.value) && p.value.length === 4) return <ColorRow key={key} layers={L} path={path} label={cap(key)} />;
        if (typeof p.value === 'number') return <NumRow key={key} layers={L} path={path} label={cap(key)} unit={key === 'angle' ? '°' : undefined} step={key === 'speed' ? 0.01 : 1} precision={key === 'speed' ? 2 : 1} />;
        return null;
      })}
    </Section>
  );
}
