import { memo, useState } from 'react';
import type { Draft } from 'immer';
import type { Asset, Layer, Transition, TransitionKind } from '../../types/project';
import { LABEL_COLORS, TRANSITIONS } from '../../types/project';
import { draftComp, useEditor } from '../../store/editor';
import {
  copyLayers, deleteLayers, duplicateLayers, layerColor, moveLayers, openComp, pasteLayers, precompose, splitAtPlayhead, unpack,
} from '../../lib/ops';
import { contextMenu, NumberField, Popover, type MenuItem } from '../ui/primitives';
import { Filmstrip, Waveform } from './media';
import { useTL } from './tlstore';
import { isKeySelected, setInterp, copyKeys, pasteKeys, reverseKeys, selectAllOnRow, deleteSelectedKeys } from './keyops';
import { sourceTimeAt, type AnimProp } from './model';
import type { DragMode } from './clipdrag';

const S = () => useEditor.getState();

function setLayer(id: string, label: string, fn: (l: Draft<Layer>) => void) {
  S().edit(label, (d) => { const l = draftComp(d)?.layers.find((x) => x.id === id); if (l) fn(l); });
}

const TLABEL: Record<TransitionKind, string> = {
  crossDissolve: 'Cross Dissolve', dipToBlack: 'Dip to Black', dipToWhite: 'Dip to White', wipeLeft: 'Wipe Left', wipeRight: 'Wipe Right',
  wipeUp: 'Wipe Up', wipeDown: 'Wipe Down', slideLeft: 'Slide Left', slideRight: 'Slide Right', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', blur: 'Blur', spin: 'Spin',
};

function transitionMenu(layerId: string, side: 'transitionIn' | 'transitionOut', cur?: Transition | null): MenuItem[] {
  const dflt = S().settings?.defaultTransition ?? 0.5;
  return [
    { header: side === 'transitionIn' ? 'Transition In' : 'Transition Out' },
    ...TRANSITIONS.map((k) => ({ label: TLABEL[k], checked: cur?.kind === k, action: () => setLayer(layerId, 'Transition', (l) => { l[side] = { kind: k, duration: cur?.duration ?? Math.min(dflt, l.duration / 2), ease: cur?.ease ?? true }; }) })),
    { separator: true },
    ...(cur ? [
      { label: cur.ease ? 'Linear Timing' : 'Eased Timing', action: () => setLayer(layerId, 'Transition', (l) => { if (l[side]) l[side]!.ease = !cur.ease; }) },
      { label: 'Remove Transition', action: () => setLayer(layerId, 'Remove Transition', (l) => { l[side] = null; }) },
    ] : []),
  ];
}

export function clipMenu(e: React.MouseEvent, layer: Layer, openSpeed: (anchor: { x: number; y: number }) => void) {
  const s = S();
  if (!s.selectedLayers.includes(layer.id)) s.select([layer.id]);
  const isCompound = layer.kind.type === 'comp';
  const t = s.time;
  const inside = t > layer.start && t < layer.start + layer.duration;
  contextMenu(e, [
    { label: 'Split at Playhead', shortcut: 'S', disabled: !inside, action: () => splitAtPlayhead() },
    { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => duplicateLayers() },
    { label: 'Copy', shortcut: 'Ctrl+C', action: () => copyLayers() },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: !s.clipboard.layers?.length, action: () => pasteLayers() },
    { label: 'Rename', action: () => useTL.getState().set({ renaming: layer.id }) },
    { separator: true },
    { label: 'Create Compound Clip', shortcut: 'Ctrl+Shift+C', action: () => precompose() },
    ...(isCompound ? [
      { label: 'Open Composition', action: () => openComp((layer.kind as { comp: string }).comp) },
      { label: 'Unpack Compound Clip', action: () => unpack(layer.id) },
    ] : []),
    { separator: true },
    { label: 'Speed / Duration…', action: () => openSpeed({ x: e.clientX, y: e.clientY }) },
    { label: layer.reverse ? 'Play Forwards' : 'Reverse Playback', action: () => setLayer(layer.id, 'Reverse', (l) => { l.reverse = !l.reverse; }) },
    { label: layer.freezeAt != null ? 'Remove Freeze Frame' : 'Freeze Frame at Playhead', disabled: layer.freezeAt == null && !inside, action: () => setLayer(layer.id, 'Freeze Frame', (l) => { l.freezeAt = l.freezeAt != null ? null : sourceTimeAt(layer, t); }) },
    { label: 'Transition In', submenu: transitionMenu(layer.id, 'transitionIn', layer.transitionIn) },
    { label: 'Transition Out', submenu: transitionMenu(layer.id, 'transitionOut', layer.transitionOut) },
    { label: layer.is3d ? 'Convert to 2D' : 'Convert to 3D Layer', action: () => setLayer(layer.id, '3D Layer', (l) => { l.is3d = !l.is3d; }) },
    { label: 'Label Colour', submenu: [{ label: 'None', action: () => setLayer(layer.id, 'Label', (l) => { l.label = null; }) }, ...Object.entries(LABEL_COLORS).map(([k, c]) => ({ label: k[0].toUpperCase() + k.slice(1), icon: <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />, checked: layer.label === k, action: () => setLayer(layer.id, 'Label', (l) => { l.label = k; }) }))] },
    { label: 'Arrange', submenu: [
      { label: 'Bring to Front', action: () => moveLayers(S().selectedLayers, 'top') },
      { label: 'Bring Forward', action: () => moveLayers(S().selectedLayers, 'up') },
      { label: 'Send Backward', action: () => moveLayers(S().selectedLayers, 'down') },
      { label: 'Send to Back', action: () => moveLayers(S().selectedLayers, 'bottom') },
    ] },
    { separator: true },
    { label: 'Delete', shortcut: 'Del', action: () => deleteLayers() },
    { label: 'Ripple Delete', shortcut: 'Shift+Del', action: () => deleteLayers(undefined, true) },
  ]);
}

