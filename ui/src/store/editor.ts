// Central editor store. The project document is immutable (immer); every edit goes through
// `edit()` which records undo history and syncs the backend renderer.
import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Composition, Effect, EffectDef, Layer, Project } from '../types/project';
import { api, isTauri, type AppInfo, type Settings } from '../lib/api';

export type Tool = 'select' | 'hand' | 'zoom' | 'text' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'pen' | 'maskRect' | 'maskEllipse' | 'maskPen' | 'track' | 'orbit';

export interface KeySel { layerId: string; path: string; t: number }
export interface Toast { id: number; kind: 'info' | 'success' | 'warning' | 'error'; text: string; detail?: string; time: number }
export type Dialog = null | 'export' | 'settings' | 'newComp' | 'compSettings' | 'palette' | 'renderQueue' | 'shortcuts' | 'about' | 'track' | 'presets';

export interface ExportJob { id: string; label: string; status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'; progress?: import('../lib/api').ExportProgress; report?: import('../lib/api').ExportReport; error?: string; log?: string; settings: import('../lib/api').ExportSettings; compId: string; started: number }

interface Clipboard { layers?: Layer[]; effects?: Effect[]; keys?: { path: string; keys: unknown[] }[]; transform?: Layer['transform'] }

export interface EditorState {
  screen: 'home' | 'editor';
  project: Project | null;
  projectPath: string | null;
  dirty: boolean;
  lastSaved: number | null;
  saveState: 'saved' | 'saving' | 'unsaved' | 'autosaved' | 'error';
  past: { project: Project; label: string }[];
  future: { project: Project; label: string }[];
  lastEdit: { key: string; at: number } | null;
  /** performance.now() of the most recent edit (drives the fast interactive preview). */
  lastEditTime: number;
  revision: number;
  syncedRevision: number;

  compId: string;
  compStack: string[];
  time: number;
  playing: boolean;
  loop: boolean;
  previewScale: number;
  draft: boolean;
  tool: Tool;
  selectedLayers: string[];
  selectedKeys: KeySel[];
  selectedAssets: string[];
  selectedMask: string | null;
  activeProp: string | null;
  graphProps: string[];
  autoKey: boolean;
  snapping: boolean;
  viewer: { zoom: number; panX: number; panY: number; guides: boolean; grid: boolean; safe: boolean; rulers: boolean; checker: boolean; mode: '2d' | '3d' };

  effectDefs: EffectDef[];
  settings: Settings | null;
  appInfo: AppInfo | null;
  toasts: Toast[];
  dialog: Dialog;
  /** Name of the workspace layout currently shown (e.g. 'Colour Grading'). */
  workspace: string;
  thumbs: Record<string, string>;
  cached: Record<string, number[]>;
  jobs: ExportJob[];
  clipboard: Clipboard;
  playbackFps: number;
  droppedFrames: number;

  // actions
  set: (p: Partial<EditorState>) => void;
  loadProject: (p: Project, path?: string | null) => void;
  edit: (label: string, fn: (d: Draft<Project>) => void, coalesce?: string) => void;
  replaceProject: (label: string, p: Project) => void;
  undo: () => void;
  redo: () => void;
  ensureSynced: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  setTime: (t: number) => void;
  select: (ids: string[], additive?: boolean) => void;
}

let syncTimer: number | undefined;
let syncWaiters: (() => void)[] = [];
let syncing = false;
let syncAgain = false;
let toastId = 1;

export const useEditor = create<EditorState>((set, get) => ({
  screen: 'home',
  project: null,
  projectPath: null,
  dirty: false,
  lastSaved: null,
  saveState: 'saved',
  past: [],
  future: [],
  lastEdit: null,
  lastEditTime: 0,
  revision: 0,
  syncedRevision: 0,
  compId: '',
  compStack: [],
  time: 0,
  playing: false,
  loop: true,
  previewScale: 0.5,
  draft: false,
  tool: 'select',
  selectedLayers: [],
  selectedKeys: [],
  selectedAssets: [],
  selectedMask: null,
  activeProp: null,
  graphProps: [],
  autoKey: false,
  snapping: true,
  viewer: { zoom: 0, panX: 0, panY: 0, guides: false, grid: false, safe: false, rulers: false, checker: true, mode: '2d' },
  effectDefs: [],
  settings: null,
  appInfo: null,
  toasts: [],
  dialog: null,
  workspace: '',
  thumbs: {},
  cached: {},
  jobs: [],
  clipboard: {},
  playbackFps: 0,
  droppedFrames: 0,

  set: (p) => set(p),

  loadProject: (p, path = null) => {
    set({
      project: p, projectPath: path, dirty: false, past: [], future: [], compId: p.activeComp, compStack: [p.activeComp],
      time: 0, selectedLayers: [], selectedKeys: [], selectedAssets: [], screen: 'editor', saveState: 'saved',
      revision: get().revision + 1, cached: {},
    });
    scheduleSync(0);
  },

  edit: (label, fn, coalesce) => {
    const s = get();
    if (!s.project) return;
    const next = produce(s.project, fn);
    if (next === s.project) return;
    const now = performance.now();
    const merge = coalesce && s.lastEdit?.key === coalesce && now - s.lastEdit.at < 800;
    set({
      project: next,
      past: merge ? s.past : [...s.past.slice(-199), { project: s.project, label }],
      future: [],
      dirty: true,
      saveState: 'unsaved',
      lastEdit: coalesce ? { key: coalesce, at: now } : null,
      lastEditTime: now,
      revision: s.revision + 1,
    });
    scheduleSync();
  },

  replaceProject: (label, p) => {
    const s = get();
    if (!s.project) return;
    set({ project: p, past: [...s.past.slice(-199), { project: s.project, label }], future: [], dirty: true, saveState: 'unsaved', revision: s.revision + 1, lastEdit: null });
    scheduleSync();
  },

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev || !s.project) return;
    set({ project: prev.project, past: s.past.slice(0, -1), future: [{ project: s.project, label: prev.label }, ...s.future], dirty: true, saveState: 'unsaved', revision: s.revision + 1, lastEdit: null });
    get().toast('info', `Undo ${prev.label}`);
    scheduleSync();
  },

  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next || !s.project) return;
    set({ project: next.project, future: s.future.slice(1), past: [...s.past, { project: s.project, label: next.label }], dirty: true, saveState: 'unsaved', revision: s.revision + 1, lastEdit: null });
    get().toast('info', `Redo ${next.label}`);
    scheduleSync();
  },

  ensureSynced: () => {
    if (get().syncedRevision >= get().revision) return Promise.resolve();
    return new Promise<void>((resolve) => { syncWaiters.push(resolve); scheduleSync(0); });
  },

  toast: (kind, text, detail) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, text, detail, time: Date.now() }] });
    const ttl = kind === 'error' ? 9000 : kind === 'warning' ? 6000 : 2800;
    window.setTimeout(() => get().dismissToast(id), ttl);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setTime: (t) => {
    const c = activeComp();
    if (!c) return;
    const clamped = Math.max(0, Math.min(c.duration, t));
    set({ time: Math.round(clamped * c.fps) / c.fps });
  },

  select: (ids, additive = false) => {
    const cur = get().selectedLayers;
    set({ selectedLayers: additive ? Array.from(new Set([...cur, ...ids])) : ids, selectedMask: null });
  },
}));

