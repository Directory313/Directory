import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Keyboard } from 'lucide-react';
import { useEditor, activeComp, draftComp } from '../../store/editor';
import { api, type CacheStats, type Settings } from '../../lib/api';
import { allActions, eventToShortcut, runAction, shortcutFor } from '../../lib/actions';
import { addAssetLayer } from '../../lib/ops';
import { ColorField, Field, Modal, Select, Slider, Toggle } from '../ui/primitives';
import { ExportDialog } from './ExportDialog';
import { RenderQueuePanel } from '../panels/RenderQueue';
import { FPS_PRESETS, RES_PRESETS } from '../shell/HomeScreen';
import { WORKSPACE_NAMES } from '../shell/workspaces';

export function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  const close = () => useEditor.setState({ dialog: null });
  switch (dialog) {
    case 'export': return activeComp() ? <ExportDialog onClose={close} /> : null;
    case 'settings': return <SettingsDialog onClose={close} />;
    case 'compSettings': return <CompSettingsDialog onClose={close} />;
    case 'palette': return <CommandPalette onClose={close} />;
    case 'shortcuts': return <ShortcutsDialog onClose={close} />;
    case 'renderQueue': return <Modal title="Render Queue" onClose={close} width={820}><div style={{ height: 440 }}><RenderQueuePanel /></div></Modal>;
    default: return null;
  }
}

