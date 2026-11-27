// Properties inspector: composition settings, or every editable property of the selection.
import { useState } from 'react';
import type { Draft } from 'immer';
import { Box, Eye, EyeOff, Link2, Lock, Unlock, Headphones } from 'lucide-react';
import type { BlendMode, ColorSpace, Composition, Layer, MatteMode, TransitionKind, Vec3 } from '../../types/project';
import { BLEND_MODES, LABEL_COLORS, TRANSITIONS } from '../../types/project';
import { draftComp, useComp, useEditor, useSelectedLayers } from '../../store/editor';
import { formatTime } from '../../lib/anim';
import { setParent } from '../../lib/ops';
import { ColorField, NumberField, Section, Select, Toggle } from '../ui/primitives';
import { NumRow, PlainRow, PropRow, VecRow } from './PropRow';
import { EffectsList } from './Effects';
import { MasksSection } from './Masks';
import { CameraSection, GeneratorSection, LightSection, MaterialSection, MeshSection, ParticlesSection, ShapeSection, SolidSection, TextSection } from './KindSections';
import { editLayers } from './util';
import './inspector.css';

const S = () => useEditor.getState();
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).replace(/([A-Z])/g, ' $1');

export function Inspector() {
  const comp = useComp();
  const layers = useSelectedLayers();
  if (!comp) return <div className="panel"><div className="empty">No composition open</div></div>;
  const l = layers[0];
  return (
    <div className="panel inspector">
      <div className="panel-head insp-head">
        {layers.length === 0 && <><Box size={13} className="muted" /><b className="grow">{comp.name}</b><span className="muted">Composition</span></>}
        {layers.length === 1 && <>
          <span className="insp-dot" style={{ background: l.label ? LABEL_COLORS[l.label] ?? l.label : 'var(--text-3)' }} />
          <b className="grow insp-title">{l.name}</b><span className="pill">{l.kind.type}</span>
        </>}
        {layers.length > 1 && <><b className="grow">{layers.length} layers selected</b><span className="muted">shared transform</span></>}
      </div>
      <div className="panel-body">
        {layers.length === 0 && <CompSettings comp={comp} />}
        {layers.length === 1 && <LayerInspector key={l.id} layer={l} comp={comp} />}
        {layers.length > 1 && <TransformSection layers={layers} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- composition

const SIZES: [string, number, number][] = [
  ['1920 × 1080 (HD)', 1920, 1080], ['3840 × 2160 (4K UHD)', 3840, 2160], ['1280 × 720', 1280, 720], ['1080 × 1920 (Vertical)', 1080, 1920],
  ['1080 × 1350 (4:5)', 1080, 1350], ['1080 × 1080 (Square)', 1080, 1080], ['2160 × 3840 (Vertical 4K)', 2160, 3840],
];
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

function CompSettings({ comp }: { comp: Composition }) {
  const time = useEditor((s) => s.time);
  const set = (label: string, fn: (c: Draft<Composition>) => void, co?: string) => S().edit(label, (d) => { const c = draftComp(d, comp.id); if (c) fn(c); }, co);
  const sizeKey = SIZES.find((s) => s[1] === comp.width && s[2] === comp.height)?.[0] ?? 'custom';
  return (
    <>
      <Section title="Composition" id="insp-comp">
        <PlainRow label="Name"><input className="input grow" value={comp.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set('Rename Composition', (c) => { c.name = e.target.value; }, 'comp-name')} /></PlainRow>
        <PlainRow label="Preset">
          <Select value={sizeKey} width="100%" onChange={(v) => { const s = SIZES.find((x) => x[0] === v); if (s) set('Composition Size', (c) => { c.width = s[1]; c.height = s[2]; }); }}
            options={[...SIZES.map((s) => ({ value: s[0], label: s[0] })), { value: 'custom', label: 'Custom' }]} />
        </PlainRow>
        <PlainRow label="Size">
          <NumberField value={comp.width} min={16} max={16384} precision={0} unit=" w" onChange={(v) => set('Composition Size', (c) => { c.width = Math.max(16, Math.round(v / 2) * 2); }, 'comp-w')} />
          <NumberField value={comp.height} min={16} max={16384} precision={0} unit=" h" onChange={(v) => set('Composition Size', (c) => { c.height = Math.max(16, Math.round(v / 2) * 2); }, 'comp-h')} />
          <span className="muted mono">{(comp.width / comp.height).toFixed(3)}:1</span>
        </PlainRow>
        <PlainRow label="Frame Rate">
          <Select value={RATES.includes(comp.fps) ? comp.fps : -1} onChange={(v) => v > 0 && set('Frame Rate', (c) => { c.fps = v; })}
            options={[...RATES.map((r) => ({ value: r, label: `${r} fps` })), { value: -1, label: 'Custom' }]} />
          <NumberField value={comp.fps} min={1} max={240} step={0.01} precision={3} onChange={(v) => set('Frame Rate', (c) => { c.fps = v; }, 'comp-fps')} />
        </PlainRow>
        <PlainRow label="Duration">
          <NumberField value={comp.duration} min={1 / comp.fps} step={0.1} precision={2} unit="s" onChange={(v) => set('Duration', (c) => { c.duration = v; }, 'comp-dur')} />
          <span className="muted mono">{formatTime(comp.duration, comp.fps)}</span>
        </PlainRow>
        <PlainRow label="Background">
          <ColorField value={comp.background} onChange={(v) => set('Background', (c) => { c.background = v; }, 'comp-bg')} alpha={false} />
          <label className="row label"><Toggle on={comp.transparent} onChange={(v) => set('Transparent Background', (c) => { c.transparent = v; })} /> Transparent</label>
        </PlainRow>
        <PlainRow label="Colour Space">
          <Select value={comp.colorSpace} onChange={(v) => set('Colour Space', (c) => { c.colorSpace = v; })}
            options={(['rec709', 'srgb', 'rec2020', 'displayP3', 'linear'] as ColorSpace[]).map((x) => ({ value: x, label: { rec709: 'Rec. 709', srgb: 'sRGB', rec2020: 'Rec. 2020', displayP3: 'Display P3', linear: 'Linear' }[x] }))} />
        </PlainRow>
        <PlainRow label="Work Area">
          <NumberField value={comp.workArea?.[0] ?? 0} min={0} max={comp.duration} step={0.04} precision={2} unit="s" onChange={(v) => set('Work Area', (c) => { c.workArea = [v, c.workArea?.[1] ?? c.duration]; }, 'comp-wa')} />
          <NumberField value={comp.workArea?.[1] ?? comp.duration} min={0} max={comp.duration} step={0.04} precision={2} unit="s" onChange={(v) => set('Work Area', (c) => { c.workArea = [c.workArea?.[0] ?? 0, v]; }, 'comp-wa')} />
          <button className="btn sm ghost" onClick={() => set('Work Area', (c) => { c.workArea = null; })}>Reset</button>
        </PlainRow>
      </Section>
      <Section title="Motion Blur" id="insp-mb">
        <PlainRow label="Shutter Angle"><NumberField value={comp.motionBlur.shutterAngle} min={0} max={720} unit="°" precision={0} onChange={(v) => set('Shutter Angle', (c) => { c.motionBlur.shutterAngle = v; }, 'mb-a')} /></PlainRow>
        <PlainRow label="Shutter Phase"><NumberField value={comp.motionBlur.shutterPhase} min={-360} max={360} unit="°" precision={0} onChange={(v) => set('Shutter Phase', (c) => { c.motionBlur.shutterPhase = v; }, 'mb-p')} /></PlainRow>
        <PlainRow label="Samples"><NumberField value={comp.motionBlur.samples} min={2} max={64} precision={0} onChange={(v) => set('Motion Blur Samples', (c) => { c.motionBlur.samples = Math.round(v); }, 'mb-s')} /></PlainRow>
        <div className="muted hint">Enable motion blur per layer in the Layer section.</div>
      </Section>
      <Section title="Audio" id="insp-compaudio">
        <PlainRow label="Sample Rate"><Select value={comp.sampleRate} onChange={(v) => set('Sample Rate', (c) => { c.sampleRate = v; })} options={[44100, 48000, 96000].map((r) => ({ value: r, label: `${r / 1000} kHz` }))} /></PlainRow>
        <PlainRow label="Channels"><Select value={comp.channels} onChange={(v) => set('Channels', (c) => { c.channels = v; })} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Stereo' }]} /></PlainRow>
      </Section>
      <div className="muted hint" style={{ padding: 10 }}>Playhead {formatTime(time, comp.fps)} · {comp.layers.length} layers. Select a clip in the timeline to edit its properties or colour grade it.</div>
    </>
  );
}

// ---------------------------------------------------------------- layer

function LayerInspector({ layer, comp }: { layer: Layer; comp: Composition }) {
  const k = layer.kind.type;
  const visual = !['audio', 'camera', 'light', 'null'].includes(k);
  const project = useEditor((s) => s.project);
  const hasAudio = (k === 'media' || k === 'audio') && !!project?.assets.find((a) => a.id === (layer.kind as { asset: string }).asset)?.info.hasAudio;
  // In the Colour Grading workspace the effect stack (where the Color Grade wheels live) comes first.
  const grading = useEditor((s) => s.workspace === 'Colour Grading');
  const effects = visual && <Section title={`Effects${layer.effects.length ? ` (${layer.effects.length})` : ''}`} id="insp-fx"><EffectsList layer={layer} /></Section>;
  return (
    <>
      {grading && effects}
      <LayerSection layer={layer} comp={comp} />
      <TimingSection layer={layer} />
      {k !== 'audio' && <TransformSection layers={[layer]} />}
      {k === 'text' && <TextSection layer={layer} />}
      {k === 'shape' && <ShapeSection layer={layer} />}
      {k === 'solid' && <SolidSection layer={layer} />}
      {k === 'camera' && <CameraSection layer={layer} />}
      {k === 'light' && <LightSection layer={layer} />}
      {k === 'mesh' && <MeshSection layer={layer} />}
      {(k === 'mesh' || (layer.is3d && (k === 'text' || k === 'shape'))) && <MaterialSection layer={layer} />}
      {k === 'particles' && <ParticlesSection layer={layer} />}
      {k === 'generator' && <GeneratorSection layer={layer} />}
      {!grading && effects}
      {visual && k !== 'mesh' && <Section title={`Masks${layer.masks.length ? ` (${layer.masks.length})` : ''}`} id="insp-masks" defaultOpen={layer.masks.length > 0}><MasksSection layer={layer} /></Section>}
      {(hasAudio || k === 'comp') && <AudioSection layer={layer} />}
      {visual && <TransitionsSection layer={layer} />}
    </>
  );
}

function LayerSection({ layer, comp }: { layer: Layer; comp: Composition }) {
  const ed = (label: string, fn: (l: Draft<Layer>) => void, co?: string) => editLayers([layer.id], label, fn, co);
  const others = comp.layers.filter((l) => l.id !== layer.id);
  const tm = layer.trackMatte;
  return (
    <Section title="Layer" id="insp-layer">
      <PlainRow label="Name"><input className="input grow" value={layer.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => ed('Rename Layer', (l) => { l.name = e.target.value; }, `name:${layer.id}`)} /></PlainRow>
      <PlainRow label="Switches">
        <button className={`icon-btn sm ${layer.visible ? '' : 'active'}`} title="Visible" onClick={() => ed('Visibility', (l) => { l.visible = !l.visible; })}>{layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
        <button className={`icon-btn sm ${layer.locked ? 'active' : ''}`} title="Lock" onClick={() => ed('Lock', (l) => { l.locked = !l.locked; })}>{layer.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
        <button className={`icon-btn sm ${layer.solo ? 'active' : ''}`} title="Solo" onClick={() => ed('Solo', (l) => { l.solo = !l.solo; })}><Headphones size={12} /></button>
        <label className="row label"><input type="checkbox" checked={layer.shy} onChange={(e) => ed('Shy', (l) => { l.shy = e.target.checked; })} />Shy</label>
      </PlainRow>
      {layer.kind.type !== 'audio' && <>
        <PlainRow label="Parent">
          <Select value={layer.parent ?? ''} width="100%" onChange={(v) => void setParent([layer.id], v || null)}
            options={[{ value: '', label: 'None' }, ...others.map((o) => ({ value: o.id, label: `${o.name} (${o.kind.type})` }))]} />
        </PlainRow>
        {!['camera', 'light', 'null'].includes(layer.kind.type) && <>
          <PlainRow label="Blend Mode">
            <Select value={layer.blend} width="100%" onChange={(v) => ed('Blend Mode', (l) => { l.blend = v; })} options={BLEND_MODES.map((b: BlendMode) => ({ value: b, label: cap(b) }))} />
          </PlainRow>
          <PlainRow label="Track Matte">
            <Select value={tm?.layer ?? ''} onChange={(v) => ed('Track Matte', (l) => { l.trackMatte = v ? { layer: v, mode: l.trackMatte?.mode ?? 'alpha' } : null; })}
              options={[{ value: '', label: 'None' }, ...others.map((o) => ({ value: o.id, label: o.name }))]} />
            {tm && <Select value={tm.mode} onChange={(v) => ed('Matte Mode', (l) => { if (l.trackMatte) l.trackMatte.mode = v; })}
              options={(['alpha', 'alphaInverted', 'luma', 'lumaInverted'] as MatteMode[]).map((m) => ({ value: m, label: cap(m) }))} />}
          </PlainRow>
          <PlainRow label="Motion Blur"><Toggle on={layer.motionBlur} onChange={(v) => ed('Motion Blur', (l) => { l.motionBlur = v; })} /></PlainRow>
        </>}
        <PlainRow label="3D Layer" title="Place this layer in 3D space (seen through the active camera)">
          <Toggle on={layer.is3d} onChange={(v) => ed(v ? 'Make 3D' : 'Make 2D', (l) => { l.is3d = v; })} />
        </PlainRow>
      </>}
      <PlainRow label="Label">
        <span className="row" style={{ gap: 3 }}>
          <span className={`label-swatch ${!layer.label ? 'on' : ''}`} style={{ background: 'var(--bg-4)' }} onClick={() => ed('Label', (l) => { l.label = null; })} />
          {Object.entries(LABEL_COLORS).map(([n, c]) => <span key={n} title={n} className={`label-swatch ${layer.label === n ? 'on' : ''}`} style={{ background: c }} onClick={() => ed('Label', (l) => { l.label = n; })} />)}
        </span>
      </PlainRow>
    </Section>
  );
}

function TimingSection({ layer }: { layer: Layer }) {
  const comp = useComp()!;
  const time = useEditor((s) => s.time);
  const ed = (label: string, fn: (l: Draft<Layer>) => void, co?: string) => editLayers([layer.id], label, fn, co);
  const hasSource = ['media', 'audio', 'comp'].includes(layer.kind.type);
  const srcNow = layer.sourceIn + (time - layer.start) * layer.speed;
  return (
    <Section title="Timing" id="insp-timing" defaultOpen={false}>
      <PlainRow label="Start"><NumberField value={layer.start} step={1 / comp.fps} precision={3} unit="s" onChange={(v) => ed('Layer Start', (l) => { l.start = Math.round(v * comp.fps) / comp.fps; }, `start:${layer.id}`)} /><span className="muted mono">{formatTime(layer.start, comp.fps)}</span></PlainRow>
      <PlainRow label="Duration"><NumberField value={layer.duration} min={1 / comp.fps} step={1 / comp.fps} precision={3} unit="s" onChange={(v) => ed('Layer Duration', (l) => { l.duration = Math.max(1 / comp.fps, v); }, `dur:${layer.id}`)} /><span className="muted mono">{formatTime(layer.duration, comp.fps)}</span></PlainRow>
      {hasSource && <>
        <PlainRow label="In Point (source)"><NumberField value={layer.sourceIn} min={0} step={1 / comp.fps} precision={3} unit="s" onChange={(v) => ed('Source In', (l) => { l.sourceIn = Math.max(0, v); }, `sin:${layer.id}`)} /></PlainRow>
        <PlainRow label="Speed" title="Negative values play in reverse">
          <NumberField value={layer.speed * 100 * (layer.reverse ? -1 : 1)} step={1} precision={1} unit="%" onChange={(v) => ed('Speed', (l) => {
            const s = Math.max(1, Math.abs(v)) / 100;
            const len = l.duration * l.speed;
            l.speed = s; l.reverse = v < 0;
            l.duration = Math.max(1 / comp.fps, len / s);
          }, `spd:${layer.id}`)} />
          <label className="row label"><input type="checkbox" checked={layer.reverse} onChange={(e) => ed('Reverse', (l) => { l.reverse = e.target.checked; })} />Reverse</label>
        </PlainRow>
        <PlainRow label="Freeze Frame">
          <Toggle on={layer.freezeAt != null} onChange={(v) => ed('Freeze Frame', (l) => { l.freezeAt = v ? Math.max(0, srcNow) : null; })} />
          {layer.freezeAt != null && <NumberField value={layer.freezeAt} min={0} step={1 / comp.fps} precision={3} unit="s" onChange={(v) => ed('Freeze Frame', (l) => { l.freezeAt = Math.max(0, v); }, `frz:${layer.id}`)} />}
        </PlainRow>
        <PlainRow label="Time Remap" title="Keyframe source time against layer time for variable speed">
          <Toggle on={!!layer.timeRemap} onChange={(v) => ed('Time Remap', (l) => {
            l.timeRemap = v ? { value: l.sourceIn, keys: [{ t: 0, v: l.sourceIn, interp: 'linear' }, { t: l.duration, v: l.sourceIn + l.duration * l.speed, interp: 'linear' }] } as never : null;
          })} />
        </PlainRow>
        {layer.timeRemap && <NumRow layers={[layer]} path="timeRemap" label="Source Time" min={0} step={1 / comp.fps} precision={3} unit="s" />}
      </>}
    </Section>
  );
}

function TransformSection({ layers }: { layers: Layer[] }) {
  const l0 = layers[0];
  const [link, setLink] = useState(true);
  const is3d = layers.every((l) => l.is3d);
  const dims = is3d ? 3 : 2;
  return (
    <Section title="Transform" id="insp-transform" actions={
      <button className="btn sm ghost" title="Reset transform" onClick={() => editLayers(layers.map((l) => l.id), 'Reset Transform', (l) => {
        l.transform.scale = { value: [100, 100, 100], keys: [] } as never;
        l.transform.rotation = { value: [0, 0, 0], keys: [] } as never;
        l.transform.opacity = { value: 100, keys: [] } as never;
      })}>Reset</button>}>
      <VecRow layers={layers} path="transform.anchor" label="Anchor Point" dims={dims} />
      <VecRow layers={layers} path="transform.position" label="Position" dims={dims} />
      <PropRow<Vec3> layers={layers} path="transform.scale" label="Scale">
        {(v, set) => <>
          <button className={`icon-btn sm ${link ? 'active' : ''}`} title="Constrain proportions" onClick={() => setLink(!link)}><Link2 size={11} /></button>
          {Array.from({ length: dims }, (_, i) => (
            <NumberField key={i} value={v[i]} step={0.5} precision={1} unit="%"
              onChange={(x) => {
                if (link) { const r = v[i] !== 0 ? x / v[i] : 1; set(v.map((c, j) => (j < dims ? (j === i ? x : c * r) : c)) as Vec3); }
                else { const n = [...v] as Vec3; n[i] = x; set(n); }
              }} />
          ))}
        </>}
      </PropRow>
      {is3d ? <VecRow layers={layers} path="transform.rotation" label="Rotation X/Y/Z" dims={3} unit="°" /> : (
        <PropRow<Vec3> layers={layers} path="transform.rotation" label="Rotation">
          {(v, set) => <>
            <NumberField value={v[2]} step={0.5} precision={1} unit="°" onChange={(x) => set([v[0], v[1], x])} />
            <span className="muted mono">{Math.trunc(v[2] / 360)}x</span>
          </>}
        </PropRow>
      )}
      <NumRow layers={layers} path="transform.opacity" label="Opacity" min={0} max={100} unit="%" slider />
      {l0 && layers.length === 1 && l0.parent && <div className="muted hint">Parented: transform values are relative to the parent layer.</div>}
    </Section>
  );
}

function AudioSection({ layer }: { layer: Layer }) {
  const ed = (label: string, fn: (l: Draft<Layer>) => void, co?: string) => editLayers([layer.id], label, fn, co);
  const L = [layer];
  return (
    <Section title="Audio" id="insp-audio">
      <PlainRow label="Mute"><Toggle on={layer.muted} onChange={(v) => ed('Mute', (l) => { l.muted = v; })} /></PlainRow>
      <NumRow layers={L} path="audio.volume" label="Volume" min={-60} max={24} step={0.1} unit=" dB" slider />
      <NumRow layers={L} path="audio.pan" label="Pan" min={-1} max={1} step={0.01} precision={2} slider noKeys />
      <PlainRow label="Fade In / Out">
        <NumberField value={layer.audio.fadeIn} min={0} max={layer.duration} step={0.01} precision={2} unit="s" onChange={(v) => ed('Fade In', (l) => { l.audio.fadeIn = v; }, `fi:${layer.id}`)} />
        <NumberField value={layer.audio.fadeOut} min={0} max={layer.duration} step={0.01} precision={2} unit="s" onChange={(v) => ed('Fade Out', (l) => { l.audio.fadeOut = v; }, `fo:${layer.id}`)} />
      </PlainRow>
      <div className="insp-sub-title">Audio Effects</div>
      <EffectsList layer={layer} audio />
    </Section>
  );
}

function TransitionsSection({ layer }: { layer: Layer }) {
  const defDur = useEditor((s) => s.settings?.defaultTransition ?? 0.5);
  const ed = (label: string, fn: (l: Draft<Layer>) => void, co?: string) => editLayers([layer.id], label, fn, co);
  const row = (side: 'transitionIn' | 'transitionOut', label: string) => {
    const tr = layer[side];
    return (
      <PlainRow label={label}>
        <Select value={tr?.kind ?? ''} onChange={(v) => ed(label, (l) => { l[side] = v ? { kind: v as TransitionKind, duration: l[side]?.duration ?? Math.min(defDur, l.duration / 2), ease: l[side]?.ease ?? true } : null; })}
          options={[{ value: '', label: 'None' }, ...TRANSITIONS.map((t) => ({ value: t, label: cap(t) }))]} />
        {tr && <>
          <NumberField value={tr.duration} min={0.04} max={layer.duration} step={0.01} precision={2} unit="s" onChange={(v) => ed(`${label} Duration`, (l) => { if (l[side]) l[side]!.duration = v; }, `${side}:${layer.id}`)} />
          <label className="row label" title="Ease"><input type="checkbox" checked={tr.ease} onChange={(e) => ed(`${label} Ease`, (l) => { if (l[side]) l[side]!.ease = e.target.checked; })} />Ease</label>
        </>}
      </PlainRow>
    );
  };
  return (
    <Section title="Transitions" id="insp-transitions" defaultOpen={!!(layer.transitionIn || layer.transitionOut)}>
      {row('transitionIn', 'In')}
      {row('transitionOut', 'Out')}
    </Section>
  );
}
