// Right-click anywhere in the editor: a general menu with the tools that are not on screen.
// Elements with their own menu (clips, media, markers, keyframes…) handle right-click first and
// stop it, so this only opens on empty space. Text fields keep the system menu (copy/paste).
import { useEffect } from 'react';
import { allActions, runAction, shortcutFor } from '../../lib/actions';
import { contextMenu, type MenuItem } from '../ui/primitives';
import { useEditor } from '../../store/editor';
import { api, isTauri } from '../../lib/api';
import { PANEL_NAMES, WORKSPACE_NAMES, type PanelId } from './workspaces';
import { setWorkspace } from './EditorShell';

const S = () => useEditor.getState();

const item = (id: string, label: string): MenuItem => {
  const a = allActions().find((x) => x.id === id);
  return { label, shortcut: shortcutFor(id), action: () => runAction(id), disabled: !a || (!!a.enabled && !a.enabled()) };
};

const SHAPES = ['rect', 'roundedRect', 'ellipse', 'polygon', 'star', 'triangle', 'line', 'arrow'];
const SHAPE_LABEL: Record<string, string> = { rect: 'Rectangle', roundedRect: 'Rounded Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', triangle: 'Triangle', line: 'Line', arrow: 'Arrow' };

function addMenu(): MenuItem {
  return {
    label: 'Add Layer', submenu: [
      item('layer.newText', 'Text'), item('layer.newSolid', 'Solid'), item('layer.newNull', 'Null Object'), item('layer.newAdjustment', 'Adjustment Layer'),
      { label: 'Shape', submenu: SHAPES.map((v) => item(`layer.shape.${v}`, SHAPE_LABEL[v])) },
      item('layer.newParticles', 'Particle System'),
      { separator: true },
      item('layer.newCamera', 'Camera'),
      { label: 'Light', submenu: [item('layer.newLightPoint', 'Point'), item('layer.newLightSpot', 'Spot'), item('layer.newLightDir', 'Directional'), item('layer.newLightAmbient', 'Ambient')] },
    ],
  };
}

function generalItems(area: string | null): MenuItem[] {
  const s = S();
  const hasProject = !!s.project;
  const sel = s.selectedLayers.length;
  const auto = !!s.settings?.backgroundRender;
  const items: MenuItem[] = [];
  if (hasProject) {
    items.push(addMenu(), item('file.import', 'Import Media…'), { separator: true });
    items.push(item('edit.paste', 'Paste'), item('edit.selectAll', 'Select All'), item('edit.undo', 'Undo'), item('edit.redo', 'Redo'), { separator: true });
  }
  if (area === 'viewer' && hasProject) {
    const v = s.viewer;
    if (sel) items.push({ label: 'Align', submenu: [item('align.left', 'Left'), item('align.hcenter', 'Horizontal Centre'), item('align.right', 'Right'), item('align.top', 'Top'), item('align.vcenter', 'Vertical Centre'), item('align.bottom', 'Bottom'), item('align.center', 'Centre in Frame')] });
    items.push(
      { label: 'Snapping', checked: v.snap, action: () => s.set({ viewer: { ...v, snap: !v.snap } }) },
      { label: 'Grid', checked: v.grid, action: () => s.set({ viewer: { ...v, grid: !v.grid } }) },
      { label: 'Safe Areas', checked: v.safe, action: () => s.set({ viewer: { ...v, safe: !v.safe } }) },
      { label: 'Rulers', checked: v.rulers, action: () => s.set({ viewer: { ...v, rulers: !v.rulers } }) },
      item('viewer.fit', 'Zoom to Fit'),
      { separator: true },
    );
  }
  if (area === 'timeline' && hasProject) {
    items.push(item('timeline.split', 'Split at Playhead'), item('timeline.marker', 'Add Marker'), item('timeline.workIn', 'Set Work Area Start'), item('timeline.workOut', 'Set Work Area End'), item('timeline.fit', 'Fit Timeline'), { separator: true });
  }
  if (hasProject) {
    items.push(
      item('playback.renderPreview', 'Render Preview'),
      { label: 'Auto Render', checked: auto, disabled: !isTauri || !s.settings, action: () => { if (!s.settings) return; const next = { ...s.settings, backgroundRender: !auto }; s.set({ settings: next }); void api.setSettings(next); } },
      { separator: true },
      item('file.export', 'Export…'), item('file.renderQueue', 'Render Queue'),
      { separator: true },
    );
  }
  items.push(
    { label: 'Workspace', submenu: [...WORKSPACE_NAMES, ...Object.keys(s.settings?.workspaces ?? {}).filter((n) => !WORKSPACE_NAMES.includes(n))].map((n): MenuItem => ({ label: n, checked: n === s.workspace, action: () => setWorkspace(n) })).concat([{ separator: true }, item('workspace.saveAs', 'Save Workspace As…'), item('workspace.reset', 'Reset Workspace')]) },
    { label: 'Show Panel', submenu: (Object.keys(PANEL_NAMES) as PanelId[]).map((p) => item(`panel.${p}`, PANEL_NAMES[p])) },
    item('app.palette', 'Command Palette…'), item('app.settings', 'Settings…'),
  );
  return items;
}

/** Installs the general right-click menu for the editor. */
export function useGeneralContextMenu() {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      // Elements with their own menu stop the event, so it never reaches the window.
      // (main.tsx already prevents the WebView's built-in menu, so defaultPrevented is not a signal.)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (t?.closest('.popover, .modal')) { e.preventDefault(); return; }
      const area = t?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
      contextMenu(e, generalItems(area));
    };
    window.addEventListener('contextmenu', h);
    return () => window.removeEventListener('contextmenu', h);
  }, []);
}
