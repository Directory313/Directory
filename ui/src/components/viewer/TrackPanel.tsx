// Point tracker UI: run the backend tracker and turn results into keyframes.
import { useEffect, useState } from 'react';
import type { Draft } from 'immer';
import { Crosshair, X } from 'lucide-react';
import type { Composition, Keyframe, Layer, Vec3 } from '../../types/project';
import { api, on, type TrackResult } from '../../lib/api';
import { draftComp, useEditor } from '../../store/editor';
import { propAt, HANDLE_IN_LINEAR, HANDLE_OUT_LINEAR } from '../../lib/anim';
import { NumberField } from '../ui/primitives';
import { apply, worldMatrix } from './geom';
import type { TrackPoint } from './Overlay';

const S = () => useEditor.getState();
const key = <T,>(t: number, v: T): Keyframe<T> => ({ t, v, interp: 'linear', outH: HANDLE_OUT_LINEAR, inH: HANDLE_IN_LINEAR });

export function TrackPanel({ comp, points, setPoints, onClose }: { comp: Composition; points: TrackPoint[]; setPoints: (p: TrackPoint[]) => void; onClose: () => void }) {
  const [patch, setPatch] = useState(16);
  const [search, setSearch] = useState(40);
  const [scale, setScale] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ r: TrackResult; layerId: string } | null>(null);
  const layer = comp.layers.find((l) => l.id === points[0]?.layerId);

  useEffect(() => {
    let un: (() => void) | undefined;
    void on<{ kind: string; progress: number }>('job-progress', (p) => { if (p.kind === 'track') setProgress(p.progress); }).then((u) => (un = u));
    return () => un?.();
  }, []);

  async function run(backwards: boolean) {
    if (!layer || layer.kind.type !== 'media') return;
    const t = S().time;
    const src0 = layer.sourceIn + (t - layer.start) * layer.speed;
    const end = backwards ? layer.sourceIn : layer.sourceIn + layer.duration * layer.speed;
    setBusy(true); setProgress(0); setResult(null);
    try {
      await S().ensureSynced();
      const r = await api.trackPoints({ asset: layer.kind.asset, start: src0, end, points: points.map((p) => p.p), patch, search, scale, backwards });
      setResult({ r, layerId: layer.id });
      S().toast(r.lostAt != null ? 'warning' : 'success', r.lostAt != null ? `Track confidence dropped at ${r.lostAt.toFixed(2)}s` : `Tracked ${r.frames.length} frames`);
    } catch (e) {
      S().toast('error', 'Tracking failed', String(e));
    } finally { setBusy(false); }
  }

  const compTime = (l: Layer, st: number) => l.start + (st - l.sourceIn) / (l.speed || 1);

  async function applyToNull() {
    if (!result) return;
    const l = comp.layers.find((x) => x.id === result.layerId);
    if (!l) return;
    const n = await api.createLayer(comp, { kind: 'null', start: 0 });
    n.name = `Track ${l.name}`;
    n.duration = comp.duration;
    n.transform.position.keys = result.r.frames.map(([st, pts]) => {
      const ct = compTime(l, st);
      const avg: [number, number] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
      const w = apply(worldMatrix(comp, l, ct), avg);
      return key<Vec3>(ct, [w[0], w[1], 0]);
    }).sort((a, b) => a.t - b.t);
    S().edit('Track to Null', (d) => { draftComp(d, comp.id)?.layers.unshift(n as Draft<Layer>); });
    S().select([n.id]);
  }

  function stabilize() {
    if (!result) return;
    const l = comp.layers.find((x) => x.id === result.layerId);
    if (!l) return;
    const first = result.r.frames[0][1][0];
    const a0 = propAt(l.transform.anchor, S().time - l.start);
    const keys = result.r.frames.map(([st, pts]) => key<Vec3>(compTime(l, st) - l.start, [a0[0] + pts[0][0] - first[0], a0[1] + pts[0][1] - first[1], a0[2]])).sort((a, b) => a.t - b.t);
    S().edit('Stabilize', (d) => {
      const dl = draftComp(d, comp.id)?.layers.find((x) => x.id === l.id);
      if (dl) dl.transform.anchor.keys = keys as Draft<Keyframe<Vec3>>[];
    });
    S().toast('success', 'Stabilized: anchor point now follows the tracked feature');
  }

  return (
    <div className="vw-float" onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ marginBottom: 6 }}>
        <Crosshair size={13} color="var(--accent)" /><b className="grow">Point Tracker</b>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close tracker"><X size={12} /></button>
      </div>
      {!layer ? <div className="muted">Click a video layer to place track points.</div> : (
        <div className="col" style={{ gap: 4 }}>
          <div className="muted">{points.length} point{points.length === 1 ? '' : 's'} on {layer.name}</div>
          <div className="row"><span className="label grow">Feature size</span><NumberField value={patch} min={4} max={64} onChange={setPatch} precision={0} unit="px" /></div>
          <div className="row"><span className="label grow">Search radius</span><NumberField value={search} min={4} max={200} onChange={setSearch} precision={0} unit="px" /></div>
          <div className="row"><span className="label grow">Analysis scale</span><NumberField value={scale} min={0.1} max={1} step={0.01} onChange={setScale} precision={2} /></div>
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn sm" disabled={busy} onClick={() => run(true)}>◀ Track</button>
            <button className="btn sm primary grow" disabled={busy} onClick={() => run(false)}>Track ▶</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => { setPoints([]); setResult(null); }}>Clear</button>
          </div>
          {busy && <div className="vw-progress"><i style={{ width: `${progress * 100}%` }} /></div>}
          {result && (
            <>
              <div className="muted">{result.r.frames.length} frames · confidence {(Math.min(...result.r.confidence) * 100).toFixed(0)}%</div>
              <div className="row">
                <button className="btn sm grow" onClick={applyToNull}>Apply to new Null</button>
                <button className="btn sm grow" onClick={stabilize}>Stabilize layer</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
