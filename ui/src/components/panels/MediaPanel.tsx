import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Box, Clapperboard, FileAudio, FileImage, FolderPlus, Grid2x2, Image as ImageIcon, List, Music, Pause, Play, Plus, Star, Upload } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { NONE } from '../../store/editor';
import { api, fileSrc } from '../../lib/api';
import { addAssetLayer } from '../../lib/ops';
import { runAction } from '../../lib/actions';
import { contextMenu, SearchBox, Select } from '../ui/primitives';
import { beginPointerDrag, timelineTimeAtX } from '../../lib/pointerDrag';
import type { Asset, AssetKind } from '../../types/project';

const KIND_ICON: Record<AssetKind, typeof Clapperboard> = { video: Clapperboard, audio: Music, image: FileImage, imageSequence: ImageIcon, svg: FileImage, model3d: Box, lut: FileAudio };
const fmtDur = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

const thumbQueue: string[] = [];
let thumbBusy = 0;
function requestThumb(a: Asset) {
  const s = useEditor.getState();
  if (s.thumbs[a.id] || thumbQueue.includes(a.id) || a.missing || a.kind === 'audio' || a.kind === 'model3d' || a.kind === 'lut') return;
  thumbQueue.push(a.id);
  pump();
}
function pump() {
  while (thumbBusy < 3 && thumbQueue.length) {
    const id = thumbQueue.shift()!;
    const a = useEditor.getState().project?.assets.find((x) => x.id === id);
    if (!a) continue;
    thumbBusy++;
    const path = a.sequencePattern ? a.sequencePattern.replace(/%0(\d)d/, (_, n) => String(a.sequenceStart).padStart(Number(n), '0')) : a.path;
    api.thumbnail(path, Math.min(1, a.info.duration / 3), 240, a.kind !== 'video')
      .then((url) => useEditor.setState((s) => ({ thumbs: { ...s.thumbs, [id]: url } })))
      .catch(() => {})
      .finally(() => { thumbBusy--; pump(); });
  }
}

function assetMenu(a: Asset): Parameters<typeof contextMenu>[1] {
  const s = useEditor.getState();
  return [
    { label: 'Add to Timeline at Playhead', action: () => addAssetLayer(a) },
    { label: 'New Composition from Clip', disabled: !(a.info.width > 0), action: async () => {
      const c = await api.newComposition(a.info.width, a.info.height, a.info.fps || 30, Math.max(1, a.info.duration || 10), a.name.replace(/\.[^.]+$/, ''));
      s.edit('New Comp from Clip', (d) => { d.compositions.push(c as never); });
      useEditor.setState({ compId: c.id, compStack: [...s.compStack, c.id], time: 0 });
      await addAssetLayer(a, 0, c.id);
    } },
    { separator: true },
    { label: a.favorite ? 'Remove from Favourites' : 'Add to Favourites', action: () => s.edit('Favourite', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x) x.favorite = !x.favorite; }) },
    { label: 'Add Tag…', action: () => { const t = window.prompt('Tag'); if (t) s.edit('Tag', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x && !x.tags.includes(t)) x.tags.push(t); }); } },
    { label: 'Rename…', action: () => { const n = window.prompt('Name', a.name); if (n) s.edit('Rename Asset', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x) x.name = n; }); } },
    { label: 'Move to Folder', submenu: [{ label: '(Root)', action: () => s.edit('Move', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x) x.folder = null; }) }, ...(s.project?.folders ?? []).map((f) => ({ label: f.name, action: () => s.edit('Move', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x) x.folder = f.id; }) }))] },
    { separator: true },
    { label: 'Generate Proxy', disabled: a.kind !== 'video', submenu: [['Half (540p)', 540], ['Quarter (270p)', 270], ['720p', 720], ['Eighth (135p)', 135]].map(([l, h]) => ({ label: String(l), action: () => { api.generateProxy(a.id, a.path, a.info.duration, Number(h)); s.toast('info', 'Generating proxy in the background'); } })) },
    { label: a.useProxy ? 'Use Original (disable proxy)' : 'Use Proxy', disabled: !a.proxy, action: () => s.edit('Toggle Proxy', (d) => { const x = d.assets.find((y) => y.id === a.id); if (x) x.useProxy = !x.useProxy; }) },
    { label: 'Relink…', action: async () => {
      const p = await open({ title: `Locate ${a.name}` });
      if (!p || Array.isArray(p) || !s.project) return;
      try { s.replaceProject('Relink', await api.relinkAsset(s.project, a.id, p)); s.toast('success', 'Relinked'); } catch (e) { s.toast('error', 'Relink failed', String(e)); }
    } },
    { label: 'Reveal in Explorer', action: () => api.reveal(a.path) },
    { separator: true },
    { label: 'Remove from Project', action: () => {
      const used = s.project?.compositions.some((c) => c.layers.some((l) => 'asset' in l.kind && l.kind.asset === a.id));
      if (used && !window.confirm(`${a.name} is used in the timeline. Remove it and its layers?`)) return;
      s.edit('Remove Asset', (d) => { d.assets = d.assets.filter((x) => x.id !== a.id); for (const c of d.compositions) c.layers = c.layers.filter((l) => !('asset' in l.kind && l.kind.asset === a.id)); });
    } },
  ];
}

