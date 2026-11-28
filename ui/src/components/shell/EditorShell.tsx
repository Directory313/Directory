import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Actions, DockLocation, Layout, Model, type TabNode } from 'flexlayout-react';
import { useEditor } from '../../store/editor';
import { api } from '../../lib/api';
import { registerActions } from '../../lib/actions';
import { TopBar } from './TopBar';
import { PANEL_NAMES, WORKSPACES, WORKSPACE_NAMES, type PanelId } from './workspaces';
import { Timeline } from '../timeline/Timeline';
import { GraphEditor } from '../graph/GraphEditor';
import { Viewer } from '../viewer/Viewer';
import { Inspector } from '../inspector/Inspector';
import { MediaPanel } from '../panels/MediaPanel';
import { LibraryPanel } from '../panels/LibraryPanel';
import { ScopesPanel } from '../panels/ScopesPanel';
import { AudioMixer } from '../panels/AudioMixer';
import { RenderQueuePanel } from '../panels/RenderQueue';
import { HierarchyPanel } from '../panels/Hierarchy';
import { Dialogs } from '../dialogs/Dialogs';
import { useGeneralContextMenu } from './generalMenu';

// Layouts are stored PER PROJECT (layout.json in the project folder), never globally, so
// closing a panel in one project does not affect any other project. New and unsaved
// projects start from the default workspace.
interface ProjectLayouts { workspace: string; layouts: Record<string, unknown> }
const DEFAULT_WS = 'Editing';
let projLayouts: ProjectLayouts = { workspace: DEFAULT_WS, layouts: {} };
let writeTimer: number | undefined;

/** Layouts the user saved with Window → Save Workspace As… (kept in settings, so every project has them). */
function customWorkspaces(): Record<string, unknown> {
  return (useEditor.getState().settings?.workspaces ?? {}) as Record<string, unknown>;
}
export function isWorkspace(name: string) {
  return name in WORKSPACES || name in customWorkspaces();
}
/** Built-in workspace names followed by the user's own. */
export function useWorkspaceNames(): string[] {
  const custom = useEditor((s) => s.settings?.workspaces);
  return useMemo(() => [...WORKSPACE_NAMES, ...Object.keys(custom ?? {}).filter((n) => !(n in WORKSPACES)).sort()], [custom]);
}

function presetModel(name: string): Model {
  const custom = customWorkspaces()[name];
  if (!(name in WORKSPACES) && custom) try { return Model.fromJson(custom as never); } catch { /* fall back */ }
  return Model.fromJson((WORKSPACES[name] ?? WORKSPACES[DEFAULT_WS])());
}

/** Save the current panel arrangement as a named workspace available in every project. */
export function saveWorkspaceAs(name: string) {
  const s = useEditor.getState();
  if (!currentModel || !s.settings || !name.trim()) return;
  if (name in WORKSPACES) { s.toast('warning', `"${name}" is a built-in workspace; choose another name`); return; }
  const next = { ...s.settings, workspaces: { ...s.settings.workspaces, [name]: currentModel.toJson() } };
  s.set({ settings: next });
  void api.setSettings(next).catch(() => {});
  switchWorkspace?.(name, true);
  s.toast('success', `Saved workspace "${name}"`, 'Find it in Window → Workspaces and the workspace menu at the top.');
}

export function deleteWorkspace(name: string) {
  const s = useEditor.getState();
  if (!s.settings || !(name in customWorkspaces())) return;
  const rest = { ...s.settings.workspaces };
  delete rest[name];
  const next = { ...s.settings, workspaces: rest };
  s.set({ settings: next });
  void api.setSettings(next).catch(() => {});
  if (projLayouts.workspace === name) switchWorkspace?.(DEFAULT_WS);
}
function loadModel(name: string): Model {
  const saved = projLayouts.layouts[name];
  if (saved) try { return Model.fromJson(saved as never); } catch { /* fall back to the preset */ }
  return presetModel(name);
}
function persistLayouts(immediate = false) {
  const path = useEditor.getState().projectPath;
  if (!path) return;
  window.clearTimeout(writeTimer);
  const run = () => { api.writeProjectLayout(path, JSON.stringify(projLayouts)).catch(() => {}); };
  if (immediate) run(); else writeTimer = window.setTimeout(run, 400);
}

