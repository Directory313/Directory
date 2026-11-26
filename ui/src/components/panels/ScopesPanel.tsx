import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import { api, type Scopes } from '../../lib/api';

type Kind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

function draw(c: HTMLCanvasElement, s: Scopes, kind: Kind) {
  const ctx = c.getContext('2d')!;
  const W = c.width, H = c.height;
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#242424';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke(); }
  const plot = (data: number[], cols: number, x0: number, w: number, color: [number, number, number]) => {
    const max = Math.max(1, ...data) * 0.25;
    const img = ctx.getImageData(x0, 0, w, H);
    for (let y = 0; y < 64; y++) for (let x = 0; x < cols; x++) {
      const v = Math.min(1, data[y * cols + x] / max);
      if (v <= 0) continue;
      const px0 = Math.floor((x / cols) * w), px1 = Math.ceil(((x + 1) / cols) * w), py0 = Math.floor((y / 64) * H), py1 = Math.ceil(((y + 1) / 64) * H);
      for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) {
        const i = (py * w + px) * 4;
        img.data[i] = Math.min(255, img.data[i] + color[0] * v);
        img.data[i + 1] = Math.min(255, img.data[i + 1] + color[1] * v);
        img.data[i + 2] = Math.min(255, img.data[i + 2] + color[2] * v);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, x0, 0);
  };
  if (kind === 'waveform') plot(s.waveform, s.cols, 0, W, [200, 220, 200]);
  if (kind === 'parade') {
    const n = s.cols * 64, w = Math.floor(W / 3);
    plot(s.parade.slice(0, n), s.cols, 0, w, [255, 90, 90]);
    plot(s.parade.slice(n, 2 * n), s.cols, w, w, [90, 255, 120]);
    plot(s.parade.slice(2 * n), s.cols, 2 * w, w, [110, 150, 255]);
  }
  if (kind === 'vectorscope') {
    const size = Math.min(W, H) - 8, ox = (W - size) / 2, oy = (H - size) / 2;
    ctx.strokeStyle = '#333';
    ctx.beginPath(); ctx.arc(W / 2, H / 2, size / 2, 0, Math.PI * 2); ctx.stroke();
    const max = Math.max(1, ...s.vectorscope) * 0.2;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = Math.min(1, s.vectorscope[y * 64 + x] / max);
      if (!v) continue;
      ctx.fillStyle = `rgba(242,141,150,${v})`;
      ctx.fillRect(ox + (x / 64) * size, oy + (y / 64) * size, size / 64 + 1, size / 64 + 1);
    }
    // Skin-tone line (~123°).
    ctx.strokeStyle = '#555';
    ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(W / 2 - Math.cos(Math.PI * 0.317) * size / 2, H / 2 - Math.sin(Math.PI * 0.317) * size / 2); ctx.stroke();
  }
  if (kind === 'histogram') {
    const colors = ['rgba(255,90,90,0.55)', 'rgba(90,255,120,0.55)', 'rgba(110,150,255,0.55)', 'rgba(230,230,230,0.45)'];
    const max = Math.max(1, ...s.histogram.flatMap((h) => h.slice(1, 255)));
    s.histogram.forEach((h, k) => {
      ctx.fillStyle = colors[k];
      ctx.beginPath();
      ctx.moveTo(0, H);
      h.forEach((v, i) => ctx.lineTo((i / 255) * W, H - Math.min(1, v / max) * H));
      ctx.lineTo(W, H);
      ctx.fill();
    });
  }
}

export function ScopesPanel() {
  const [kind, setKind] = useState<Kind>('waveform');
  const ref = useRef<HTMLCanvasElement>(null);
  const compId = useEditor((s) => s.compId);
  const time = useEditor((s) => s.time);
  const rev = useEditor((s) => s.syncedRevision);
  const playing = useEditor((s) => s.playing);
  const [data, setData] = useState<Scopes | null>(null);
  useEffect(() => {
    if (playing) return; // scopes update on pause/scrub to keep playback smooth
    const id = window.setTimeout(() => { api.scopes(compId, time, 0.25).then(setData).catch(() => {}); }, 120);
    return () => window.clearTimeout(id);
  }, [compId, time, rev, playing]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const r = c.getBoundingClientRect();
    c.width = Math.max(100, Math.floor(r.width));
    c.height = Math.max(80, Math.floor(r.height));
    draw(c, data, kind);
  }, [data, kind]);
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="tabs">{(['waveform', 'parade', 'vectorscope', 'histogram'] as Kind[]).map((k) => <button key={k} className={`tab ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{k === 'parade' ? 'RGB Parade' : k[0].toUpperCase() + k.slice(1)}</button>)}</div>
        <span className="muted grow" style={{ textAlign: 'right' }}>{playing ? 'paused while playing' : ''}</span>
      </div>
      <div className="panel-body" style={{ padding: 6 }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 6 }} /></div>
    </div>
  );
}
