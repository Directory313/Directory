// Application-level actions: file, edit, layer creation, windows. Registered at module load.
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { documentDir } from '@tauri-apps/api/path';
import { registerActions } from '../../lib/actions';
import { api } from '../../lib/api';
import { addLayer, copyLayers, deleteLayers, duplicateLayers, pasteLayers, precompose, selectAllLayers, splitAtPlayhead, moveLayers } from '../../lib/ops';
import { activeComp, draftComp, useEditor } from '../../store/editor';
import { importPaths } from './dragdrop';
import { checkForUpdates } from '../../lib/updater';
import type { Draft } from 'immer';
import type { Composition, Layer } from '../../types/project';

const S = () => useEditor.getState();
const hasProject = () => !!S().project;
const hasSel = () => S().selectedLayers.length > 0;

export const MEDIA_FILTERS = [
  { name: 'All supported', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'mpeg', 'mpg', 'm4v', 'mxf', 'ts', 'mts', 'm2ts', 'flv', 'wmv', '3gp', 'gif', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'tga', 'bmp', 'exr', 'hdr', 'psd', 'svg', 'wav', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'm4a', 'wma', 'glb', 'gltf', 'obj', 'blend', 'fbx', 'usd', 'usdz', 'abc', 'srt', 'vtt', 'cube'] },
  { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'mpeg', 'mpg', 'm4v', 'mxf', 'ts', 'mts', 'm2ts', 'flv', 'wmv', '3gp', 'gif'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'tga', 'bmp', 'exr', 'hdr', 'psd', 'svg'] },
  { name: 'Audio', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'm4a', 'wma'] },
  { name: '3D / Blender', extensions: ['glb', 'gltf', 'obj', 'blend', 'fbx', 'usd', 'usdz', 'abc'] },
];

export async function openProjectPath(path: string) {
  const s = S();
  if (s.dirty && !(await ask('Discard unsaved changes to the current project?', { title: 'Directory', kind: 'warning' }))) return;
  try {
    const r = await api.openProject(path);
    S().loadProject(r.project, r.path);
    if (r.missing.length) S().toast('warning', `${r.missing.length} media file(s) are offline`, `${r.missing.join(', ')}\nUse Media → Relink to locate them.`);
    else S().toast('success', `Opened ${r.project.name}`);
  } catch (e) {
    S().toast('error', 'Could not open project', String(e));
  }
}

/**
 * Every project lives in its own folder: "X\Name.directory" becomes "X\Name\Name.directory"
 * (unless the chosen folder is already named after the project). The folder holds the
 * project file, its layout.json and its Backups.
 */
export function projectFolderPath(picked: string): string {
  const parts = picked.split(/[\\/]/);
  let file = parts.pop()!;
  if (!/\.(directory|veyra)$/i.test(file)) file += '.directory';
  const stem = file.replace(/\.(directory|veyra)$/i, '');
  const parent = parts[parts.length - 1] ?? '';
  if (parent.toLowerCase() === stem.toLowerCase()) return [...parts, file].join('\\');
  return [...parts, stem, file].join('\\');
}

export async function saveProject(saveAs = false) {
  const s = S();
  if (!s.project) return;
  let path = s.projectPath;
  if (!path || saveAs) {
    let base = '';
    try { base = `${await documentDir()}\\Directory Projects\\`; } catch { /* dialog default */ }
    const picked = await save({ title: 'Save Directory project (a project folder is created for it)', defaultPath: `${base}${s.project.name}.directory`, filters: [{ name: 'Directory Project', extensions: ['directory', 'veyra'] }] });
    if (!picked) return;
    path = projectFolderPath(picked);
  }
  useEditor.setState({ saveState: 'saving' });
  try {
    await api.saveProject(s.project, path);
    const name = path.split(/[\\/]/).pop()!.replace(/\.(directory|veyra)$/i, '');
    useEditor.setState({ projectPath: path, dirty: false, saveState: 'saved', lastSaved: Date.now() });
    if (S().project && S().project!.name !== name && saveAs) S().edit('Rename Project', (d) => { d.name = name; });
    S().toast('success', 'Project saved');
  } catch (e) {
    useEditor.setState({ saveState: 'error' });
    S().toast('error', 'Save failed — your previous file is untouched', String(e));
  }
}

