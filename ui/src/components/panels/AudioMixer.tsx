import { useEffect, useState } from 'react';
import { useComp, useEditor, draftComp } from '../../store/editor';
import { NONE } from '../../store/editor';
import { api } from '../../lib/api';
import { propAt } from '../../lib/anim';
import { setProp } from '../../lib/ops';
import { NumberField } from '../ui/primitives';
import type { Layer } from '../../types/project';

const peaksCache = new Map<string, Uint8Array>();

/** Level meter from the clip's analysed waveform at the playhead × the channel gain (dBFS). */
function useLevel(layer: Layer, assetPath: string | undefined, assetId: string | undefined) {
  const time = useEditor((s) => s.time);
  const [peaks, setPeaks] = useState<Uint8Array | null>(assetId ? peaksCache.get(assetId) ?? null : null);
  useEffect(() => {
    if (!assetId || !assetPath || peaks) return;
    api.waveform(assetId, assetPath).then((p) => { peaksCache.set(assetId, p); setPeaks(p); }).catch(() => {});
  }, [assetId, assetPath, peaks]);
  if (!peaks || layer.muted || time < layer.start || time >= layer.start + layer.duration) return -Infinity;
  const src = layer.sourceIn + (time - layer.start) * layer.speed;
  const i = Math.floor(src * 100);
  let pk = 0;
  for (let k = Math.max(0, i - 2); k <= Math.min(peaks.length - 1, i + 2); k++) pk = Math.max(pk, peaks[k] / 255);
  if (pk <= 0) return -Infinity;
  return 20 * Math.log10(pk) + propAt(layer.audio.volume, time - layer.start);
}

function Strip({ layer }: { layer: Layer }) {
  const assetId = 'asset' in layer.kind ? layer.kind.asset : undefined;
  const asset = useEditor((s) => s.project?.assets.find((a) => a.id === assetId));
  const time = useEditor((s) => s.time);
  const db = useLevel(layer, asset?.path, assetId);
  const vol = propAt(layer.audio.volume, time - layer.start);
  const pan = propAt(layer.audio.pan, time - layer.start);
  const meter = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 66)) : 0;
  const clip = db > 0;
  const edit = (fn: (l: Layer) => void, label: string) => useEditor.getState().edit(label, (d) => { const l = draftComp(d)?.layers.find((x) => x.id === layer.id); if (l) fn(l as Layer); });
  return (
    <div className={`strip ${useEditor.getState().selectedLayers.includes(layer.id) ? 'sel' : ''}`} onClick={() => useEditor.getState().select([layer.id])}>
      <div className="strip-name" title={layer.name}>{layer.name}</div>
      <div className="row" style={{ gap: 6, alignItems: 'stretch', flex: 1 }}>
        <input type="range" className="fader" min={-60} max={12} step={0.1} value={vol} onChange={(e) => setProp(layer.id, 'audio.volume', Number(e.target.value), 'Volume')} title="Volume (dB)" />
        <div className="meter"><div className={`meter-fill ${clip ? 'clip' : ''}`} style={{ height: `${meter * 100}%` }} /><div className="meter-zero" /></div>
      </div>
      <NumberField value={vol} onChange={(v) => setProp(layer.id, 'audio.volume', v, 'Volume')} step={0.1} min={-60} max={12} precision={1} unit="dB" />
      <div className="row" style={{ gap: 4 }}>
        <span className="label">Pan</span>
        <NumberField value={pan} onChange={(v) => setProp(layer.id, 'audio.pan', v, 'Pan')} step={0.01} min={-1} max={1} precision={2} />
      </div>
      <div className="row" style={{ gap: 3 }}>
        <button className={`btn sm ${layer.muted ? 'primary' : ''}`} onClick={(e) => { e.stopPropagation(); edit((l) => { l.muted = !l.muted; }, 'Mute'); }}>M</button>
        <button className={`btn sm ${layer.solo ? 'primary' : ''}`} onClick={(e) => { e.stopPropagation(); edit((l) => { l.solo = !l.solo; }, 'Solo'); }}>S</button>
      </div>
      {clip && <span className="pill err">CLIP</span>}
    </div>
  );
}

export function AudioMixer() {
  const comp = useComp();
  const assets = useEditor((s) => s.project?.assets ?? NONE);
  const layers = (comp?.layers ?? []).filter((l) => 'asset' in l.kind && assets.find((a) => a.id === (l.kind as { asset: string }).asset)?.info.hasAudio);
  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Audio Mixer</span><span className="muted grow" style={{ textAlign: 'right' }}>Levels from analysed waveforms × channel gain</span></div>
      <div className="panel-body mixer">
        {layers.length === 0 ? <div className="empty">No audio clips in this composition</div> : layers.map((l) => <Strip key={l.id} layer={l} />)}
      </div>
    </div>
  );
}