/** Speed popover: changing speed keeps the same source span by adjusting duration. */
export function SpeedPopover({ layer, anchor, onClose }: { layer: Layer; anchor: { x: number; y: number }; onClose: () => void }) {
  const [pct, setPct] = useState(layer.speed * 100);
  const apply = (v: number) => {
    const sp = Math.max(1, Math.min(10000, v)) / 100;
    setPct(sp * 100);
    S().edit('Speed', (d) => {
      const c = draftComp(d);
      const l = c?.layers.find((x) => x.id === layer.id);
      if (!l || !c) return;
      const span = layer.duration * layer.speed;
      l.speed = sp;
      l.duration = Math.max(1 / c.fps, Math.round((span / sp) * c.fps) / c.fps);
    }, `speed-${layer.id}`);
  };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="col" style={{ padding: 6, gap: 8, width: 200 }}>
        <div className="row"><span className="label grow">Speed</span><NumberField value={pct} onChange={apply} min={1} max={10000} step={1} precision={1} unit="%" /></div>
        <div className="row" style={{ gap: 4 }}>
          {[25, 50, 100, 200, 400].map((v) => <button key={v} className="btn sm" onClick={() => apply(v)}>{v}%</button>)}
        </div>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Duration changes to keep the same source footage. Use Time Remap in the inspector for variable speed.</span>
      </div>
    </Popover>
  );
}

export const ClipRow = memo(function ClipRow({ layer, asset, height, selected, pps, keyTimes, onClipDown, onTransitionDown }: {
  layer: Layer; asset: Asset | undefined; height: number; selected: boolean; pps: number; keyTimes: number[];
  onClipDown: (e: React.PointerEvent, id: string, mode: DragMode) => void;
  onTransitionDown: (e: React.PointerEvent, id: string, side: 'transitionIn' | 'transitionOut') => void;
}) {
  const [speedAt, setSpeedAt] = useState<{ x: number; y: number } | null>(null);
  const x = layer.start * pps;
  const w = Math.max(2, layer.duration * pps);
  const color = layer.label ? LABEL_COLORS[layer.label] ?? layer.label : null;
  const isVideo = asset && (asset.kind === 'video' || asset.kind === 'imageSequence') && layer.kind.type === 'media';
  const isStillMedia = asset && (asset.kind === 'image' || asset.kind === 'svg');
  const showWave = asset && asset.info.hasAudio && (layer.kind.type === 'audio' || layer.kind.type === 'media');
  const innerH = height - 4;
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rx = e.clientX - rect.left;
    let mode: DragMode = 'move';
    if (rx < 6) mode = 'trimL';
    else if (rx > rect.width - 6) mode = 'trimR';
    else if (e.altKey) mode = 'slip';
    else if (e.ctrlKey) mode = 'slide';
    onClipDown(e, layer.id, mode);
  };
  return (
    <>
      <div className={`tl-clip ${selected ? 'sel' : ''} ${layer.visible ? '' : 'hidden'} ${layer.locked ? 'locked' : ''}`}
        style={{ left: x, width: w, height: innerH, background: layerColor(layer), ['--lc' as string]: color ?? 'transparent' }}
        onPointerDown={down}
        onDoubleClick={() => { if (layer.kind.type === 'comp') openComp(layer.kind.comp); }}
        onContextMenu={(e) => clipMenu(e, layer, setSpeedAt)}
        title={`${layer.name}\nDrag: move · Edges: trim · Alt+drag: slip · Ctrl+drag: slide`}>
        {isVideo && height >= 30 && <Filmstrip layer={layer} asset={asset!} pps={pps} height={innerH} />}
        {isStillMedia && height >= 30 && <StillThumb asset={asset!} height={innerH} />}
        {showWave && <Waveform layer={layer} asset={asset!} pps={pps} width={w} height={isVideo && height >= 30 ? Math.max(10, innerH * 0.4) : innerH} />}
        <div className="tl-clip-label">
          <span className="tl-clip-name">{layer.name}</span>
          {layer.speed !== 1 && <span className="tl-badge">{Math.round(layer.speed * 100)}%</span>}
          {layer.reverse && <span className="tl-badge">REV</span>}
          {layer.freezeAt != null && <span className="tl-badge">FREEZE</span>}
          {layer.effects.length > 0 && <span className="tl-badge fx">fx</span>}
          {layer.masks.length > 0 && <span className="tl-badge">mask</span>}
        </div>
        {keyTimes.map((t, i) => <span key={i} className="tl-clip-key" style={{ left: (t - layer.start) * pps - 3 }} />)}
        {(['transitionIn', 'transitionOut'] as const).map((side) => {
          const tr = layer[side];
          if (!tr) return null;
          const tw = Math.min(w, tr.duration * pps);
          return (
            <div key={side} className={`tl-trans ${side === 'transitionIn' ? 'in' : 'out'}`} style={side === 'transitionIn' ? { left: 0, width: tw } : { right: 0, width: tw }}
              title={`${TLABEL[tr.kind]} — drag edge to change duration, right-click to change`}
              onContextMenu={(e) => { e.stopPropagation(); contextMenu(e, transitionMenu(layer.id, side, tr)); }}>
              <span className="tl-trans-h" onPointerDown={(e) => { e.stopPropagation(); onTransitionDown(e, layer.id, side); }} />
            </div>
          );
        })}
        <span className="tl-trim l" />
        <span className="tl-trim r" />
      </div>
      {speedAt && <SpeedPopover layer={layer} anchor={speedAt} onClose={() => setSpeedAt(null)} />}
    </>
  );
});