async function importDialog(asSequence = false) {
  const picked = await open({ multiple: true, title: asSequence ? 'Choose any frame of the image sequence' : 'Import media', filters: asSequence ? [MEDIA_FILTERS[2]] : MEDIA_FILTERS });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (asSequence) {
    const r = await api.importMedia(paths, true, []);
    r.errors.forEach((e) => S().toast('error', 'Sequence import failed', e));
    S().edit('Import Sequence', (d) => { d.assets.push(...(r.assets as never[])); });
    return;
  }
  await importPaths(paths, null);
}

async function newLayer(kind: string, variant?: string, extra: Record<string, unknown> = {}) {
  if (!hasProject()) return;
  await addLayer({ kind, variant, ...extra } as never, `New ${variant ?? kind}`);
}

async function newComposition() {
  const c = activeComp();
  const s = S();
  const comp = await api.newComposition(c?.width ?? 1920, c?.height ?? 1080, c?.fps ?? 30, c?.duration ?? 10, `Comp ${(s.project?.compositions.length ?? 0) + 1}`);
  s.edit('New Composition', (d) => { d.compositions.push(comp as Draft<Composition>); });
  s.set({ compId: comp.id, compStack: [...s.compStack, comp.id], selectedLayers: [], time: 0 });
}

async function nestActiveInto() {
  // Place another composition as a nested layer.
  const s = S();
  const c = activeComp();
  if (!c || !s.project) return;
  const other = s.project.compositions.filter((x) => x.id !== c.id);
  if (!other.length) { s.toast('info', 'Create another composition first'); return; }
  const target = other[other.length - 1];
  try {
    const l = await api.createLayer(c, { kind: 'comp', nested: target, start: s.time });
    s.edit('Nest Composition', (d) => { draftComp(d)?.layers.unshift(l as Draft<Layer>); });
  } catch (e) { s.toast('error', 'Cannot nest that composition', String(e)); }
}

