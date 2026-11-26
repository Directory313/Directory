// Timeline keyboard actions (registered into the global command registry).
import type { Draft } from 'immer';
import type { Layer, Marker } from '../../types/project';
import { registerActions } from '../../lib/actions';
import { activeComp, draftComp, newLocalId, useEditor } from '../../store/editor';
import { deleteLayers, duplicateLayers, precompose, splitAtPlayhead } from '../../lib/ops';
import { deleteSelectedKeys, setInterp, copyKeys, pasteKeys } from './keyops';
import { shiftKeysDeep } from './model';
import { tlRefs, useTL } from './tlstore';

const S = () => useEditor.getState();
const hasComp = () => !!activeComp();

export function editPoints(): number[] {
  const c = activeComp();
  if (!c) return [];
  const pts = new Set<number>([0, c.duration]);
  for (const l of c.layers) { pts.add(l.start); pts.add(l.start + l.duration); }
  for (const m of c.markers) pts.add(m.t);
  return [...pts].sort((a, b) => a - b);
}

function step(frames: number) {
  const c = activeComp();
  if (!c) return;
  S().set({ playing: false });
  S().setTime(S().time + frames / c.fps);
}

/** Move (or trim, when `trim`) the selected clips' in/out point to the playhead. */
export function edgeToPlayhead(edge: 'in' | 'out', trim: boolean) {
  const s = S();
  const t = s.time;
  if (!s.selectedLayers.length) return;
  s.edit(trim ? 'Trim to Playhead' : 'Move to Playhead', (d) => {
    const c = draftComp(d);
    if (!c) return;
    for (const id of s.selectedLayers) {
      const l = c.layers.find((x) => x.id === id);
      if (!l || l.locked) continue;
      if (!trim) {
        l.start = edge === 'in' ? t : Math.max(0, t - l.duration);
      } else if (edge === 'in') {
        const dt = t - l.start;
        if (dt <= 0 || dt >= l.duration) continue;
        l.start = t;
        l.duration -= dt;
        if (!l.reverse) l.sourceIn += dt * l.speed;
        shiftKeysDeep(l as Layer, -dt);
      } else {
        const nd = t - l.start;
        if (nd > 0) l.duration = nd;
      }
    }
  });
}

export function addMarker(t = S().time) {
  const c = activeComp();
  if (!c) return;
  const m: Marker = { id: newLocalId(), t, label: '', color: null };
  S().edit('Add Marker', (d) => { draftComp(d)?.markers.push(m as Draft<Marker>); });
}

export function setWorkArea(edge: 'in' | 'out') {
  const c = activeComp();
  if (!c) return;
  const t = S().time;
  S().edit('Work Area', (d) => {
    const dc = draftComp(d);
    if (!dc) return;
    const wa: [number, number] = dc.workArea ? [dc.workArea[0], dc.workArea[1]] : [0, dc.duration];
    if (edge === 'in') wa[0] = Math.min(t, wa[1] - 1 / dc.fps);
    else wa[1] = Math.max(t, wa[0] + 1 / dc.fps);
    dc.workArea = wa;
  });
}

export function fitTimeline() {
  const c = activeComp();
  const el = tlRefs.scroller;
  if (!c || !el) return;
  useTL.getState().set({ pps: Math.max(2, (el.clientWidth - 40) / Math.max(c.duration, 0.1)) });
  el.scrollLeft = 0;
}

export function toggleExpandSelected() {
  const c = activeComp();
  if (!c) return;
  const ids = S().selectedLayers.length ? S().selectedLayers : c.layers.map((l) => l.id);
  const ex = { ...useTL.getState().expanded };
  const open = !ids.every((id) => ex[id]);
  for (const id of ids) ex[id] = open;
  useTL.getState().set({ expanded: ex });
}

