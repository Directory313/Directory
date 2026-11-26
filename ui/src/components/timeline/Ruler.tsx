import { memo, useEffect, useRef, useState } from 'react';
import type { Composition } from '../../types/project';
import { useEditor, draftComp } from '../../store/editor';
import { api, on, isTauri } from '../../lib/api';
import { formatTime } from '../../lib/anim';
import { contextMenu } from '../ui/primitives';
import { niceStep } from './model';
import { RULER_H, useTL } from './tlstore';

const S = () => useEditor.getState();

/** Cached-frame strip (fetched from the engine, merged with live prerender progress). */
function useCachedFrames(comp: Composition) {
  const revision = useEditor((s) => s.revision);
  const scale = useEditor((s) => s.previewScale);
  const [frames, setFrames] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!isTauri) return;
    const h = window.setTimeout(() => {
      useEditor.getState().ensureSynced().then(() => api.cachedFrames(comp.id, scale)).then((f) => setFrames(new Set(f))).catch(() => {});
    }, 250);
    return () => window.clearTimeout(h);
  }, [comp.id, revision, scale]);
  useEffect(() => {
    let un: (() => void) | undefined;
    on<{ compId: string; frames: number[] }>('cache-progress', (p) => {
      if (p.compId !== comp.id) return;
      setFrames((old) => { const n = new Set(old); p.frames.forEach((f) => n.add(f)); return n; });
    }).then((u) => (un = u));
    return () => un?.();
  }, [comp.id]);
  return frames;
}