async function exportInterchange(format: 'srt' | 'vtt' | 'otio' | 'edl') {
  const s = S();
  if (!s.project) return;
  const path = await save({ title: `Export ${format.toUpperCase()}`, defaultPath: `${s.project.name}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (!path) return;
  await api.exportInterchange(s.project, s.compId, format, path);
  s.toast('success', `Exported ${format.toUpperCase()}`);
}

async function relinkAll() {
  const s = S();
  if (!s.project) return;
  const dir = await open({ directory: true, title: 'Folder to search for missing media' });
  if (!dir || Array.isArray(dir)) return;
  const [p, n] = await api.relinkMedia(s.project, dir);
  s.replaceProject('Relink Media', p);
  s.toast(n ? 'success' : 'warning', n ? `Relinked ${n} file(s)` : 'No missing files were found in that folder');
}

async function collectFiles() {
  const s = S();
  if (!s.project) return;
  if (!s.projectPath) { s.toast('info', 'Save the project first; media is collected next to the project file'); return; }
  const dir = s.projectPath.replace(/[\\/][^\\/]+$/, '');
  const [p, n] = await api.collectProject(s.project, dir);
  s.replaceProject('Collect Files', p);
  s.toast('success', `Copied ${n} file(s) into ${dir}\\Media`);
}

registerActions([
  { id: 'file.home', label: 'Go to Home Screen', group: 'File', run: async () => { if (S().dirty && !(await ask('Leave this project? Unsaved changes are kept in autosave.', { title: 'Directory' }))) return; S().set({ screen: 'home', playing: false }); } },
  { id: 'file.open', label: 'Open Project…', group: 'File', shortcut: 'Ctrl+O', run: async () => { const p = await open({ filters: [{ name: 'Directory Project', extensions: ['directory', 'veyra'] }] }); if (p && !Array.isArray(p)) await openProjectPath(p); } },
  { id: 'file.save', label: 'Save Project', group: 'File', shortcut: 'Ctrl+S', run: () => saveProject(false), enabled: hasProject },
  { id: 'file.saveAs', label: 'Save Project As…', group: 'File', shortcut: 'Ctrl+Shift+S', run: () => saveProject(true), enabled: hasProject },
  { id: 'file.import', label: 'Import Media…', group: 'File', shortcut: 'Ctrl+I', run: () => importDialog(false) },
  { id: 'file.importSequence', label: 'Import Image Sequence…', group: 'File', run: () => importDialog(true), enabled: hasProject },
  { id: 'file.export', label: 'Export…', group: 'File', shortcut: 'Ctrl+M', run: () => S().set({ dialog: 'export' }), enabled: hasProject },
  { id: 'file.renderQueue', label: 'Render Queue', group: 'File', shortcut: 'Ctrl+Alt+M', run: () => S().set({ dialog: 'renderQueue' }), enabled: hasProject },
  { id: 'file.exportSrt', label: 'Export Subtitles (SRT)', group: 'File', run: () => exportInterchange('srt'), enabled: hasProject },
  { id: 'file.exportVtt', label: 'Export Subtitles (WebVTT)', group: 'File', run: () => exportInterchange('vtt'), enabled: hasProject },
  { id: 'file.exportOtio', label: 'Export Timeline (OpenTimelineIO)', group: 'File', run: () => exportInterchange('otio'), enabled: hasProject },
  { id: 'file.exportEdl', label: 'Export Timeline (EDL)', group: 'File', run: () => exportInterchange('edl'), enabled: hasProject },
  { id: 'file.relink', label: 'Relink Missing Media…', group: 'File', run: relinkAll, enabled: hasProject },
  { id: 'file.collect', label: 'Collect Files into Project Folder', group: 'File', run: collectFiles, enabled: hasProject },
  { id: 'app.settings', label: 'Settings', group: 'App', shortcut: 'Ctrl+,', run: () => S().set({ dialog: 'settings' }) },
  { id: 'app.palette', label: 'Command Palette', group: 'App', shortcut: 'Ctrl+Shift+P', run: () => S().set({ dialog: 'palette' }) },
  { id: 'app.shortcuts', label: 'Keyboard Shortcuts', group: 'App', shortcut: 'F1', run: () => S().set({ dialog: 'shortcuts' }) },
  { id: 'app.checkUpdates', label: 'Check for Updates…', group: 'App', run: () => checkForUpdates(true) },
  { id: 'app.clearCache', label: 'Clear Render Cache', group: 'App', run: async () => { await api.clearCache(); S().set({ cached: {} }); S().toast('success', 'Cache cleared'); } },

  { id: 'edit.undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', run: () => S().undo(), enabled: () => S().past.length > 0 },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z', run: () => S().redo(), enabled: () => S().future.length > 0 },
  { id: 'edit.redo2', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Y', run: () => S().redo(), enabled: () => S().future.length > 0 },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', shortcut: 'Ctrl+C', run: copyLayers, enabled: hasSel },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', shortcut: 'Ctrl+X', run: () => { copyLayers(); deleteLayers(); }, enabled: hasSel },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', shortcut: 'Ctrl+V', run: pasteLayers, enabled: () => !!S().clipboard.layers?.length },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', shortcut: 'Ctrl+D', run: () => duplicateLayers(), enabled: hasSel },
  // Keyframe deletion (timeline) takes precedence when keys are selected.
  { id: 'edit.delete', label: 'Delete', group: 'Edit', shortcut: 'Delete', run: () => deleteLayers(), enabled: () => hasSel() && S().selectedKeys.length === 0 && !S().selectedMask },
  { id: 'edit.selectAll', label: 'Select All Layers', group: 'Edit', shortcut: 'Ctrl+A', run: selectAllLayers, enabled: hasProject },
  { id: 'edit.deselect', label: 'Deselect All', group: 'Edit', shortcut: 'Ctrl+Shift+A', run: () => S().set({ selectedLayers: [], selectedKeys: [], selectedMask: null }) },
  { id: 'edit.split', label: 'Split at Playhead', group: 'Edit', shortcut: 'Ctrl+Shift+D', run: () => splitAtPlayhead(), enabled: hasProject },
  { id: 'edit.precompose', label: 'Create Compound Clip', group: 'Layer', shortcut: 'Ctrl+G', run: () => precompose(), enabled: hasSel },
  { id: 'layer.lock', label: 'Lock / Unlock Selected', group: 'Layer', shortcut: 'Ctrl+L', run: () => S().edit('Lock', (d) => { for (const l of draftComp(d)?.layers ?? []) if (S().selectedLayers.includes(l.id)) l.locked = !l.locked; }), enabled: hasSel },
  { id: 'layer.hide', label: 'Hide / Show Selected', group: 'Layer', shortcut: 'Ctrl+Shift+H', run: () => S().edit('Visibility', (d) => { for (const l of draftComp(d)?.layers ?? []) if (S().selectedLayers.includes(l.id)) l.visible = !l.visible; }), enabled: hasSel },
  { id: 'layer.forward', label: 'Bring Forward', group: 'Layer', shortcut: 'Ctrl+]', run: () => moveLayers(S().selectedLayers, 'up'), enabled: hasSel },
  { id: 'layer.backward', label: 'Send Backward', group: 'Layer', shortcut: 'Ctrl+[', run: () => moveLayers(S().selectedLayers, 'down'), enabled: hasSel },
  { id: 'layer.front', label: 'Bring to Front', group: 'Layer', shortcut: 'Ctrl+Shift+]', run: () => moveLayers(S().selectedLayers, 'top'), enabled: hasSel },
  { id: 'layer.back', label: 'Send to Back', group: 'Layer', shortcut: 'Ctrl+Shift+[', run: () => moveLayers(S().selectedLayers, 'bottom'), enabled: hasSel },
  { id: 'layer.newText', label: 'New Text Layer', group: 'Layer', shortcut: 'Ctrl+Alt+T', run: () => newLayer('text') },
  { id: 'layer.newSolid', label: 'New Solid', group: 'Layer', shortcut: 'Ctrl+Alt+Y', run: () => newLayer('solid') },
  { id: 'layer.newNull', label: 'New Null Object', group: 'Layer', shortcut: 'Ctrl+Alt+Shift+Y', run: () => newLayer('null') },
  { id: 'layer.newAdjustment', label: 'New Adjustment Layer', group: 'Layer', shortcut: 'Ctrl+Alt+A', run: () => newLayer('adjustment') },
  { id: 'layer.newCamera', label: 'New Camera', group: 'Layer', run: () => newLayer('camera') },
  { id: 'layer.newLightPoint', label: 'New Point Light', group: 'Layer', run: () => newLayer('light', 'point') },
  { id: 'layer.newLightSpot', label: 'New Spot Light', group: 'Layer', run: () => newLayer('light', 'spot') },
  { id: 'layer.newLightDir', label: 'New Directional Light', group: 'Layer', run: () => newLayer('light', 'directional') },
  { id: 'layer.newLightAmbient', label: 'New Ambient Light', group: 'Layer', run: () => newLayer('light', 'ambient') },
  { id: 'layer.newParticles', label: 'New Particle System', group: 'Layer', run: () => newLayer('particles') },
  ...['rect', 'roundedRect', 'ellipse', 'polygon', 'star', 'triangle', 'line', 'arrow'].map((v) => ({ id: `layer.shape.${v}`, label: `New Shape: ${v}`, group: 'Layer', run: () => newLayer('shape', v) })),
  ...['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'pyramid', 'circle', 'grid'].map((v) => ({ id: `layer.mesh.${v}`, label: `New 3D ${v}`, group: '3D', run: () => newLayer('mesh', v) })),
  ...['grid', 'noise', 'wave', 'gradient', 'checkerboard', 'animatedBackground'].map((v) => ({ id: `layer.gen.${v}`, label: `New Generator: ${v}`, group: 'Layer', run: () => newLayer('generator', v) })),
  { id: 'comp.new', label: 'New Composition', group: 'Composition', shortcut: 'Ctrl+N', run: newComposition, enabled: hasProject },
  { id: 'comp.settings', label: 'Composition Settings…', group: 'Composition', shortcut: 'Ctrl+Alt+K', run: () => S().set({ dialog: 'compSettings' }), enabled: hasProject },
  { id: 'comp.nest', label: 'Nest Another Composition Here', group: 'Composition', run: nestActiveInto, enabled: hasProject },
]);