function StillThumb({ asset, height }: { asset: Asset; height: number }) {
  const src = useEditor((s) => s.thumbs[asset.id]);
  if (!src) return null;
  return <img className="tl-still" src={src} style={{ height }} alt="" draggable={false} />;
}

export const PropKeysRow = memo(function PropKeysRow({ layer, ap, height, pps, onKeyDown }: {
  layer: Layer; ap: AnimProp; height: number; pps: number;
  onKeyDown: (e: React.PointerEvent, layerId: string, path: string, t: number) => void;
}) {
  const sel = useEditor((s) => s.selectedKeys);
  const keys = ap.prop.keys ?? [];
  const menu = (e: React.MouseEvent, t: number) => {
    if (!isKeySelected(S().selectedKeys, layer.id, ap.path, t)) S().set({ selectedKeys: [{ layerId: layer.id, path: ap.path, t }] });
    contextMenu(e, [
      { header: 'Keyframe Interpolation' },
      { label: 'Linear', action: () => setInterp('linear') },
      { label: 'Bezier', action: () => setInterp('bezier') },
      { label: 'Hold', action: () => setInterp('hold') },
      { separator: true },
      { label: 'Easy Ease', shortcut: 'F9', action: () => setInterp('easy') },
      { label: 'Easy Ease In', shortcut: 'Shift+F9', action: () => setInterp('easeIn') },
      { label: 'Easy Ease Out', shortcut: 'Ctrl+Shift+F9', action: () => setInterp('easeOut') },
      { separator: true },
      { label: 'Copy Keyframes', action: () => copyKeys() },
      { label: 'Paste at Playhead', disabled: !S().clipboard.keys?.length, action: () => pasteKeys() },
      { label: 'Reverse Keyframes', action: () => reverseKeys() },
      { label: 'Select All on Row', action: () => selectAllOnRow(layer.id, ap.path) },
      { separator: true },
      { label: 'Delete', shortcut: 'Del', action: () => deleteSelectedKeys() },
    ]);
  };
  return (
    <div className="tl-prop-row" style={{ height }}>
      <div className="tl-prop-span" style={{ left: layer.start * pps, width: layer.duration * pps }} />
      {keys.map((k, i) => {
        const on = isKeySelected(sel, layer.id, ap.path, k.t);
        const cls = k.interp === 'hold' ? 'hold' : k.interp === 'bezier' ? 'bez' : 'lin';
        return (
          <span key={i} className={`tl-key ${cls} ${on ? 'sel' : ''}`} style={{ left: (layer.start + k.t) * pps }}
            data-key={`${layer.id}|${ap.path}|${k.t}`}
            title={`${k.interp ?? 'linear'} @ ${(layer.start + k.t).toFixed(3)}s`}
            onPointerDown={(e) => onKeyDown(e, layer.id, ap.path, k.t)}
            onDoubleClick={() => S().setTime(layer.start + k.t)}
            onContextMenu={(e) => menu(e, k.t)} />
        );
      })}
    </div>
  );
});