// One-time cleanup of the old global (cross-project) layout storage.
try { Object.keys(localStorage).filter((k) => k.startsWith('veyra.layout.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }

let currentModel: Model | null = null;
let switchWorkspace: ((name: string, reset?: boolean) => void) | null = null;

/** Show a panel: select it if open, otherwise add it next to the active tabset. */
export function showPanel(id: PanelId) {
  const m = currentModel;
  if (!m) return;
  const node = m.getNodeById(`tab-${id}`);
  if (node) { m.doAction(Actions.selectTab(node.getId())); return; }
  const target = m.getActiveTabset() ?? m.getFirstTabSet();
  m.doAction(Actions.addNode({ type: 'tab', name: PANEL_NAMES[id], component: id, id: `tab-${id}` }, target.getId(), DockLocation.CENTER, -1, true));
}

/** Whether a panel is currently open in the layout. */
export function isPanelOpen(id: PanelId) {
  return !!currentModel?.getNodeById(`tab-${id}`);
}

/** Close a panel if it is open, otherwise open it. */
export function togglePanel(id: PanelId) {
  const n = currentModel?.getNodeById(`tab-${id}`);
  if (n) currentModel!.doAction(Actions.deleteTab(n.getId())); else showPanel(id);
}

export function setWorkspace(name: string, reset = false) {
  switchWorkspace?.(name, reset);
}

registerActions([
  ...WORKSPACE_NAMES.map((n, i) => ({ id: `workspace.${n}`, label: `Workspace: ${n}`, group: 'Window', shortcut: i < 8 ? `Alt+${i + 1}` : undefined, run: () => setWorkspace(n) })),
  { id: 'workspace.reset', label: 'Reset Current Workspace', group: 'Window', run: () => setWorkspace(projLayouts.workspace, true) },
  { id: 'workspace.saveAs', label: 'Save Workspace As…', group: 'Window', run: () => useEditor.setState({ dialog: 'saveWorkspace' }) },
  ...(Object.keys(PANEL_NAMES) as PanelId[]).map((p) => ({ id: `panel.${p}`, label: `Show ${PANEL_NAMES[p]}`, group: 'Window', run: () => showPanel(p) })),
  { id: 'panel.maximize', label: 'Maximize Active Panel', group: 'Window', shortcut: '`', run: () => { const ts = currentModel?.getActiveTabset(); if (ts) currentModel!.doAction(Actions.maximizeToggle(ts.getId())); } },
]);

function Drop({ id, children }: { id: string; children: ReactNode }) {
  return <div data-drop={id} className="drop-zone">{children}</div>;
}

export function EditorShell() {
  const projectId = useEditor((s) => s.project?.id);
  const projectPath = useEditor((s) => s.projectPath);
  useGeneralContextMenu();
  const [wsName, setWsName] = useState(DEFAULT_WS);
  useEffect(() => { useEditor.setState({ workspace: wsName }); }, [wsName]);
  const [model, setModel] = useState(() => presetModel(DEFAULT_WS));
  currentModel = model;

  // Load this project's own layout (or the default for a new project).
  useEffect(() => {
    let cancelled = false;
    const path = useEditor.getState().projectPath;
    projLayouts = { workspace: DEFAULT_WS, layouts: {} };
    setWsName(DEFAULT_WS);
    setModel(presetModel(DEFAULT_WS));
    if (path) {
      api.readProjectLayout(path).then((json) => {
        if (cancelled || !json) return;
        try {
          const saved = JSON.parse(json) as ProjectLayouts;
          projLayouts = { workspace: isWorkspace(saved.workspace) ? saved.workspace : DEFAULT_WS, layouts: saved.layouts ?? {} };
          setWsName(projLayouts.workspace);
          setModel(loadModel(projLayouts.workspace));
        } catch { /* corrupt layout file: keep the default */ }
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [projectId]);

  // First save of a new project: write its layout into the new project folder.
  useEffect(() => { if (projectPath) persistLayouts(true); }, [projectPath]);

  useEffect(() => {
    switchWorkspace = (name, reset) => {
      if (reset) delete projLayouts.layouts[name];
      projLayouts.workspace = name;
      setWsName(name);
      setModel(loadModel(name));
      persistLayouts();
    };
    return () => { switchWorkspace = null; };
  }, []);

  const factory = useCallback((node: TabNode) => {
    switch (node.getComponent() as PanelId) {
      case 'viewer': return <Drop id="viewer"><Viewer /></Drop>;
      case 'timeline': return <Drop id="timeline"><Timeline /></Drop>;
      case 'media': return <Drop id="media"><MediaPanel /></Drop>;
      case 'library': return <LibraryPanel />;
      case 'inspector': return <Inspector />;
      case 'graph': return <GraphEditor />;
      case 'scopes': return <ScopesPanel />;
      case 'mixer': return <AudioMixer />;
      case 'queue': return <RenderQueuePanel />;
      case 'hierarchy': return <HierarchyPanel />;
      default: return <div className="empty">Unknown panel</div>;
    }
  }, []);

  const [, bump] = useState(0);
  const onModelChange = useCallback((m: Model) => {
    projLayouts.layouts[wsName] = m.toJson();
    persistLayouts();
    bump((x) => x + 1);
  }, [wsName]);

  const layout = useMemo(() => <Layout model={model} factory={factory} onModelChange={onModelChange} realtimeResize />, [model, factory, onModelChange]);

  return (
    <div className="editor-shell">
      <TopBar workspace={wsName} />
      <div className="workspace">{layout}</div>
      <Dialogs />
    </div>
  );
}