const AssetTile = memo(function AssetTile({ a, selected, list }: { a: Asset; selected: boolean; list: boolean }) {
  const thumb = useEditor((s) => s.thumbs[a.id]);
  const ref = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<string[] | null>(null);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) requestThumb(a); });
    io.observe(el);
    return () => io.disconnect();
  }, [a]);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const Icon = KIND_ICON[a.kind];
  const dupe = useEditor((s) => (a.fingerprint ? (s.project?.assets.filter((x) => x.fingerprint === a.fingerprint).length ?? 0) > 1 : false));
  const toggleAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audio.current) { audio.current = new Audio(fileSrc(a.path)); audio.current.onended = () => setPlaying(false); }
    if (playing) { audio.current.pause(); setPlaying(false); } else { audio.current.play().then(() => setPlaying(true)).catch(() => useEditor.getState().toast('error', 'Preview playback is not supported for this format')); }
  };
  return (
    <div
      ref={ref}
      className={`asset ${list ? 'list' : ''} ${selected ? 'sel' : ''} ${a.missing ? 'missing' : ''}`}
      onPointerDown={(e) => {
        if (a.missing) return;
        beginPointerDrag(e, {
          label: a.name, accepts: ['timeline', 'viewer'],
          onDrop: (d) => {
            const t = d.target === 'timeline' ? timelineTimeAtX(d.x) : undefined;
            addAssetLayer(a, t).catch((err) => useEditor.getState().toast('error', 'Could not add media', String(err)));
          },
        });
      }}
      onClick={(e) => { const s = useEditor.getState(); useEditor.setState({ selectedAssets: e.ctrlKey ? (selected ? s.selectedAssets.filter((x) => x !== a.id) : [...s.selectedAssets, a.id]) : [a.id] }); }}
      onDoubleClick={() => !a.missing && addAssetLayer(a)}
      onContextMenu={(e) => contextMenu(e, assetMenu(a))}
      onPointerMove={(e) => {
        if (a.kind !== 'video' || list) return;
        if (!scrub) { setScrub([]); api.filmstrip(a.id, a.path, a.info.duration, 12).then(setScrub).catch(() => {}); }
        const r = e.currentTarget.getBoundingClientRect();
        setHoverIdx(Math.floor(((e.clientX - r.left) / r.width) * 12));
      }}
      onPointerLeave={() => setHoverIdx(-1)}
      title={`${a.name}\n${a.info.width ? `${a.info.width}×${a.info.height} · ` : ''}${a.info.fps ? `${+a.info.fps.toFixed(3)} fps · ` : ''}${a.info.videoCodec || a.info.audioCodec}${a.info.hasAlpha ? ' · alpha' : ''}${a.info.variableFrameRate ? ' · VFR' : ''}\n${a.path}`}
    >
      <div className="asset-thumb checker">
        {hoverIdx >= 0 && scrub?.[hoverIdx] ? <img src={scrub[hoverIdx]} alt="" /> : thumb ? <img src={thumb} alt="" /> : <Icon size={list ? 14 : 22} className="muted" />}
        {!list && a.info.duration > 0 && <span className="asset-dur mono">{fmtDur(a.info.duration)}</span>}
        {a.kind === 'audio' && !list && <button className="asset-play" onClick={toggleAudio}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>}
        {a.missing && <span className="asset-badge err"><AlertTriangle size={11} /> Offline</span>}
        {a.proxy && a.useProxy && <span className="asset-badge">P</span>}
        {a.favorite && <Star size={11} className="asset-fav" fill="currentColor" />}
      </div>
      <div className="asset-meta">
        <span className="asset-name">{a.name}</span>
        {list && <span className="muted mono">{a.info.width ? `${a.info.width}×${a.info.height}` : ''}</span>}
        {list && <span className="muted mono">{fmtDur(a.info.duration)}</span>}
        {list && <span className="muted mono">{a.info.fileSize ? fmtSize(a.info.fileSize) : ''}</span>}
        {dupe && <span className="pill warn" title="Same file imported more than once">dup</span>}
      </div>
    </div>
  );
});

