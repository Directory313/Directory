import { useRef, useState } from 'react';
import { Command, Cpu, Download, Layers, Redo2, Settings, Undo2 } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { runAction, shortcutFor } from '../../lib/actions';
import { Menu, Popover, type MenuItem } from '../ui/primitives';
import { WORKSPACE_NAMES } from './workspaces';
import { isPanelOpen, setWorkspace, togglePanel } from './EditorShell';
import { PANEL_NAMES, type PanelId } from './workspaces';
import { Logo } from './Logo';

const SAVE_LABEL: Record<string, string> = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes', autosaved: 'Autosaved', error: 'Save failed' };

function MenuButton({ label, items }: { label: string; items: () => MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className={`menubar-item ${open ? 'on' : ''}`} onClick={() => setOpen(!open)}>{label}</button>
      {open && ref.current && <Popover anchor={ref.current} onClose={() => setOpen(false)}><Menu items={items()} onClose={() => setOpen(false)} /></Popover>}
    </>
  );
}

const a = (id: string, label: string): MenuItem => ({ label, shortcut: shortcutFor(id), action: () => runAction(id) });

export function TopBar({ workspace }: { workspace: string }) {
  const project = useEditor((s) => s.project);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const scale = useEditor((s) => s.previewScale);
  const jobs = useEditor((s) => s.jobs);
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'paused');
  const [renaming, setRenaming] = useState(false);
  const pct = running[0]?.progress ? Math.round((running[0].progress.frame / Math.max(1, running[0].progress.total)) * 100) : 0;

  return (
    <header className="topbar">
      <div className="row" style={{ gap: 10 }}>
        <Logo size={20} />
        <nav className="menubar">
          <MenuButton label="File" items={() => [a('file.home', 'Home'), a('file.open', 'Open Project…'), a('file.save', 'Save'), a('file.saveAs', 'Save As…'), { separator: true }, a('file.import', 'Import Media…'), a('file.importSequence', 'Import Image Sequence…'), { separator: true }, a('file.export', 'Export…'), a('file.renderQueue', 'Render Queue'), { label: 'Export Interchange', submenu: [a('file.exportOtio', 'OpenTimelineIO (.otio)'), a('file.exportEdl', 'EDL (.edl)'), a('file.exportSrt', 'Subtitles (.srt)'), a('file.exportVtt', 'Subtitles (.vtt)')] }, { separator: true }, a('file.relink', 'Relink Missing Media…'), a('file.collect', 'Collect Files…')]} />
          <MenuButton label="Edit" items={() => [a('edit.undo', `Undo ${undoLabel ?? ''}`), a('edit.redo', 'Redo'), { separator: true }, a('edit.cut', 'Cut'), a('edit.copy', 'Copy'), a('edit.paste', 'Paste'), a('edit.duplicate', 'Duplicate'), a('edit.delete', 'Delete'), { separator: true }, a('edit.selectAll', 'Select All'), a('edit.deselect', 'Deselect All'), { separator: true }, a('app.settings', 'Settings…'), a('app.shortcuts', 'Keyboard Shortcuts'), a('app.checkUpdates', 'Check for Updates…')]} />
          <MenuButton label="Layer" items={() => [a('layer.newText', 'New Text'), a('layer.newSolid', 'New Solid'), a('layer.newNull', 'New Null Object'), a('layer.newAdjustment', 'New Adjustment Layer'), { label: 'New Shape', submenu: ['rect', 'roundedRect', 'ellipse', 'polygon', 'star', 'triangle', 'line', 'arrow'].map((v) => a(`layer.shape.${v}`, v)) }, a('layer.newParticles', 'New Particle System'), { label: 'New Generator', submenu: ['grid', 'noise', 'wave', 'gradient', 'checkerboard', 'animatedBackground'].map((v) => a(`layer.gen.${v}`, v)) }, { separator: true }, a('edit.split', 'Split at Playhead'), a('edit.precompose', 'Create Compound Clip'), a('layer.lock', 'Lock / Unlock'), a('layer.hide', 'Hide / Show'), { separator: true }, a('layer.front', 'Bring to Front'), a('layer.forward', 'Bring Forward'), a('layer.backward', 'Send Backward'), a('layer.back', 'Send to Back')]} />
          <MenuButton label="3D" items={() => [a('layer.newCamera', 'New Camera'), a('layer.newLightPoint', 'Point Light'), a('layer.newLightSpot', 'Spot Light'), a('layer.newLightDir', 'Directional Light'), a('layer.newLightAmbient', 'Ambient Light'), { separator: true }, ...['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'pyramid'].map((v) => a(`layer.mesh.${v}`, `New ${v}`))]} />
          <MenuButton label="Composition" items={() => [a('comp.new', 'New Composition'), a('comp.settings', 'Composition Settings…'), a('comp.nest', 'Nest Composition'), { separator: true }, a('app.clearCache', 'Clear Render Cache')]} />
          <MenuButton label="Window" items={() => [{ header: 'Workspaces' }, ...WORKSPACE_NAMES.map((n) => ({ label: n, checked: n === workspace, shortcut: shortcutFor(`workspace.${n}`), action: () => setWorkspace(n) })), a('workspace.reset', 'Reset Workspace'), { separator: true }, { header: 'Panels (click to show / hide)' }, ...(Object.keys(PANEL_NAMES) as PanelId[]).map((p) => ({ label: PANEL_NAMES[p], checked: isPanelOpen(p), action: () => togglePanel(p) }))]} />
        </nav>
      </div>

      <div className="topbar-center">
        {renaming ? (
          <input className="input project-name-input" autoFocus defaultValue={project?.name}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== project?.name) useEditor.getState().edit('Rename Project', (d) => { d.name = v; }); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); e.stopPropagation(); }} />
        ) : (
          <button className="project-name" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{project?.name ?? 'Untitled'}</button>
        )}
        <span className={`save-state ${saveState}`}>{SAVE_LABEL[saveState]}</span>
      </div>

      <div className="row" style={{ gap: 4 }}>
        <button className="icon-btn" disabled={!canUndo} onClick={() => runAction('edit.undo')} title={`Undo ${undoLabel ?? ''} (Ctrl+Z)`}><Undo2 size={15} /></button>
        <button className="icon-btn" disabled={!canRedo} onClick={() => runAction('edit.redo')} title="Redo (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
        <span className="vsep" />
        <label className="row topbar-select" title="Workspace">
          <Layers size={13} />
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>{WORKSPACE_NAMES.map((n) => <option key={n}>{n}</option>)}</select>
        </label>
        <label className="row topbar-select" title="Preview quality">
          <Cpu size={13} />
          <select value={scale} onChange={(e) => useEditor.setState({ previewScale: Number(e.target.value) })}>
            <option value={1}>Full</option><option value={0.5}>Half</option><option value={0.25}>Quarter</option><option value={0.125}>Eighth</option>
          </select>
        </label>
        {running.length > 0 && (
          <button className="render-status" onClick={() => runAction('file.renderQueue')} title="Render queue">
            <span className="render-dot" /> Rendering {pct}%{running.length > 1 ? ` · ${running.length - 1} queued` : ''}
          </button>
        )}
        <button className="icon-btn" onClick={() => runAction('app.palette')} title="Command palette (Ctrl+Shift+P)"><Command size={15} /></button>
        <button className="icon-btn" onClick={() => runAction('app.settings')} title="Settings (Ctrl+,)"><Settings size={15} /></button>
        <button className="btn primary" onClick={() => runAction('file.export')} title="Export (Ctrl+M)"><Download size={14} /> Export</button>
      </div>
    </header>
  );
}
