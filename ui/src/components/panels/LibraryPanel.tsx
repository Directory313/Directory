import { useEffect, useMemo, useState } from 'react';
import { Box, Circle, Hexagon, Lightbulb, Minus, MoveRight, Shapes, Sparkles, Square, Star, Triangle, Type, Video, Wand2, Waves } from 'lucide-react';
import { useEditor, draftComp } from '../../store/editor';
import { NONE } from '../../store/editor';
import { api } from '../../lib/api';
import { addLayer } from '../../lib/ops';
import { SearchBox } from '../ui/primitives';
import { ANIM_PRESETS, applyAnimPreset, applyCaptured, captureAnimation } from './animPresets';
import { TRANSITIONS, type Effect, type TransitionKind } from '../../types/project';
import { EASINGS, sampleEasing, type Easing } from '../../lib/anim';
import { applyEasingToSelection } from '../timeline/keyops';
import { activeComp } from '../../store/editor';

type Tab = 'effects' | 'transitions' | 'animation' | 'shapes' | 'text' | '3d' | 'generate' | 'templates' | 'audio';
const TABS: { id: Tab; label: string }[] = [
  { id: 'effects', label: 'Effects' }, { id: 'transitions', label: 'Transitions' }, { id: 'animation', label: 'Animate' }, { id: 'text', label: 'Text' },
  { id: 'shapes', label: 'Shapes' }, { id: '3d', label: '3D' }, { id: 'generate', label: 'Generate' }, { id: 'audio', label: 'Audio FX' }, { id: 'templates', label: 'Templates' },
];

async function applyEffect(kind: string, audio = false) {
  const s = useEditor.getState();
  if (!s.selectedLayers.length) {
    if (audio) { s.toast('info', 'Select an audio clip first'); return; }
    // No selection: create an adjustment layer carrying the effect (applies to everything below).
    const l = await addLayer({ kind: 'adjustment' }, 'Add Adjustment Layer');
    if (!l) return;
    const e = await api.createEffect(kind);
    s.edit('Add Effect', (d) => { draftComp(d)?.layers.find((x) => x.id === l.id)?.effects.push(e as never); });
    return;
  }
  const effects: Effect[] = await Promise.all(s.selectedLayers.map(() => api.createEffect(kind)));
  s.edit(audio ? 'Add Audio Effect' : 'Add Effect', (d) => {
    s.selectedLayers.forEach((id, i) => {
      const l = draftComp(d)?.layers.find((x) => x.id === id);
      if (!l) return;
      if (audio) l.audio.effects.push(effects[i] as never); else l.effects.push(effects[i] as never);
    });
  });
}

function applyTransition(kind: TransitionKind, where: 'in' | 'out' | 'both') {
  const s = useEditor.getState();
  if (!s.selectedLayers.length) { s.toast('info', 'Select one or more clips first'); return; }
  const dur = s.settings?.defaultTransition ?? 0.5;
  s.edit('Add Transition', (d) => {
    for (const l of draftComp(d)?.layers ?? []) {
      if (!s.selectedLayers.includes(l.id)) continue;
      if (where !== 'out') l.transitionIn = { kind, duration: Math.min(dur, l.duration / 2), ease: true };
      if (where !== 'in') l.transitionOut = { kind, duration: Math.min(dur, l.duration / 2), ease: true };
    }
  });
}

const TEXT_PRESETS: { name: string; text: string; size: number; weight: number; y: number; bg?: boolean; tracking?: number; preset?: string }[] = [
  { name: 'Title', text: 'Your Title', size: 1 / 8, weight: 700, y: 0.5, preset: 'staggerUp' },
  { name: 'Subtitle', text: 'Subtitle text', size: 1 / 18, weight: 500, y: 0.86, bg: true },
  { name: 'Lower Third', text: 'Name Surname', size: 1 / 16, weight: 600, y: 0.78, bg: true, preset: 'fadeIn' },
  { name: 'Kinetic', text: 'MOVE FAST', size: 1 / 7, weight: 800, y: 0.5, tracking: 40, preset: 'charPop' },
  { name: 'Typewriter', text: 'Typing on screen…', size: 1 / 14, weight: 400, y: 0.5, preset: 'typewriter' },
  { name: 'Caption', text: 'caption', size: 1 / 22, weight: 400, y: 0.92 },
];

