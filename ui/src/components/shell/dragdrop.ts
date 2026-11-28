// OS file drag & drop (Windows Explorer → Directory). In-app drags: lib/pointerDrag.
import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api, isTauri } from '../../lib/api';
import { addAssetLayer } from '../../lib/ops';
import { dropTargetAt } from '../../lib/pointerDrag';
import { activeComp, useEditor } from '../../store/editor';
import type { Asset, Project } from '../../types/project';

function setHighlight(target: string | null) {
  document.querySelectorAll<HTMLElement>('[data-drop]').forEach((el) => el.classList.toggle('drop-hot', el.dataset.drop === target));
  document.body.classList.toggle('dragging-files', target !== undefined && target !== null);
}

/** Import files; optionally place them on the timeline. Creates a project first when on the home screen. */
/** `at`: timeline time to place the first clip at (defaults to the playhead). */
export async function importPaths(paths: string[], target: string | null, at?: number) {
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
    let t = at ?? st.time;
    for (const a of res.assets) {
      const l = await addAssetLayer(a as Asset, t);
      if (l && a.kind !== 'image') t = l.start + l.duration; // place clips one after another
    }
  }
  for (const m of models) {
    try { await addAssetLayer({ id: '', name: m.split(/[\\/]/).pop()!, kind: 'model3d', path: m } as Asset, at); }
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
    // In-app drags (media, library, online assets) use pointer events: see lib/pointerDrag.
    return () => { un.then((f) => f()); };
  }, []);
}