export function MediaPanel() {
  const assets = useEditor((s) => s.project?.assets ?? NONE);
  const folders = useEditor((s) => s.project?.folders ?? NONE);
  const selected = useEditor((s) => s.selectedAssets);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [kind, setKind] = useState<'all' | AssetKind | 'favorites' | 'missing'>('all');
  const [sort, setSort] = useState<'name' | 'kind' | 'duration' | 'added'>('added');
  const [folder, setFolder] = useState<string | null>(null);

  const shown = useMemo(() => {
    let v = assets.filter((a) => (folder ? a.folder === folder : true));
    if (kind === 'favorites') v = v.filter((a) => a.favorite);
    else if (kind === 'missing') v = v.filter((a) => a.missing);
    else if (kind !== 'all') v = v.filter((a) => a.kind === kind);
    if (q) { const s = q.toLowerCase(); v = v.filter((a) => a.name.toLowerCase().includes(s) || a.tags.some((t) => t.toLowerCase().includes(s)) || a.info.videoCodec.includes(s)); }
    if (sort !== 'added') v = [...v].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'kind' ? a.kind.localeCompare(b.kind) : b.info.duration - a.info.duration);
    return v;
  }, [assets, q, kind, sort, folder]);

  const sel = assets.find((a) => a.id === selected[0]);
  const missing = assets.filter((a) => a.missing).length;

  return (
    <div className="panel media-panel">
      <div className="panel-head">
        <SearchBox value={q} onChange={setQ} placeholder="Search media, tags" />
        <button className="icon-btn" title="Import media (Ctrl+I)" onClick={() => runAction('file.import')}><Upload size={14} /></button>
        <button className="icon-btn" title="New folder" onClick={() => { const n = window.prompt('Folder name'); if (n) useEditor.getState().edit('New Folder', (d) => { d.folders.push({ id: Math.random().toString(36).slice(2, 14), name: n, parent: null }); }); }}><FolderPlus size={14} /></button>
        <button className={`icon-btn ${view === 'grid' ? 'active' : ''}`} title="Thumbnails" onClick={() => setView('grid')}><Grid2x2 size={14} /></button>
        <button className={`icon-btn ${view === 'list' ? 'active' : ''}`} title="List" onClick={() => setView('list')}><List size={14} /></button>
      </div>
      <div className="media-filters">
        <Select value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio' }, { value: 'image', label: 'Images' }, { value: 'imageSequence', label: 'Sequences' }, { value: 'svg', label: 'SVG' }, { value: 'model3d', label: '3D' }, { value: 'favorites', label: 'Favourites' }, { value: 'missing', label: `Offline (${missing})` }]} />
        <Select value={sort} onChange={setSort} options={[{ value: 'added', label: 'Date added' }, { value: 'name', label: 'Name' }, { value: 'kind', label: 'Type' }, { value: 'duration', label: 'Duration' }]} />
        {folders.length > 0 && <Select value={folder ?? ''} onChange={(v) => setFolder(v || null)} options={[{ value: '', label: 'All folders' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />}
      </div>
      {missing > 0 && <button className="offline-bar" onClick={() => runAction('file.relink')}><AlertTriangle size={13} /> {missing} file{missing > 1 ? 's' : ''} offline — Relink…</button>}
      <div className={`panel-body media-grid ${view}`}>
        {shown.length === 0 ? (
          <div className="empty">
            <Plus size={22} />
            <div>{assets.length ? 'No media matches' : 'Drag files from Explorer here, or import'}</div>
            {!assets.length && <button className="btn sm" onClick={() => runAction('file.import')}>Import media…</button>}
          </div>
        ) : shown.map((a) => <AssetTile key={a.id} a={a} selected={selected.includes(a.id)} list={view === 'list'} />)}
      </div>
      {sel && (
        <div className="media-info">
          <div className="asset-name">{sel.name}</div>
          <div className="muted mono">
            {[sel.info.width ? `${sel.info.width}×${sel.info.height}` : '', sel.info.fps ? `${+sel.info.fps.toFixed(3)} fps` : '', sel.info.videoCodec, sel.info.pixFmt, sel.info.audioCodec && `${sel.info.audioCodec} ${sel.info.sampleRate / 1000}kHz ${sel.info.channels}ch`, sel.info.fileSize ? fmtSize(sel.info.fileSize) : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}
