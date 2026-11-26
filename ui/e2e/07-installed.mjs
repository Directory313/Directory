// Smoke test of the INSTALLED release build (no dev hooks; uses the real IPC commands).
const MEDIA = process.env.VEYRA_TEST_MEDIA;
const OUT = process.env.VEYRA_TEST_OUT;
export default async function ({ page, shot, invoke }) {
  await page.waitForSelector('.home', { timeout: 20000 });
  const info = await invoke('app_info');
  console.log('gpu:', info.gpu, info.gpuBackend, '| ffmpeg:', info.ffmpeg.ffmpegPath);
  await shot('09-installed-home');
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell');
  const res = await invoke('import_media', { paths: [`${MEDIA}\\clip_a.mp4`], asSequence: false, existingFingerprints: [] });
  console.log('import:', res.assets.map((a) => `${a.name} ${a.info.width}x${a.info.height} ${a.info.duration}s`), res.errors);
  const p = await invoke('new_project', { opts: { name: 'Installed', width: 1280, height: 720, fps: 30, duration: 3 } });
  const layer = await invoke('create_layer', { comp: p.compositions[0], req: { kind: 'media', asset: res.assets[0], start: 0 } });
  p.assets.push(res.assets[0]);
  p.compositions[0].layers.push(layer);
  await invoke('sync_project', { project: p });
  const buf = await page.evaluate(async (id) => { const b = await window.__TAURI_INTERNALS__.invoke('render_frame', { compId: id, time: 1, scale: 0.5, draft: false }); const u = new Uint8Array(b); let n = 0; for (let i = 8; i < u.length; i += 4) if (u[i] + u[i + 1] + u[i + 2] > 60) n++; return { w: new DataView(b).getUint32(0, true), lit: n }; }, p.compositions[0].id);
  console.log('render:', JSON.stringify(buf));
  const id = await invoke('start_export', { settings: { container: 'mp4', codec: 'h264', path: `${OUT}\\installed.mp4`, width: 1280, height: 720, fps: 30, start: 0, end: 3, quality: 75, bitrate: 0, alpha: false, hardware: true, bitDepth: 8, audio: true, audioCodec: 'aac', audioBitrate: 128, sampleRate: 48000, channels: 2, colorSpace: 'rec709', premultiplied: false }, compId: p.compositions[0].id, project: p, label: 'installed' });
  const done = await page.evaluate((jid) => new Promise((resolve) => { window.__TAURI_INTERNALS__.transformCallback; const t0 = Date.now(); const poll = async () => { const jobs = await window.__TAURI_INTERNALS__.invoke('active_jobs'); if (!jobs.some((j) => j.id === jid) || Date.now() - t0 > 120000) resolve(Date.now() - t0); else setTimeout(poll, 500); }; poll(); }), id);
  console.log(`export finished in ${done} ms`);
}
