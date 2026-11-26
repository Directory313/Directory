import { memo } from 'react';
import type { Draft } from 'immer';
import {
  Box, Camera, ChevronDown, ChevronRight, Crosshair, Eye, EyeOff, Film, Ghost, Headphones, Layers, LayoutGrid, Lightbulb,
  Link2, Lock, Music, Shapes, SlidersHorizontal, Sparkles, Square, Type, Unlock, Volume2, VolumeX, Wind, Blend, Diamond,
} from 'lucide-react';
import type { BlendMode, Composition, Layer, MatteMode } from '../../types/project';
import { BLEND_MODES, LABEL_COLORS } from '../../types/project';
import { draftComp, useEditor, getPath } from '../../store/editor';
import { setParent, toggleKey } from '../../lib/ops';
import { contextMenu, type MenuItem } from '../ui/primitives';
import { useTL } from './tlstore';
import type { AnimProp } from './model';
import { graphId } from './model';
import { selectAllOnRow } from './keyops';
import { propAt } from '../../lib/anim';
import type { Prop } from '../../types/project';

const S = () => useEditor.getState();

export function typeIcon(l: Layer, size = 13) {
  switch (l.kind.type) {
    case 'media': return <Film size={size} />;
    case 'audio': return <Music size={size} />;
    case 'text': return <Type size={size} />;
    case 'shape': return <Shapes size={size} />;
    case 'solid': return <Square size={size} />;
    case 'null': return <Crosshair size={size} />;
    case 'adjustment': return <SlidersHorizontal size={size} />;
    case 'comp': return <Layers size={size} />;
    case 'camera': return <Camera size={size} />;
    case 'light': return <Lightbulb size={size} />;
    case 'mesh': return <Box size={size} />;
    case 'particles': return <Sparkles size={size} />;
    case 'generator': return <LayoutGrid size={size} />;
  }
}

export function hasAudio(l: Layer, comp: Composition | undefined, assets: { id: string; info: { hasAudio: boolean } }[]) {
  void comp;
  if (l.kind.type === 'audio') return true;
  if (l.kind.type === 'media') return !!assets.find((a) => a.id === (l.kind as { asset: string }).asset)?.info.hasAudio;
  return l.kind.type === 'comp';
}

function setLayer(id: string, label: string, fn: (l: Draft<Layer>) => void) {
  S().edit(label, (d) => { const l = draftComp(d)?.layers.find((x) => x.id === id); if (l) fn(l); });
}