registerActions([
  { id: 'timeline.split', label: 'Split at Playhead', group: 'Timeline', shortcut: 'S', run: () => splitAtPlayhead(), enabled: hasComp },
  { id: 'timeline.splitAlt', label: 'Split at Playhead (Ctrl+K)', group: 'Timeline', shortcut: 'Ctrl+K', run: () => splitAtPlayhead(), enabled: hasComp },
  { id: 'timeline.delete', label: 'Delete Selection', group: 'Timeline', shortcut: 'Delete', run: () => { if (!deleteSelectedKeys()) deleteLayers(); }, enabled: hasComp },
  { id: 'timeline.backspace', label: 'Delete Selection (Backspace)', group: 'Timeline', shortcut: 'Backspace', run: () => { if (!deleteSelectedKeys()) deleteLayers(); }, enabled: hasComp },
  { id: 'timeline.rippleDelete', label: 'Ripple Delete', group: 'Timeline', shortcut: 'Shift+Delete', run: () => deleteLayers(undefined, true), enabled: hasComp },
  { id: 'timeline.duplicate', label: 'Duplicate Layers', group: 'Timeline', shortcut: 'Ctrl+D', run: () => duplicateLayers(), enabled: hasComp },
  { id: 'timeline.inToPlayhead', label: 'Move In Point to Playhead', group: 'Timeline', shortcut: '[', run: () => edgeToPlayhead('in', false) },
  { id: 'timeline.outToPlayhead', label: 'Move Out Point to Playhead', group: 'Timeline', shortcut: ']', run: () => edgeToPlayhead('out', false) },
  { id: 'timeline.trimIn', label: 'Trim In Point to Playhead', group: 'Timeline', shortcut: 'Alt+[', run: () => edgeToPlayhead('in', true) },
  { id: 'timeline.trimOut', label: 'Trim Out Point to Playhead', group: 'Timeline', shortcut: 'Alt+]', run: () => edgeToPlayhead('out', true) },
  // Plain arrows nudge layers in the viewer, so timeline navigation uses Ctrl+arrows / PageUp/PageDown.
  { id: 'timeline.prevEdit', label: 'Previous Edit Point', group: 'Timeline', shortcut: 'Ctrl+ArrowUp', run: () => { const t = S().time; const p = editPoints().filter((x) => x < t - 1e-6).pop(); if (p != null) S().setTime(p); } },
  { id: 'timeline.nextEdit', label: 'Next Edit Point', group: 'Timeline', shortcut: 'Ctrl+ArrowDown', run: () => { const t = S().time; const p = editPoints().find((x) => x > t + 1e-6); if (p != null) S().setTime(p); } },
  { id: 'timeline.pgUp', label: 'Previous Frame (PageUp)', group: 'Timeline', shortcut: 'PageUp', run: () => step(-1) },
  { id: 'timeline.pgDn', label: 'Next Frame (PageDown)', group: 'Timeline', shortcut: 'PageDown', run: () => step(1) },
  { id: 'timeline.home', label: 'Go to Start', group: 'Timeline', shortcut: 'Home', run: () => S().setTime(activeComp()?.workArea?.[0] ?? 0) },
  { id: 'timeline.end', label: 'Go to End', group: 'Timeline', shortcut: 'End', run: () => { const c = activeComp(); if (c) S().setTime(c.workArea?.[1] ?? c.duration); } },
  // Plain Left/Right step frames only when nothing is selected (otherwise the viewer nudges).
  { id: 'timeline.stepBack', label: 'Previous Frame', group: 'Timeline', shortcut: 'ArrowLeft', run: () => step(-1), enabled: () => S().selectedLayers.length === 0 },
  { id: 'timeline.stepFwd', label: 'Next Frame', group: 'Timeline', shortcut: 'ArrowRight', run: () => step(1), enabled: () => S().selectedLayers.length === 0 },
  { id: 'timeline.stepBackCtrl', label: 'Previous Frame (Ctrl)', group: 'Timeline', shortcut: 'Ctrl+ArrowLeft', run: () => step(-1) },
  { id: 'timeline.stepFwdCtrl', label: 'Next Frame (Ctrl)', group: 'Timeline', shortcut: 'Ctrl+ArrowRight', run: () => step(1) },
  { id: 'timeline.stepBack10', label: 'Back 10 Frames', group: 'Timeline', shortcut: 'Ctrl+Shift+ArrowLeft', run: () => step(-10) },
  { id: 'timeline.stepFwd10', label: 'Forward 10 Frames', group: 'Timeline', shortcut: 'Ctrl+Shift+ArrowRight', run: () => step(10) },
  { id: 'timeline.shuttleBack', label: 'Shuttle: Back 1 Second', group: 'Timeline', shortcut: 'J', run: () => { const c = activeComp(); S().set({ playing: false }); if (c) S().setTime(S().time - 1); } },
  { id: 'timeline.shuttleStop', label: 'Shuttle: Stop', group: 'Timeline', shortcut: 'K', run: () => S().set({ playing: false }) },
  { id: 'timeline.shuttleFwd', label: 'Shuttle: Play', group: 'Timeline', shortcut: 'L', run: () => S().set({ playing: true }) },
  { id: 'timeline.workIn', label: 'Set Work Area Start', group: 'Timeline', shortcut: 'I', run: () => setWorkArea('in') },
  { id: 'timeline.workOut', label: 'Set Work Area End', group: 'Timeline', shortcut: 'O', run: () => setWorkArea('out') },
  { id: 'timeline.marker', label: 'Add Marker', group: 'Timeline', shortcut: 'M', run: () => addMarker() },
  { id: 'timeline.easyEase', label: 'Easy Ease Keyframes', group: 'Keyframes', shortcut: 'F9', run: () => setInterp('easy') },
  { id: 'timeline.easeIn', label: 'Easy Ease In', group: 'Keyframes', shortcut: 'Shift+F9', run: () => setInterp('easeIn') },
  { id: 'timeline.easeOut', label: 'Easy Ease Out', group: 'Keyframes', shortcut: 'Ctrl+Shift+F9', run: () => setInterp('easeOut') },
  { id: 'timeline.holdKeys', label: 'Hold Keyframes', group: 'Keyframes', shortcut: 'Ctrl+Alt+H', run: () => setInterp('hold') },
  { id: 'timeline.linearKeys', label: 'Linear Keyframes', group: 'Keyframes', run: () => setInterp('linear') },
  { id: 'timeline.copyKeys', label: 'Copy Keyframes', group: 'Keyframes', shortcut: 'Ctrl+Alt+C', run: () => copyKeys() },
  { id: 'timeline.pasteKeys', label: 'Paste Keyframes at Playhead', group: 'Keyframes', shortcut: 'Ctrl+Alt+V', run: () => { pasteKeys(); } },
  { id: 'timeline.precompose', label: 'Create Compound Clip', group: 'Timeline', shortcut: 'Ctrl+Shift+C', run: () => precompose(), enabled: () => S().selectedLayers.length > 0 },
  { id: 'timeline.reveal', label: 'Show Animated Properties', group: 'Timeline', shortcut: 'U', run: () => toggleExpandSelected() },
  { id: 'timeline.fit', label: 'Fit Timeline', group: 'Timeline', shortcut: 'Shift+Z', run: () => fitTimeline() },
  { id: 'timeline.zoomIn', label: 'Zoom Timeline In', group: 'Timeline', shortcut: '=', run: () => useTL.getState().set({ pps: Math.min(4000, useTL.getState().pps * 1.4) }) },
  { id: 'timeline.zoomOut', label: 'Zoom Timeline Out', group: 'Timeline', shortcut: '-', run: () => useTL.getState().set({ pps: Math.max(1, useTL.getState().pps / 1.4) }) },
  { id: 'timeline.ripple', label: 'Toggle Ripple Editing', group: 'Timeline', run: () => useTL.getState().set({ ripple: !useTL.getState().ripple }) },
  { id: 'timeline.snap', label: 'Toggle Snapping', group: 'Timeline', shortcut: 'N', run: () => S().set({ snapping: !S().snapping }) },
]);
