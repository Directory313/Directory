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

const LAYOUT_KEY = 'veyra.layout.v2.';

function loadModel(name: string): Model {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY + name);
    if (saved) return Model.fromJson(JSON.parse(saved));
  } catch { /* fall back to the preset */ }
  return Model.fromJson((WORKSPACES[name] ?? WORKSPACES.Editing)());
}

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

export function setWorkspace(name: string, reset = false) {
  switchWorkspace?.(name, reset);
}

registerActions([
  ...WORKSPACE_NAMES.map((n, i) => ({ id: `workspace.${n}`, label: `Workspace: ${n}`, group: 'Window', shortcut: i < 8 ? `Alt+${i + 1}` : undefined, run: () => setWorkspace(n) })),
  { id: 'workspace.reset', label: 'Reset Current Workspace', group: 'Window', run: () => setWorkspace(useEditor.getState().settings?.activeWorkspace ?? 'Editing', true) },
  ...(Object.keys(PANEL_NAMES) as PanelId[]).map((p) => ({ id: `panel.${p}`, label: `Show ${PANEL_NAMES[p]}`, group: 'Window', run: () => showPanel(p) })),
  { id: 'panel.maximize', label: 'Maximize Active Panel', group: 'Window', shortcut: '`', run: () => { const ts = currentModel?.getActiveTabset(); if (ts) currentModel!.doAction(Actions.maximizeToggle(ts.getId())); } },
]);

function Drop({ id, children }: { id: string; children: ReactNode }) {
  return <div data-drop={id} className="drop-zone">{children}</div>;
}

export function EditorShell() {
  const settings = useEditor((s) => s.settings);
  const [wsName, setWsName] = useState(() => settings?.activeWorkspace ?? 'Editing');
  const [model, setModel] = useState(() => loadModel(wsName));
  currentModel = model;

  useEffect(() => {
    switchWorkspace = (name, reset) => {
      if (reset) try { localStorage.removeItem(LAYOUT_KEY + name); } catch { /* ignore */ }
      setWsName(name);
      setModel(loadModel(name));
      const s = useEditor.getState().settings;
      if (s) { const next = { ...s, activeWorkspace: name }; useEditor.setState({ settings: next }); api.setSettings(next).catch(() => {}); }
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

  const onModelChange = useCallback((m: Model) => {
    try { localStorage.setItem(LAYOUT_KEY + wsName, JSON.stringify(m.toJson())); } catch { /* ignore */ }
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