const MATTE_LABEL: Record<MatteMode, string> = { alpha: 'Alpha Matte', alphaInverted: 'Alpha Inverted', luma: 'Luma Matte', lumaInverted: 'Luma Inverted' };
const blendLabel = (b: BlendMode) => b.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export const LayerHeader = memo(function LayerHeader({ layer, comp, index, selected, expanded, height, audio, onPointerDown }: {
  layer: Layer; comp: Composition; index: number; selected: boolean; expanded: boolean; height: number; audio: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}) {
  const renaming = useTL((s) => s.renaming === layer.id);
  const parent = layer.parent ? comp.layers.find((l) => l.id === layer.parent) : undefined;
  const matte = layer.trackMatte ? comp.layers.find((l) => l.id === layer.trackMatte!.layer) : undefined;
  const sw = (on: boolean, onIcon: React.ReactNode, offIcon: React.ReactNode, title: string, act: () => void, cls = '') => (
    <button className={`tl-sw ${on ? 'on' : ''} ${cls}`} title={title} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); act(); }}>{on ? onIcon : offIcon}</button>
  );
  const parentMenu = (e: React.MouseEvent) => contextMenu(e, [
    { header: 'Parent' },
    { label: 'None', checked: !layer.parent, action: () => setParent([layer.id], null) },
    ...comp.layers.filter((l) => l.id !== layer.id).map((l, i) => ({ label: `${i + 1}. ${l.name}`, checked: layer.parent === l.id, icon: typeIcon(l, 12), action: () => setParent(S().selectedLayers.includes(layer.id) ? S().selectedLayers.filter((x) => x !== l.id) : [layer.id], l.id) }) as MenuItem),
  ]);
  const blendMenu = (e: React.MouseEvent) => contextMenu(e, [
    { header: 'Blend Mode' },
    ...BLEND_MODES.map((b) => ({ label: blendLabel(b), checked: layer.blend === b, action: () => setLayer(layer.id, 'Blend Mode', (l) => { l.blend = b; }) })),
  ]);
  const matteMenu = (e: React.MouseEvent) => contextMenu(e, [
    { header: 'Track Matte' },
    { label: 'None', checked: !layer.trackMatte, action: () => setLayer(layer.id, 'Track Matte', (l) => { l.trackMatte = null; }) },
    ...comp.layers.filter((l) => l.id !== layer.id).map((m) => ({
      label: m.name, checked: layer.trackMatte?.layer === m.id, icon: typeIcon(m, 12),
      submenu: (Object.keys(MATTE_LABEL) as MatteMode[]).map((mode) => ({ label: MATTE_LABEL[mode], checked: layer.trackMatte?.layer === m.id && layer.trackMatte.mode === mode, action: () => setLayer(layer.id, 'Track Matte', (l) => { l.trackMatte = { layer: m.id, mode }; }) })),
    }) as MenuItem),
  ]);
  const labelColor = layer.label ? LABEL_COLORS[layer.label] ?? layer.label : 'transparent';
  return (
    <div className={`tl-head ${selected ? 'sel' : ''} ${layer.locked ? 'locked' : ''}`} style={{ height }} data-layer={layer.id}
      onPointerDown={(e) => onPointerDown(e, layer.id)}>
      <button className="tl-sw" onPointerDown={(e) => e.stopPropagation()} onClick={() => useTL.getState().set({ expanded: { ...useTL.getState().expanded, [layer.id]: !expanded } })} title="Show properties (U)">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <span className="tl-label" style={{ background: labelColor }} />
      <span className="tl-idx mono">{index + 1}</span>
      <span className="tl-type">{typeIcon(layer)}</span>
      {renaming ? (
        <input className="input tl-rename" autoFocus defaultValue={layer.name} onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== layer.name) setLayer(layer.id, 'Rename', (l) => { l.name = v; }); useTL.getState().set({ renaming: null }); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') useTL.getState().set({ renaming: null }); }} />
      ) : (
        <span className="tl-name" onDoubleClick={() => useTL.getState().set({ renaming: layer.id })} title={layer.name}>{layer.name}</span>
      )}
      <span className="tl-switches">
        {sw(layer.visible, <Eye size={12} />, <EyeOff size={12} />, 'Visible', () => setLayer(layer.id, 'Visibility', (l) => { l.visible = !l.visible; }))}
        {sw(layer.solo, <Headphones size={12} />, <Headphones size={12} />, 'Solo', () => setLayer(layer.id, 'Solo', (l) => { l.solo = !l.solo; }))}
        {audio ? sw(!layer.muted, <Volume2 size={12} />, <VolumeX size={12} />, 'Audio (mute)', () => setLayer(layer.id, 'Mute', (l) => { l.muted = !l.muted; })) : <span className="tl-sw ph" />}
        {sw(layer.locked, <Lock size={12} />, <Unlock size={12} />, 'Lock', () => setLayer(layer.id, 'Lock', (l) => { l.locked = !l.locked; }))}
        {sw(layer.is3d, <Box size={12} />, <Box size={12} />, '3D layer', () => setLayer(layer.id, '3D Layer', (l) => { l.is3d = !l.is3d; }))}
        {sw(layer.motionBlur, <Wind size={12} />, <Wind size={12} />, 'Motion blur', () => setLayer(layer.id, 'Motion Blur', (l) => { l.motionBlur = !l.motionBlur; }))}
        {sw(layer.shy, <Ghost size={12} />, <Ghost size={12} />, 'Shy (hide when Shy filter is on)', () => setLayer(layer.id, 'Shy', (l) => { l.shy = !l.shy; }))}
      </span>
      <button className={`tl-chip ${layer.blend !== 'normal' ? 'on' : ''}`} title={`Blend: ${blendLabel(layer.blend)}`} onPointerDown={(e) => e.stopPropagation()} onClick={blendMenu}><Blend size={11} /></button>
      <button className={`tl-chip ${matte ? 'on' : ''}`} title={matte ? `Track matte: ${matte.name} (${MATTE_LABEL[layer.trackMatte!.mode]})` : 'Track matte'} onPointerDown={(e) => e.stopPropagation()} onClick={matteMenu}>TM</button>
      <button className={`tl-chip parent ${parent ? 'on' : ''}`} title={parent ? `Parent: ${parent.name}` : 'Parent (pick-whip)'} onPointerDown={(e) => e.stopPropagation()} onClick={parentMenu}>
        <Link2 size={11} /><span>{parent ? parent.name : 'None'}</span>
      </button>
    </div>
  );
});

export const PropHeader = memo(function PropHeader({ layer, ap, height }: { layer: Layer; ap: AnimProp; height: number }) {
  const inGraph = useEditor((s) => s.graphProps.includes(graphId(layer.id, ap.path)));
  const time = useEditor((s) => s.time);
  const lt = time - layer.start;
  const atKey = !!ap.prop.keys?.some((k) => Math.abs(k.t - lt) < 1e-3);
  const v = propAt(getPath(layer, ap.path) as Prop<unknown>, lt);
  const show = typeof v === 'number' ? v.toFixed(Math.abs(v) < 10 ? 2 : 1) : Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]).slice(0, 3).map((x) => x.toFixed(1)).join(', ') : '';
  const toggleGraph = () => {
    const id = graphId(layer.id, ap.path);
    const g = S().graphProps;
    S().set({ graphProps: g.includes(id) ? g.filter((x) => x !== id) : [...g, id] });
  };
  return (
    <div className={`tl-prop-head ${inGraph ? 'graph' : ''}`} style={{ height }} onDoubleClick={toggleGraph}
      onContextMenu={(e) => contextMenu(e, [
        { label: inGraph ? 'Remove from Graph Editor' : 'Show in Graph Editor', action: toggleGraph },
        { label: 'Select All Keyframes', action: () => selectAllOnRow(layer.id, ap.path) },
        { label: 'Remove All Keyframes', action: () => toggleKey(layer.id, ap.path, true) },
      ])}
      title="Double-click to show in the Graph Editor">
      <button className={`kf-btn ${atKey ? 'on' : ''}`} onClick={(e) => toggleKey(layer.id, ap.path, e.altKey)} title="Add/remove keyframe at playhead">
        <Diamond size={10} fill={atKey ? 'currentColor' : 'none'} />
      </button>
      <span className="tl-prop-name">{ap.label}{ap.prop.expr ? <span className="tl-expr" title={ap.prop.expr}> = expr</span> : null}</span>
      <span className="tl-prop-val mono">{show}</span>
    </div>
  );
});
