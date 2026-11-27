// OS file drag & drop (Windows Explorer → VEYRA) and in-app asset drags.
import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api, isTauri } from '../../lib/api';
import { addAssetLayer } from '../../lib/ops';
import { activeComp, useEditor } from '../../store/editor';
import type { Asset, Project } from '../../types/project';

export const ASSET_MIME = 'application/x-veyra-asset';

function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
}

function setHighlight(target: string | null) {
  document.querySelectorAll<HTMLElement>('[data-drop]').forEach((el) => el.classList.toggle('drop-hot', el.dataset.drop === target));
  document.body.classList.toggle('dragging-files', target !== undefined && target !== null);
}

/** Import files; optionally place them on the timeline. Creates a project first when on the home screen. */
export async function importPaths(paths: string[], target: string | null) {
  const s = useEditor.getState();
  if (!paths.length) return;
  const lower = paths.map((p) => p.toLowerCase());
  if (lower.length === 1 && (lower[0].endsWith('.directory') || lower[0].endsWith('.veyra'))) {
    const { openProjectPath } = await import('./coreActions');
    return openProjectPath(paths[0]);
  }
  const models = paths.filter((p) => /\.(glb|gltf|obj|blend|fbx|usd|usda|usdc|usdz|abc)$/i.test(p));
  const subs = paths.filter((p) => /\.(srt|vtt)$/i.test(p));
  const media = paths.filter((p) => !models.includes(p) && !subs.includes(p));
  s.toast('info', `Importing ${paths.length} item${paths.length > 1 ? 's' : ''}…`);
  const res = media.length ? await api.importMedia(media, false, s.project?.assets.map((a) => a.fingerprint).filter(Boolean) ?? []) : { assets: [], errors: [], duplicates: [] };
  res.errors.forEach((e) => s.toast('error', 'Import failed', e));
  if (res.duplicates.length) s.toast('warning', 'Already in project (imported again)', res.duplicates.join(', '));

  // From the home screen, start a project that matches the first video.
  if (!useEditor.getState().project) {
    const v = res.assets.find((a) => a.kind === 'video' && a.info.width > 0);
    const st = useEditor.getState().settings;
    const p: Project = await api.newProject({
      name: v ? v.name.replace(/\.[^.]+$/, '') : 'Untitled',
      width: v?.info.width || st?.defaultWidth || 1920,
      height: v?.info.height || st?.defaultHeight || 1080,
      fps: v?.info.fps ? Math.round(v.info.fps * 1000) / 1000 : st?.defaultFps || 30,
      duration: Math.max(5, ...res.assets.map((a) => a.info.duration || 0)),
    });
    useEditor.getState().loadProject(p, null);
    target = 'timeline'; // dropping footage on the home screen starts editing immediately
  }
  const st = useEditor.getState();
  st.edit('Import Media', (d) => {
    for (const a of res.assets) if (!d.assets.some((x) => x.id === a.id)) d.assets.push(a as never);
  });
  if (res.assets.length) st.toast('success', `Imported ${res.assets.length} item${res.assets.length > 1 ? 's' : ''}`);
  if (target === 'timeline' || target === 'viewer') {
    let t = st.time;
    for (const a of res.assets) {
      const l = await addAssetLayer(a as Asset, t);
      if (l && a.kind !== 'image') t = l.start + l.duration; // place clips one after another
    }
  }
  for (const m of models) {
    try { await addAssetLayer({ id: '', name: m.split(/[\\/]/).pop()!, kind: 'model3d', path: m } as Asset); }
    catch (e) { st.toast('error', 'Model import failed', String(e)); }
  }
  for (const sub of subs) {
    const comp = activeComp();
    if (!comp) continue;
    try {
      const layers = await api.importSubtitles(comp, sub);
      st.edit('Import Subtitles', (d) => { d.compositions.find((c) => c.id === comp.id)?.layers.unshift(...(layers as never[])); });
      st.toast('success', `Added ${layers.length} subtitle layers`);
    } catch (e) { st.toast('error', 'Subtitle import failed', String(e)); }
  }
}

export function useOsDragDrop() {
  useEffect(() => {
    if (!isTauri) return;
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      const scale = window.devicePixelRatio || 1;
      const z = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
      if (p.type === 'over' || p.type === 'enter') {
        setHighlight(dropTargetAt(p.position.x / scale / z, p.position.y / scale / z) ?? 'app');
      } else if (p.type === 'drop') {
        const target = dropTargetAt(p.position.x / scale / z, p.position.y / scale / z);
        setHighlight(null);
        importPaths(p.paths, target).catch((e) => useEditor.getState().toast('error', 'Import failed', String(e)));
      } else {
        setHighlight(null);
      }
    });
    // In-app drags (asset from the media browser onto timeline/viewer).
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(ASSET_MIME)) { e.preventDefault(); setHighlight(dropTargetAt(e.clientX, e.clientY)); }
    };
    const drop = (e: DragEvent) => {
      const id = e.dataTransfer?.getData(ASSET_MIME);
      setHighlight(null);
      // Panels that place assets precisely (the timeline drops at the pointer time) handle it themselves.
      if (!id || e.defaultPrevented) return;
      e.preventDefault();
      const target = dropTargetAt(e.clientX, e.clientY);
      const asset = useEditor.getState().project?.assets.find((a) => a.id === id);
      if (asset && (target === 'timeline' || target === 'viewer')) addAssetLayer(asset).catch((err) => useEditor.getState().toast('error', 'Could not add clip', String(err)));
    };
    const leave = () => setHighlight(null);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', leave);
    return () => { un.then((f) => f()); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); window.removeEventListener('dragend', leave); };
  }, []);
}