const TEMPLATES = [
  { name: 'YouTube 16:9', w: 1920, h: 1080, fps: 30, dur: 30 },
  { name: 'YouTube Shorts / TikTok / Reels', w: 1080, h: 1920, fps: 30, dur: 30 },
  { name: 'Instagram Post 4:5', w: 1080, h: 1350, fps: 30, dur: 15 },
  { name: 'Instagram Square', w: 1080, h: 1080, fps: 30, dur: 15 },
  { name: '4K Cinema', w: 3840, h: 2160, fps: 24, dur: 60 },
  { name: 'Transparent Lower Third', w: 1920, h: 1080, fps: 30, dur: 6, transparent: true },
];

export function LibraryPanel() {
  const [tab, setTab] = useState<Tab>('effects');
  const [q, setQ] = useState('');
  const defs = useEditor((s) => s.effectDefs);
  const favs = useEditor((s) => s.settings?.favoriteEffects ?? NONE);
  const [saved, setSaved] = useState<{ kind: string; name: string; data: unknown }[]>([]);
  useEffect(() => {
    if (tab === 'animation') api.listPresets('animation').then(setSaved).catch(() => {});
    if (tab === 'effects') api.listPresets('effect').then(setSaved).catch(() => {});
  }, [tab]);

  const groups = useMemo(() => {
    const list = defs.filter((d) => (tab === 'audio' ? d.audio : !d.audio) && (!q || `${d.name} ${d.category} ${d.description}`.toLowerCase().includes(q.toLowerCase())));
    const by: Record<string, typeof list> = {};
    for (const d of list) {
      const cat = favs.includes(d.kind) ? '★ Favourites' : d.category;
      (by[cat] ??= []).push(d);
      if (favs.includes(d.kind) && cat !== d.category) (by[d.category] ??= []).push(d);
    }
    return by;
  }, [defs, q, tab, favs]);

  const toggleFav = (kind: string) => {
    const s = useEditor.getState();
    if (!s.settings) return;
    const f = s.settings.favoriteEffects.includes(kind) ? s.settings.favoriteEffects.filter((x) => x !== kind) : [...s.settings.favoriteEffects, kind];
    const next = { ...s.settings, favoriteEffects: f };
    useEditor.setState({ settings: next });
    api.setSettings(next);
  };

  const item = (key: string, label: string, onClick: () => void, icon?: React.ReactNode, hint?: string, extra?: React.ReactNode) => (
    <button key={key} className="lib-item" onClick={onClick} title={hint ?? label}>{icon}<span className="grow">{label}</span>{extra}</button>
  );

  return (
    <div className="panel library">
      <div className="lib-tabs">{TABS.map((t) => <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
      {(tab === 'effects' || tab === 'audio') && <div className="panel-head"><SearchBox value={q} onChange={setQ} placeholder={`Search ${tab === 'audio' ? 'audio effects' : `${defs.filter((d) => !d.audio).length} effects`}`} /></div>}
      <div className="panel-body lib-body">
        {(tab === 'effects' || tab === 'audio') && (
          <>
            {tab === 'effects' && saved.length > 0 && !q && (
              <div className="lib-group"><div className="lib-head">Saved effect presets</div>
                {saved.map((p) => item(`saved-${p.name}`, p.name, () => {
                  const s = useEditor.getState();
                  const fx = p.data as Effect[];
                  s.edit('Apply Effect Preset', (d) => { for (const l of draftComp(d)?.layers ?? []) if (s.selectedLayers.includes(l.id)) l.effects.push(...(JSON.parse(JSON.stringify(Array.isArray(fx) ? fx : [fx])) as Effect[]).map((e) => ({ ...e, id: Math.random().toString(36).slice(2, 14) })) as never[]); });
                }, <Wand2 size={13} />))}
              </div>
            )}
            {Object.entries(groups).sort(([a], [b]) => (a.startsWith('★') ? -1 : b.startsWith('★') ? 1 : a.localeCompare(b))).map(([cat, list]) => (
              <div key={cat} className="lib-group">
                <div className="lib-head">{cat}</div>
                {list.map((d) => item(`${cat}-${d.kind}`, d.name, () => applyEffect(d.kind, d.audio), <Sparkles size={13} />, `${d.description}\nClick to apply to the selected layers${d.audio ? '' : ' (or to a new adjustment layer when nothing is selected)'}`,
                  <span className={`fav ${favs.includes(d.kind) ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleFav(d.kind); }} title="Favourite"><Star size={11} fill={favs.includes(d.kind) ? 'currentColor' : 'none'} /></span>))}
              </div>
            ))}
          </>
        )}
        {tab === 'transitions' && (
          <div className="lib-group">
            <div className="lib-head">Apply to selected clips</div>
            {TRANSITIONS.map((k) => (
              <div key={k} className="lib-item row">
                <Video size={13} /><span className="grow">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
                <button className="btn sm ghost" onClick={() => applyTransition(k, 'in')}>In</button>
                <button className="btn sm ghost" onClick={() => applyTransition(k, 'out')}>Out</button>
                <button className="btn sm ghost" onClick={() => applyTransition(k, 'both')}>Both</button>
              </div>
            ))}
            <div className="muted" style={{ padding: 8 }}>For a cross-fade between two clips, overlap them on the timeline and add Cross Dissolve "Out" to the first and "In" to the second.</div>
          </div>
        )}
        {tab === 'animation' && (
          <>
            <div className="lib-group"><div className="lib-head">Easing — changes the curve between existing keyframes</div>
              <div className="muted" style={{ padding: '2px 10px 6px', fontSize: 11 }}>Select keyframes (or a layer with keyframes) and click a curve. No keyframes are added; fine-tune it in the Graph Editor.</div>
              {[...new Set(EASINGS.map((e) => e.group))].map((g) => (
                <div key={g} className="ease-grid">
                  {EASINGS.filter((e) => e.group === g).map((e) => (
                    <button key={e.id} className="ease-tile" title={`${e.name}: apply to the selected keyframes`} onClick={() => applyEasingToSelection(e)}>
                      <EaseCurve e={e} /><span>{e.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {['Basic', 'Physics', 'Procedural', 'Reveal', 'Text'].map((g) => (
              <div key={g} className="lib-group"><div className="lib-head">{g}</div>
                {ANIM_PRESETS.filter((p) => p.group === g).map((p) => item(p.id, p.name, () => applyAnimPreset(p), <Wand2 size={13} />, `Applies at the playhead to the selected ${p.textOnly ? 'text ' : ''}layers`))}
              </div>
            ))}
            <div className="lib-group"><div className="lib-head">Custom presets</div>
              {saved.map((p) => item(`c-${p.name}`, p.name, () => applyCaptured(p.data as never), <Wand2 size={13} />))}
              <button className="btn sm" style={{ margin: 8 }} onClick={async () => {
                const s = useEditor.getState();
                const l = activeComp()?.layers.find((x) => x.id === s.selectedLayers[0]);
                if (!l) { s.toast('info', 'Select an animated layer to save its animation'); return; }
                const name = window.prompt('Preset name', `${l.name} animation`);
                if (!name) return;
                await api.savePreset('animation', name, captureAnimation(l));
                setSaved(await api.listPresets('animation'));
                s.toast('success', 'Animation preset saved');
              }}>Save selected layer's animation…</button>
            </div>
          </>
        )}
        {tab === 'text' && (
          <div className="lib-group"><div className="lib-head">Text presets</div>
            {TEXT_PRESETS.map((p) => item(p.name, p.name, async () => {
              const c = activeComp();
              if (!c) return;
              const l = await addLayer({ kind: 'text', text: p.text }, 'Add Text');
              if (!l) return;
              const s = useEditor.getState();
              s.edit('Style Text', (d) => {
                const x = draftComp(d)?.layers.find((y) => y.id === l.id);
                if (!x || x.kind.type !== 'text') return;
                x.kind.fontSize.value = Math.round(c.height * p.size);
                x.kind.fontWeight = p.weight;
                x.kind.tracking.value = p.tracking ?? 0;
                if (p.bg) x.kind.background = { color: { value: [0.06, 0.06, 0.06, 0.72] }, padding: 18, radius: 10 };
                x.transform.position.value = [c.width / 2, c.height * p.y, 0];
              });
              if (p.preset) { const pr = ANIM_PRESETS.find((a) => a.id === p.preset); if (pr) applyAnimPreset(pr); }
            }, <Type size={13} />))}
          </div>
        )}
        {tab === 'shapes' && (
          <div className="lib-grid">
            {([['rect', Square], ['roundedRect', Square], ['ellipse', Circle], ['triangle', Triangle], ['polygon', Hexagon], ['star', Star], ['line', Minus], ['arrow', MoveRight]] as const).map(([v, I]) => (
              <button key={v} className="lib-tile" onClick={() => addLayer({ kind: 'shape', variant: v }, `Add ${v}`)}><I size={20} /><span>{v === 'roundedRect' ? 'Rounded' : v}</span></button>
            ))}
            <button className="lib-tile" onClick={() => addLayer({ kind: 'solid' }, 'Add Solid')}><Shapes size={20} /><span>Solid</span></button>
          </div>
        )}
        {tab === '3d' && (
          <>
            <div className="lib-grid">
              {['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'pyramid', 'circle', 'grid'].map((v) => (
                <button key={v} className="lib-tile" onClick={() => addLayer({ kind: 'mesh', variant: v }, `Add ${v}`)}><Box size={20} /><span>{v}</span></button>
              ))}
            </div>
            <div className="lib-group"><div className="lib-head">Camera & lights</div>
              {item('cam', 'Camera', () => addLayer({ kind: 'camera' }, 'Add Camera'), <Video size={13} />)}
              {(['point', 'spot', 'directional', 'area', 'ambient', 'environment'] as const).map((v) => item(v, `${v[0].toUpperCase()}${v.slice(1)} light`, () => addLayer({ kind: 'light', variant: v }, 'Add Light'), <Lightbulb size={13} />))}
            </div>
            <div className="muted" style={{ padding: 8 }}>Import .glb, .gltf, .obj or .blend files from the Media panel to add models. Any layer can be made 3D from the timeline or inspector.</div>
          </>
        )}
        {tab === 'generate' && (
          <div className="lib-group"><div className="lib-head">Generators</div>
            {item('particles', 'Particle System', () => addLayer({ kind: 'particles' }, 'Add Particles'), <Sparkles size={13} />)}
            {(['grid', 'noise', 'wave', 'gradient', 'checkerboard', 'animatedBackground'] as const).map((v) => item(v, v.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), () => addLayer({ kind: 'generator', variant: v }, 'Add Generator'), <Waves size={13} />))}
          </div>
        )}
        {tab === 'templates' && (
          <div className="lib-group"><div className="lib-head">New composition from template</div>
            {TEMPLATES.map((t) => item(t.name, t.name, async () => {
              const s = useEditor.getState();
              const c = await api.newComposition(t.w, t.h, t.fps, t.dur, t.name);
              if (t.transparent) c.transparent = true;
              s.edit('New Composition', (d) => { d.compositions.push(c as never); });
              useEditor.setState({ compId: c.id, compStack: [...s.compStack, c.id], time: 0, selectedLayers: [] });
            }, <Video size={13} />, `${t.w}×${t.h} · ${t.fps} fps · ${t.dur}s`))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Tiny curve preview for an easing (progress over time, with room for overshoot). */
function EaseCurve({ e }: { e: Easing }) {
  const pts = useMemo(() => sampleEasing(e, 40), [e]);
  const W = 44, H = 30, pad = 7;
  const y = (v: number) => H - pad - v * (H - pad * 2);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / 40) * W},${y(v).toFixed(2)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="ease-curve" aria-hidden>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="ease-axis" /><line x1="0" x2={W} y1={y(1)} y2={y(1)} className="ease-axis" />
      <path d={d} fill="none" />
    </svg>
  );
}