export const Ruler = memo(function Ruler({ comp }: { comp: Composition }) {
  const pps = useTL((s) => s.pps);
  const scrollX = useTL((s) => s.scrollX);
  const viewW = useTL((s) => s.viewW);
  const display = useEditor((s) => s.settings?.timeDisplay ?? 'timecode');
  const canvas = useRef<HTMLCanvasElement>(null);
  const cached = useCachedFrames(comp);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(viewW * dpr);
    c.height = Math.round(RULER_H * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, viewW, RULER_H);
    const { major, minor } = niceStep(pps, comp.fps);
    const t0 = scrollX / pps, t1 = (scrollX + viewW) / pps;
    g.strokeStyle = '#3a3a3a';
    g.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * pps - scrollX) + 0.5;
      g.moveTo(x, RULER_H - 6); g.lineTo(x, RULER_H);
    }
    g.stroke();
    g.strokeStyle = '#5a5a5a';
    g.fillStyle = '#8a8a8a';
    g.font = '10px "Cascadia Mono", Consolas, monospace';
    g.beginPath();
    for (let t = Math.floor(t0 / major) * major; t <= t1; t += major) {
      const x = Math.round(t * pps - scrollX) + 0.5;
      g.moveTo(x, RULER_H - 13); g.lineTo(x, RULER_H);
      const label = major < 1 && display === 'timecode' ? formatTime(t, comp.fps, 'timecode').slice(3) : formatTime(t, comp.fps, display === 'timecode' ? 'timecode' : display).replace(/^00:/, '');
      g.fillText(label, x + 3, 13);
    }
    g.stroke();
    // Cached frames strip.
    if (cached.size) {
      g.fillStyle = 'rgba(143, 191, 154, 0.85)';
      const fw = pps / comp.fps;
      let run: number | null = null;
      const f0 = Math.max(0, Math.floor(t0 * comp.fps)), f1 = Math.ceil(t1 * comp.fps) + 1;
      for (let f = f0; f <= f1; f++) {
        const has = cached.has(f);
        if (has && run == null) run = f;
        if ((!has || f === f1) && run != null) {
          g.fillRect(run * fw - scrollX, RULER_H - 3, (f - run) * fw, 3);
          run = null;
        }
      }
    }
    // Composition end shading.
    const endX = comp.duration * pps - scrollX;
    if (endX < viewW) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(Math.max(0, endX), 0, viewW - endX, RULER_H); }
  }, [pps, scrollX, viewW, comp.fps, comp.duration, display, cached]);

  const toT = (clientX: number, el: HTMLElement) => (clientX - el.getBoundingClientRect().left + scrollX) / pps;

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    S().set({ playing: false });
    S().setTime(toT(e.clientX, el));
    const move = (ev: PointerEvent) => S().setTime(toT(ev.clientX, el));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const wa = comp.workArea ?? [0, comp.duration];
  const dragWA = (e: React.PointerEvent, which: 'a' | 'b' | 'both') => {
    e.stopPropagation();
    const x0 = e.clientX;
    const orig = [...wa] as [number, number];
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = Math.round(((ev.clientX - x0) / pps) * comp.fps) / comp.fps;
      S().edit('Work Area', (d) => {
        const c = draftComp(d);
        if (!c) return;
        let [a, b] = orig;
        if (which === 'a' || which === 'both') a = Math.max(0, Math.min(orig[0] + dt, which === 'both' ? c.duration - (orig[1] - orig[0]) : b - 1 / c.fps));
        if (which === 'b') b = Math.min(c.duration, Math.max(orig[1] + dt, a + 1 / c.fps));
        if (which === 'both') b = a + (orig[1] - orig[0]);
        c.workArea = [a, b];
      }, `wa-${comp.id}`);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const dragMarker = (e: React.PointerEvent, id: string, t: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      if (!moved) return;
      const nt = Math.max(0, Math.min(comp.duration, Math.round((t + (ev.clientX - x0) / pps) * comp.fps) / comp.fps));
      S().edit('Move Marker', (d) => { const m = draftComp(d)?.markers.find((x) => x.id === id); if (m) m.t = nt; }, `mk-${id}`);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (!moved) S().setTime(t); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const markerMenu = (e: React.MouseEvent, id: string) => contextMenu(e, [
    { label: 'Rename…', action: () => { const m = comp.markers.find((x) => x.id === id); const v = window.prompt('Marker label', m?.label ?? ''); if (v != null) S().edit('Rename Marker', (d) => { const mm = draftComp(d)?.markers.find((x) => x.id === id); if (mm) mm.label = v; }); } },
    { label: 'Colour', submenu: ['#F28D96', '#E7B46A', '#8FBF9A', '#7FB2E5', '#B29BE0'].map((c) => ({ label: c, icon: <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />, action: () => S().edit('Marker Colour', (d) => { const mm = draftComp(d)?.markers.find((x) => x.id === id); if (mm) mm.color = c; }) })) },
    { separator: true },
    { label: 'Delete Marker', action: () => S().edit('Delete Marker', (d) => { const c = draftComp(d); if (c) c.markers = c.markers.filter((x) => x.id !== id); }) },
  ]);

  return (
    <div className="tl-ruler" style={{ height: RULER_H }} onPointerDown={scrub}>
      <canvas ref={canvas} style={{ width: viewW, height: RULER_H }} />
      <div className="tl-wa" style={{ left: wa[0] * pps - scrollX, width: (wa[1] - wa[0]) * pps }} onPointerDown={(e) => dragWA(e, 'both')} title="Work area — drag to move, edges to resize (I / O)">
        <span className="tl-wa-h l" onPointerDown={(e) => dragWA(e, 'a')} />
        <span className="tl-wa-h r" onPointerDown={(e) => dragWA(e, 'b')} />
      </div>
      {comp.markers.map((m) => (
        <div key={m.id} className="tl-marker" style={{ left: m.t * pps - scrollX, ['--mc' as string]: m.color ?? 'var(--accent-2)' }}
          title={m.label || 'Marker'} onPointerDown={(e) => dragMarker(e, m.id, m.t)} onContextMenu={(e) => markerMenu(e, m.id)}>
          {m.label && <span className="tl-marker-label">{m.label}</span>}
        </div>
      ))}
    </div>
  );
});
