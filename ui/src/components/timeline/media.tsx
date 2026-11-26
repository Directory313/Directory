// Filmstrip thumbnails and audio waveforms drawn inside clip bars.
import { memo, useEffect, useRef, useState } from 'react';
import type { Asset, Layer } from '../../types/project';
import { api, isTauri } from '../../lib/api';

const stripCache = new Map<string, string[] | Promise<string[]>>();
const peakCache = new Map<string, Uint8Array | Promise<Uint8Array>>();

function useAsync<T>(key: string | null, cache: Map<string, T | Promise<T>>, load: () => Promise<T>): T | null {
  const [, force] = useState(0);
  const v = key ? cache.get(key) : undefined;
  useEffect(() => {
    if (!key || !isTauri) return;
    let alive = true;
    let cur = cache.get(key);
    if (!cur) {
      cur = load().catch(() => [] as unknown as T);
      cache.set(key, cur);
      (cur as Promise<T>).then((r) => cache.set(key, r));
    }
    if (cur instanceof Promise) cur.then(() => alive && force((n) => n + 1));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v && !(v instanceof Promise) ? v : null;
}

/** Thumbnails positioned by source time so trimming/slipping keeps them aligned. */
export const Filmstrip = memo(function Filmstrip({ layer, asset, pps, height }: { layer: Layer; asset: Asset; pps: number; height: number }) {
  const dur = asset.info.duration;
  const count = Math.max(1, Math.min(60, Math.round(dur / 2) || 1));
  const thumbs = useAsync(`${asset.id}:${count}`, stripCache, () => api.filmstrip(asset.id, asset.proxy && asset.useProxy ? asset.proxy : asset.path, dur, count));
  if (!thumbs || !thumbs.length) return null;
  const seg = dur / thumbs.length;
  const w = Math.max(8, (seg / Math.max(layer.speed, 1e-6)) * pps);
  // Thumbnail every N so they are not narrower than ~40px.
  const every = Math.max(1, Math.ceil(40 / w));
  return (
    <div className="tl-strip" style={{ height }}>
      {thumbs.map((src, i) => {
        if (i % every) return null;
        const x = ((i * seg - layer.sourceIn) / Math.max(layer.speed, 1e-6)) * pps;
        return <img key={i} src={src} draggable={false} style={{ left: x, width: w * every, height }} alt="" />;
      })}
    </div>
  );
});

export const Waveform = memo(function Waveform({ layer, asset, pps, width, height }: { layer: Layer; asset: Asset; pps: number; width: number; height: number }) {
  const peaks = useAsync(asset.id, peakCache, () => api.waveform(asset.id, asset.path));
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.min(8000, Math.round(width)));
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks || !peaks.length) return;
    const g = c.getContext('2d')!;
    c.width = w;
    c.height = height;
    g.clearRect(0, 0, w, height);
    g.fillStyle = 'rgba(143, 191, 154, 0.75)';
    const mid = height / 2;
    const speed = Math.max(layer.speed, 1e-6);
    for (let x = 0; x < w; x++) {
      const t0 = layer.reverse ? layer.sourceIn + (layer.duration - x / pps) * speed : layer.sourceIn + (x / pps) * speed;
      const t1 = t0 + speed / pps;
      let a = Math.floor(Math.min(t0, t1) * 100), b = Math.ceil(Math.max(t0, t1) * 100);
      a = Math.max(0, a); b = Math.min(peaks.length, Math.max(a + 1, b));
      let m = 0;
      for (let i = a; i < b; i++) if (peaks[i] > m) m = peaks[i];
      const h = (m / 255) * mid * 0.95;
      g.fillRect(x, mid - h, 1, Math.max(1, h * 2));
    }
  }, [peaks, w, height, pps, layer.sourceIn, layer.speed, layer.reverse, layer.duration]);
  if (!peaks) return null;
  return <canvas ref={ref} className="tl-wave" style={{ width: w, height }} />;
});
