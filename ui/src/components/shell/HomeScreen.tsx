import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FileVideo, FolderOpen, History, LifeBuoy, Plus, Upload } from 'lucide-react';
import { api, isTauri, type Recovery } from '../../lib/api';
import { useEditor } from '../../store/editor';
import { Logo } from './Logo';
import { openProjectPath } from './coreActions';
import { importPaths } from './dragdrop';
import { MEDIA_FILTERS } from './coreActions';
import { ColorField, Toggle } from '../ui/primitives';
import type { Color } from '../../types/project';

export const RES_PRESETS = [
  { label: '1080p', w: 1920, h: 1080, note: '16:9' },
  { label: '4K UHD', w: 3840, h: 2160, note: '16:9' },
  { label: '720p', w: 1280, h: 720, note: '16:9' },
  { label: 'Vertical', w: 1080, h: 1920, note: '9:16' },
  { label: 'Portrait', w: 1080, h: 1350, note: '4:5' },
  { label: 'Square', w: 1080, h: 1080, note: '1:1' },
  { label: 'Vertical 4K', w: 2160, h: 3840, note: '9:16' },
];
export const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

export function HomeScreen() {
  const settings = useEditor((s) => s.settings);
  const info = useEditor((s) => s.appInfo);
  const [recent, setRecent] = useState<{ path: string; name: string; exists: boolean }[]>([]);
  const [recovery, setRecovery] = useState<Recovery[]>([]);
  const [name, setName] = useState('Untitled Project');
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [fps, setFps] = useState(30);
  const [dur, setDur] = useState(30);
  const [bg, setBg] = useState<Color>([0.063, 0.063, 0.063, 1]);
  const [transparent, setTransparent] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    api.recentProjects().then(setRecent).catch(() => {});
    api.listRecovery().then(setRecovery).catch(() => {});
  }, []);
  useEffect(() => {
    if (settings) { setW(settings.defaultWidth); setH(settings.defaultHeight); setFps(settings.defaultFps); }
  }, [settings]);

  const create = async () => {
    const p = await api.newProject({ name, width: w, height: h, fps, duration: dur, background: bg, transparent });
    useEditor.getState().loadProject(p, null);
  };

  return (
    <div className="home" data-drop="home">
      <aside className="home-side">
        <Logo size={34} word />
        <div className="home-tag">BETA</div>
        <div className="col" style={{ gap: 4, marginTop: 28 }}>
          <button className="home-link" onClick={async () => { const p = await open({ filters: [{ name: 'VEYRA Project', extensions: ['veyra'] }] }); if (p && !Array.isArray(p)) openProjectPath(p); }}><FolderOpen size={15} /> Open project…</button>
          <button className="home-link" onClick={async () => { const p = await open({ multiple: true, filters: MEDIA_FILTERS }); if (p) importPaths(Array.isArray(p) ? p : [p], 'timeline'); }}><Upload size={15} /> Start from footage…</button>
        </div>
        <div className="home-sys">
          <div className="label">System</div>
          <div>{info ? (info.gpuError ? <span style={{ color: 'var(--error)' }}>GPU unavailable</span> : <>{info.gpu}{info.softwareRender ? ' (software)' : ''}</>) : 'Detecting GPU…'}</div>
          <div className="muted">{info ? `${info.cpuThreads} threads · ${info.ramGb.toFixed(0)} GB RAM · ${info.freeDiskGb.toFixed(0)} GB free` : ''}</div>
          <div className="muted">{info?.ffmpeg ? `Media engine ${info.ffmpeg.ffmpegVersion.split(' ').slice(0, 3).join(' ')}` : ''}</div>
          {info?.ffmpeg?.hwEncoders.length ? <div className="muted">HW encode: {info.ffmpeg.hwEncoders.join(', ')}</div> : null}
          <div className="muted" style={{ marginTop: 6 }}>v{info?.version ?? '0.9.0'} · VEYRA Beta</div>
        </div>
      </aside>

      <main className="home-main">
        {recovery.length > 0 && (
          <div className="recovery">
            <LifeBuoy size={18} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{info?.crashedLastTime ? 'VEYRA closed unexpectedly.' : 'Unsaved work was found.'} Recover your project?</div>
              {recovery.slice(0, 3).map((r) => (
                <div key={r.autosavePath} className="row" style={{ marginTop: 6 }}>
                  <span className="grow">{r.name} <span className="muted">· {new Date(r.time * 1000).toLocaleString()}</span></span>
                  <button className="btn sm primary" onClick={async () => { const o = await api.recoverProject(r.autosavePath); useEditor.getState().loadProject(o.project, o.path || null); useEditor.setState({ dirty: true, saveState: 'unsaved' }); useEditor.getState().toast('success', 'Project recovered — save it to keep the changes'); }}>Recover</button>
                  <button className="btn sm ghost" onClick={async () => { await api.discardRecovery(r.autosavePath); setRecovery((x) => x.filter((y) => y !== r)); }}>Discard</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <section className="home-card">
          <h2><Plus size={16} /> New project</h2>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
            <label className="col grow" style={{ gap: 4 }}><span className="label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /></label>
            <label className="col" style={{ gap: 4 }}><span className="label">Duration (s)</span><input className="input" type="number" min={1} value={dur} style={{ width: 90 }} onChange={(e) => setDur(Math.max(1, Number(e.target.value)))} /></label>
          </div>
          <div className="label" style={{ marginTop: 14 }}>Format</div>
          <div className="preset-grid">
            {RES_PRESETS.map((p) => (
              <button key={p.label} className={`preset ${w === p.w && h === p.h ? 'on' : ''}`} onClick={() => { setW(p.w); setH(p.h); }}>
                <span className="preset-shape" style={{ aspectRatio: `${p.w}/${p.h}` }} />
                <span>{p.label}</span><span className="muted">{p.w}×{p.h}</span>
              </button>
            ))}
            <div className="preset custom">
              <span className="label">Custom</span>
              <div className="row" style={{ gap: 3 }}><input className="input mono" type="number" value={w} style={{ width: 50, padding: '0 3px' }} onChange={(e) => setW(Math.max(16, Number(e.target.value)))} />×<input className="input mono" type="number" value={h} style={{ width: 50, padding: '0 3px' }} onChange={(e) => setH(Math.max(16, Number(e.target.value)))} /></div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 14, gap: 16, flexWrap: 'wrap' }}>
            <div className="col" style={{ gap: 4 }}>
              <span className="label">Frame rate</span>
              <div className="tabs">{FPS_PRESETS.map((f) => <button key={f} className={`tab ${fps === f ? 'on' : ''}`} onClick={() => setFps(f)}>{f}</button>)}</div>
            </div>
            <div className="col" style={{ gap: 4 }}><span className="label">Background</span><div className="row"><ColorField value={bg} onChange={setBg} alpha={false} /><span className="label">Transparent</span><Toggle on={transparent} onChange={setTransparent} /></div></div>
          </div>
          <div className="row" style={{ marginTop: 18 }}>
            <span className="muted grow">You can drag video files from Explorer anywhere onto this window to start immediately.</span>
            <button className="btn primary" onClick={create}><Plus size={14} /> Create project</button>
          </div>
        </section>

        <section className="home-card">
          <h2><History size={16} /> Recent</h2>
          {recent.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No recent projects yet.</div>}
          <div className="recent-list">
            {recent.map((r) => (
              <button key={r.path} className="recent" disabled={!r.exists} onClick={() => openProjectPath(r.path)} title={r.path}>
                <FileVideo size={16} />
                <span className="grow" style={{ textAlign: 'left' }}>{r.name}<div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{r.exists ? r.path : 'File not found'}</div></span>
              </button>
            ))}
          </div>
        </section>
        <div className="home-drop-hint">Drop footage here</div>
      </main>
    </div>
  );
}