/**
 * Push the project to the render engine. Syncs are strictly serialised: two overlapping
 * syncs could otherwise finish out of order and leave the engine holding an OLDER project
 * than the editor (the preview would then lag one edit behind the inspector/overlay).
 */
function scheduleSync(delay = 30) {
  if (!isTauri) {
    useEditor.setState({ syncedRevision: useEditor.getState().revision });
    syncWaiters.splice(0).forEach((r) => r());
    return;
  }
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => { void runSync(); }, delay);
}

async function runSync() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const { project, revision, syncedRevision } = useEditor.getState();
      const waiters = syncWaiters.splice(0);
      if (project && revision > syncedRevision) {
        try {
          await api.syncProject(project);
          if (useEditor.getState().syncedRevision < revision) useEditor.setState({ syncedRevision: revision });
        } catch (e) {
          useEditor.getState().toast('error', 'Engine rejected the edit', String(e));
          // Do not leave the preview waiting forever on a rejected edit.
          useEditor.setState({ syncedRevision: revision });
        }
      }
      waiters.forEach((r) => r());
      if (useEditor.getState().revision > useEditor.getState().syncedRevision && syncWaiters.length) syncAgain = true;
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------- selectors & helpers

export function activeComp(): Composition | undefined {
  const s = useEditor.getState();
  return s.project?.compositions.find((c) => c.id === s.compId);
}

export function useComp(): Composition | undefined {
  return useEditor((s) => s.project?.compositions.find((c) => c.id === s.compId));
}

export function useSelectedLayers(): Layer[] {
  const comp = useComp();
  const sel = useEditor((s) => s.selectedLayers);
  return comp ? comp.layers.filter((l) => sel.includes(l.id)) : [];
}

export function draftComp(d: Draft<Project>, compId?: string): Draft<Composition> | undefined {
  const id = compId ?? useEditor.getState().compId;
  return d.compositions.find((c) => c.id === id);
}

export function draftLayer(d: Draft<Project>, layerId: string, compId?: string): Draft<Layer> | undefined {
  return draftComp(d, compId)?.layers.find((l) => l.id === layerId);
}

/** Get/set a nested value by dotted path, e.g. "transform.position" or "effects.<id>.params.radius". */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const byId = (cur as { id?: string }[]).find((x) => x && x.id === part);
      cur = byId ?? cur[Number(part)];
    } else cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function layerLocalTime(layer: Layer, compTime: number) {
  return compTime - layer.start;
}

export function newLocalId() {
  return Math.random().toString(36).slice(2, 14);
}

/** Deep-clone a layer giving it (and its effects/masks/animators) fresh ids. */
export function cloneLayer(l: Layer): Layer {
  const c: Layer = JSON.parse(JSON.stringify(l));
  c.id = newLocalId();
  c.effects.forEach((e) => (e.id = newLocalId()));
  c.masks.forEach((m) => (m.id = newLocalId()));
  return c;
}

/** Stable empty array for store selectors (a fresh `[]` per call re-renders forever). */
export const NONE: never[] = Object.freeze([]) as unknown as never[];