// ---------------------------------------------------------------- composition settings
function CompSettingsDialog({ onClose }: { onClose: () => void }) {
  const comp = activeComp();
  const [c, setC] = useState(() => comp && { name: comp.name, width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration, background: comp.background, transparent: comp.transparent, colorSpace: comp.colorSpace, sampleRate: comp.sampleRate, channels: comp.channels, pixelAspect: comp.pixelAspect, ...comp.motionBlur });
  if (!comp || !c) return null;
  const apply = () => {
    useEditor.getState().edit('Composition Settings', (d) => {
      const x = draftComp(d);
      if (!x) return;
      Object.assign(x, { name: c.name, width: Math.max(16, c.width), height: Math.max(16, c.height), fps: c.fps, duration: Math.max(1 / c.fps, c.duration), background: c.background, transparent: c.transparent, colorSpace: c.colorSpace, sampleRate: c.sampleRate, channels: c.channels, pixelAspect: c.pixelAspect });
      x.motionBlur = { shutterAngle: c.shutterAngle, shutterPhase: c.shutterPhase, samples: c.samples };
    });
    onClose();
  };
  return (
    <Modal title="Composition Settings" onClose={onClose} width={620} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={apply}>Apply</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Field label="Name"><input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{RES_PRESETS.map((p) => <button key={p.label} className={`btn sm ${c.width === p.w && c.height === p.h ? 'primary' : ''}`} onClick={() => setC({ ...c, width: p.w, height: p.h })}>{p.label}</button>)}</div>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Width"><input className="input mono" type="number" value={c.width} onChange={(e) => setC({ ...c, width: Number(e.target.value) })} /></Field>
          <Field label="Height"><input className="input mono" type="number" value={c.height} onChange={(e) => setC({ ...c, height: Number(e.target.value) })} /></Field>
          <Field label="Frame rate"><Select value={c.fps} onChange={(v) => setC({ ...c, fps: v })} options={[...new Set([...FPS_PRESETS, c.fps])].map((f) => ({ value: f, label: `${f} fps` }))} /></Field>
          <Field label="Duration (s)"><input className="input mono" type="number" step={0.1} value={c.duration} onChange={(e) => setC({ ...c, duration: Number(e.target.value) })} /></Field>
        </div>
        <div className="row" style={{ gap: 14 }}>
          <Field label="Background"><ColorField value={c.background} onChange={(v) => setC({ ...c, background: v })} alpha={false} /></Field>
          <label className="row" style={{ marginTop: 16 }}><Toggle on={c.transparent} onChange={(v) => setC({ ...c, transparent: v })} /> Transparent background (exports keep alpha)</label>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Colour space"><Select value={c.colorSpace} onChange={(v) => setC({ ...c, colorSpace: v })} options={[{ value: 'rec709', label: 'Rec. 709' }, { value: 'srgb', label: 'sRGB' }, { value: 'rec2020', label: 'Rec. 2020' }, { value: 'displayP3', label: 'Display P3' }, { value: 'linear', label: 'Linear (tag)' }]} /></Field>
          <Field label="Audio"><Select value={c.sampleRate} onChange={(v) => setC({ ...c, sampleRate: v })} options={[44100, 48000, 96000].map((r) => ({ value: r, label: `${r / 1000} kHz` }))} /></Field>
          <Field label="Channels"><Select value={c.channels} onChange={(v) => setC({ ...c, channels: v })} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Stereo' }]} /></Field>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Motion blur shutter angle"><input className="input mono" type="number" value={c.shutterAngle} onChange={(e) => setC({ ...c, shutterAngle: Number(e.target.value) })} /></Field>
          <Field label="Shutter phase"><input className="input mono" type="number" value={c.shutterPhase} onChange={(e) => setC({ ...c, shutterPhase: Number(e.target.value) })} /></Field>
          <Field label="Samples"><input className="input mono" type="number" min={2} max={64} value={c.samples} onChange={(e) => setC({ ...c, samples: Number(e.target.value) })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- command palette
function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hot, setHot] = useState(0);
  const defs = useEditor((s) => s.effectDefs);
  const project = useEditor((s) => s.project);
  const comp = activeComp();
  const items = useMemo(() => {
    const out: { label: string; group: string; hint?: string; run: () => void }[] = [];
    for (const a of allActions()) if (!a.enabled || a.enabled()) out.push({ label: a.label, group: a.group, hint: shortcutFor(a.id), run: () => runAction(a.id) });
    for (const d of defs) out.push({ label: `Apply ${d.name}`, group: d.audio ? 'Audio Effect' : 'Effect', run: async () => {
      const s = useEditor.getState();
      if (!s.selectedLayers.length) { s.toast('info', 'Select a layer first'); return; }
      const fx = await Promise.all(s.selectedLayers.map(() => api.createEffect(d.kind)));
      s.edit('Add Effect', (dd) => s.selectedLayers.forEach((id, i) => { const l = draftComp(dd)?.layers.find((x) => x.id === id); if (l) (d.audio ? l.audio.effects : l.effects).push(fx[i] as never); }));
    } });
    for (const l of comp?.layers ?? []) out.push({ label: `Select layer “${l.name}”`, group: 'Layer', run: () => useEditor.getState().select([l.id]) });
    for (const a of project?.assets ?? []) out.push({ label: `Add “${a.name}” to timeline`, group: 'Media', run: () => addAssetLayer(a) });
    for (const c of project?.compositions ?? []) out.push({ label: `Open composition “${c.name}”`, group: 'Composition', run: () => useEditor.setState({ compId: c.id, selectedLayers: [], time: 0 }) });
    return out;
  }, [defs, project, comp]);
  const filtered = useMemo(() => {
    if (!q) return items.slice(0, 60);
    const t = q.toLowerCase().split(/\s+/);
    return items.filter((i) => t.every((w) => `${i.label} ${i.group}`.toLowerCase().includes(w))).slice(0, 60);
  }, [q, items]);
  useEffect(() => setHot(0), [q]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input className="palette-input" autoFocus placeholder="Type a command, effect, layer or media name…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { setHot((h) => Math.min(filtered.length - 1, h + 1)); e.preventDefault(); }
            if (e.key === 'ArrowUp') { setHot((h) => Math.max(0, h - 1)); e.preventDefault(); }
            if (e.key === 'Enter' && filtered[hot]) { onClose(); filtered[hot].run(); }
          }} />
        <div className="palette-list">
          {filtered.map((i, k) => (
            <div key={`${i.group}-${i.label}-${k}`} className={`menu-item ${k === hot ? 'hot' : ''}`} onPointerEnter={() => setHot(k)} onClick={() => { onClose(); i.run(); }}>
              <span className="pill">{i.group}</span><span className="grow">{i.label}</span>{i.hint && <span className="shortcut">{i.hint}</span>}
            </div>
          ))}
          {!filtered.length && <div className="empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shortcuts reference + editor
function ShortcutEditor({ filter }: { filter: string }) {
  const settings = useEditor((s) => s.settings);
  const [capture, setCapture] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by: Record<string, ReturnType<typeof allActions>> = {};
    for (const a of allActions()) if (!filter || `${a.label} ${a.group}`.toLowerCase().includes(filter.toLowerCase())) (by[a.group] ??= []).push(a);
    return by;
  }, [filter]);
  const setShortcut = (id: string, combo: string | null) => {
    const s = useEditor.getState().settings;
    if (!s) return;
    const sc = { ...s.shortcuts };
    if (combo === null) delete sc[id]; else sc[id] = combo;
    const next = { ...s, shortcuts: sc };
    useEditor.setState({ settings: next });
    api.setSettings(next);
  };
  useEffect(() => {
    if (!capture) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapture(null); return; }
      const combo = eventToShortcut(e);
      if (['Ctrl', 'Alt', 'Shift', 'Ctrl+Shift', 'Ctrl+Alt'].includes(combo)) return;
      setShortcut(capture, combo);
      setCapture(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [capture]);
  const used = new Map<string, number>();
  for (const a of allActions()) { const s = shortcutFor(a.id); if (s) used.set(s, (used.get(s) ?? 0) + 1); }
  return (
    <div className="shortcut-list">
      {Object.entries(groups).map(([g, list]) => (
        <div key={g}>
          <div className="lib-head">{g}</div>
          {list.map((a) => {
            const sc = shortcutFor(a.id);
            const custom = settings?.shortcuts?.[a.id] !== undefined;
            return (
              <div key={a.id} className="shortcut-row">
                <span className="grow">{a.label}</span>
                {sc && (used.get(sc) ?? 0) > 1 && <span className="pill warn" title="Also used by another command; the context decides which runs">shared</span>}
                <button className={`kbd ${capture === a.id ? 'capturing' : ''}`} onClick={() => setCapture(a.id)} title="Click, then press a new key combination">{capture === a.id ? 'Press keys…' : sc ?? '—'}</button>
                {custom && <button className="btn sm ghost" onClick={() => setShortcut(a.id, null)}>Reset</button>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState('');
  return (
    <Modal title={<span className="row"><Keyboard size={16} /> Keyboard Shortcuts</span>} onClose={onClose} width={720}>
      <input className="input" style={{ width: '100%', marginBottom: 10 }} placeholder="Filter…" value={f} onChange={(e) => setF(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <ShortcutEditor filter={f} />
    </Modal>
  );
}

// ---------------------------------------------------------------- settings
type Tab = 'General' | 'Performance' | 'Media' | 'Timeline' | 'Animation' | 'Export' | 'Interface' | 'Shortcuts';

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const initial = useEditor((s) => s.settings);
  const info = useEditor((s) => s.appInfo);
  const [s, setS] = useState<Settings | null>(initial);
  const [tab, setTab] = useState<Tab>('General');
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [blender, setBlender] = useState<string | null>(null);
  const [sf, setSf] = useState('');
  const dirty = useRef(false);
  useEffect(() => { api.cacheStats().then(setStats).catch(() => {}); api.findBlender().then(setBlender).catch(() => {}); }, []);
  if (!s) return null;
  const set = (p: Partial<Settings>) => { dirty.current = true; setS({ ...s, ...p }); };
  const saveAll = async () => {
    await api.setSettings(s);
    useEditor.setState({ settings: s, snapping: s.snapping });
    useEditor.getState().toast('success', 'Settings saved');
    onClose();
  };
  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <div className="settings-row"><div><div>{label}</div>{hint && <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{hint}</div>}</div><div>{control}</div></div>
  );
  const num = (v: number, on: (n: number) => void, step = 1, w = 90) => <input className="input mono" type="number" step={step} style={{ width: w }} value={v} onChange={(e) => on(Number(e.target.value))} />;
  const folder = (v: string, on: (p: string) => void) => (
    <div className="row"><input className="input" style={{ width: 260 }} value={v} placeholder="Default" onChange={(e) => on(e.target.value)} /><button className="btn sm" onClick={async () => { const d = await open({ directory: true }); if (d && !Array.isArray(d)) on(d); }}>Browse</button></div>
  );
  const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
  return (
    <Modal title="Settings" onClose={onClose} width={860} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={saveAll}>Save</button></>}>
      <div className="settings">
        <div className="settings-tabs">{(['General', 'Performance', 'Media', 'Timeline', 'Animation', 'Export', 'Interface', 'Shortcuts'] as Tab[]).map((t) => <button key={t} className={`lib-item ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}</div>
        <div className="settings-body">
          {tab === 'General' && <>
            {row('Startup', <Select value={s.startup} onChange={(v) => set({ startup: v })} options={[{ value: 'home', label: 'Home screen' }, { value: 'last', label: 'Open last project' }]} />)}
            {row('Default project folder', folder(s.defaultProjectDir, (p) => set({ defaultProjectDir: p })))}
            {row('Autosave', <Toggle on={s.autosaveEnabled} onChange={(v) => set({ autosaveEnabled: v })} />, 'Snapshots go to a recovery folder; your project file is only written when you save.')}
            {row('Autosave every (minutes)', num(s.autosaveMinutes, (v) => set({ autosaveMinutes: Math.max(0.25, v) }), 0.25))}
            {row('Backup copies kept', num(s.backupsKept, (v) => set({ backupsKept: Math.max(0, v) })), 'Previous versions are kept in a Backups folder next to the project.')}
            {row('Language', <Select value="en" onChange={() => {}} options={[{ value: 'en', label: 'English' }]} />, 'Additional languages are not yet available in this beta.')}
          </>}
          {tab === 'Performance' && <>
            {row('Graphics', <span className="muted">{info?.gpu} · {info?.gpuBackend}{info?.softwareRender ? ' (software)' : ''}</span>)}
            {row('Default preview resolution', <Select value={s.previewScale} onChange={(v) => set({ previewScale: v })} options={[{ value: 1, label: 'Full' }, { value: 0.5, label: 'Half' }, { value: 0.25, label: 'Quarter' }, { value: 0.125, label: 'Eighth' }]} />, `Recommended for this machine: ${info ? ({ 1: 'Full', 0.5: 'Half', 0.25: 'Quarter' } as Record<number, string>)[info.recommendedPreviewScale] : '…'}`)}
            {row('Adaptive preview resolution', <Toggle on={s.adaptivePreview} onChange={(v) => set({ adaptivePreview: v })} />, 'Lower the resolution automatically when playback cannot keep up.')}
            {row('Background pre-rendering', <Toggle on={s.backgroundRender} onChange={(v) => set({ backgroundRender: v })} />, 'Render idle timeline regions into the cache.')}
            {row('RAM cache', <div className="row"><Slider value={s.ramCacheMb} min={256} max={Math.max(1024, Math.round((info?.ramGb ?? 8) * 1024 * 0.6))} step={64} onChange={(v) => set({ ramCacheMb: v })} width={200} /><span className="mono">{s.ramCacheMb} MB</span></div>)}
            {row('Disk cache', <div className="row"><Slider value={s.diskCacheMb} min={0} max={65536} step={256} onChange={(v) => set({ diskCacheMb: v })} width={200} /><span className="mono">{s.diskCacheMb} MB</span></div>)}
            {row('Cache location', folder(s.cacheDir, (p) => set({ cacheDir: p })))}
            {row('Cache usage', <div className="row"><span className="mono muted">{stats ? `${stats.frames} frames · RAM ${mb(stats.ramBytes)} · disk ${mb(stats.diskBytes)} · hit ${stats.hits}/${stats.hits + stats.misses}` : '…'}</span><button className="btn sm" onClick={async () => { await runAction('app.clearCache'); setStats(await api.cacheStats()); }}>Clear</button></div>)}
            {row('CPU threads (0 = all)', num(s.cpuThreads, (v) => set({ cpuThreads: Math.max(0, v) })), 'Applies after restarting Directory.')}
            {row('Hardware decoding', <Toggle on={s.hardwareDecode} onChange={(v) => set({ hardwareDecode: v })} />, info?.ffmpeg?.hwDecoders.length ? `Available: ${info.ffmpeg.hwDecoders.join(', ')}` : '')}
            {row('Hardware encoding', <Toggle on={s.hardwareEncode} onChange={(v) => set({ hardwareEncode: v })} />, info?.ffmpeg?.hwEncoders.length ? `Available: ${info.ffmpeg.hwEncoders.join(', ')}` : 'No hardware encoder detected')}
          </>}
          {tab === 'Media' && <>
            {row('Use proxies for preview', <Toggle on={s.useProxies} onChange={(v) => set({ useProxies: v })} />, 'Exports always use original media.')}
            {row('Default proxy height', <Select value={s.proxyHeight} onChange={(v) => set({ proxyHeight: v })} options={[1080, 720, 540, 360, 270].map((h) => ({ value: h, label: `${h}p` }))} />)}
            {row('Default still duration (s)', num(s.defaultStillDuration, (v) => set({ defaultStillDuration: v }), 0.5))}
            {row('LUT folders', <div className="col">{s.lutFolders.map((f) => <div key={f} className="row"><span className="grow mono">{f}</span><button className="btn sm ghost" onClick={() => set({ lutFolders: s.lutFolders.filter((x) => x !== f) })}>Remove</button></div>)}<button className="btn sm" onClick={async () => { const d = await open({ directory: true }); if (d && !Array.isArray(d)) set({ lutFolders: [...s.lutFolders, d] }); }}>Add folder…</button></div>)}
            {row('Blender', <div className="col"><span className="muted">{blender ? `Found: ${blender}` : 'Not found — .blend import needs Blender installed'}</span><div className="row"><input className="input" style={{ width: 260 }} value={s.blenderPath} placeholder="Auto-detect" onChange={(e) => set({ blenderPath: e.target.value })} /><button className="btn sm" onClick={async () => { const p = await open({ filters: [{ name: 'Blender', extensions: ['exe'] }] }); if (p && !Array.isArray(p)) set({ blenderPath: p }); }}>Browse</button></div></div>)}
            {row('Media engine', <span className="muted mono" style={{ fontSize: 'var(--fs-xs)' }}>{info?.ffmpeg?.ffmpegVersion}<br />{info?.ffmpeg?.ffmpegPath}</span>)}
          </>}
          {tab === 'Timeline' && <>
            {row('Default frame rate', <Select value={s.defaultFps} onChange={(v) => set({ defaultFps: v })} options={FPS_PRESETS.map((f) => ({ value: f, label: `${f}` }))} />)}
            {row('Default resolution', <div className="row">{num(s.defaultWidth, (v) => set({ defaultWidth: v }))}×{num(s.defaultHeight, (v) => set({ defaultHeight: v }))}</div>)}
            {row('Snapping', <Toggle on={s.snapping} onChange={(v) => set({ snapping: v })} />)}
            {row('Time display', <Select value={s.timeDisplay} onChange={(v) => set({ timeDisplay: v })} options={[{ value: 'timecode', label: 'Timecode' }, { value: 'frames', label: 'Frames' }, { value: 'seconds', label: 'Seconds' }]} />)}
            {row('Default transition duration (s)', num(s.defaultTransition, (v) => set({ defaultTransition: v }), 0.1))}
          </>}
          {tab === 'Animation' && <>
            {row('Default keyframe interpolation', <Select value={s.defaultInterpolation} onChange={(v) => set({ defaultInterpolation: v })} options={[{ value: 'linear', label: 'Linear' }, { value: 'bezier', label: 'Bezier (ease)' }, { value: 'hold', label: 'Hold' }]} />)}
            {row('Motion blur samples (new comps)', num(s.motionBlurSamples, (v) => set({ motionBlurSamples: Math.max(2, Math.min(64, v)) })))}
          </>}
          {tab === 'Export' && <>
            {row('Default output folder', folder(s.exportFolder, (p) => set({ exportFolder: p })))}
            {row('Default preset', <input className="input" value={s.exportPreset} onChange={(e) => set({ exportPreset: e.target.value })} />)}
            {row('Prefer hardware encoding', <Toggle on={s.hardwareEncode} onChange={(v) => set({ hardwareEncode: v })} />)}
          </>}
          {tab === 'Interface' && <>
            {row('Interface scale', <div className="row"><Slider value={s.uiScale} min={0.8} max={1.5} step={0.05} onChange={(v) => set({ uiScale: v })} width={180} /><span className="mono">{Math.round(s.uiScale * 100)}%</span></div>)}
            {row('Accent intensity', <Slider value={s.accentIntensity} min={0.4} max={1} step={0.05} onChange={(v) => set({ accentIntensity: v })} width={180} />)}
            {row('Reduce motion', <Toggle on={s.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />)}
            {row('Workspace', <Select value={s.activeWorkspace} onChange={(v) => set({ activeWorkspace: v })} options={WORKSPACE_NAMES.map((n) => ({ value: n, label: n }))} />)}
            {row('Panel layouts', <button className="btn sm" onClick={() => { for (const n of WORKSPACE_NAMES) try { localStorage.removeItem(`veyra.layout.v2.${n}`); } catch { /* ignore */ } useEditor.getState().toast('success', 'Layouts reset — switch workspace to apply'); }}>Reset all layouts</button>)}
          </>}
          {tab === 'Shortcuts' && <><input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="Filter…" value={sf} onChange={(e) => setSf(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /><ShortcutEditor filter={sf} /></>}
        </div>
      </div>
    </Modal>
  );
}
