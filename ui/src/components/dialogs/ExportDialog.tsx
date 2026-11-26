import { useEffect, useMemo, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, CheckCircle2, FolderOpen, Info } from 'lucide-react';
import { useEditor, activeComp } from '../../store/editor';
import { api, type CodecInfo, type ExportSettings, type Preset, type Validation } from '../../lib/api';
import { Field, Modal, Select, Slider, Toggle } from '../ui/primitives';
import { queueExport } from '../panels/RenderQueue';

const CONTAINER_LABEL: Record<string, string> = { mp4: 'MP4', mov: 'QuickTime MOV', mkv: 'Matroska MKV', webm: 'WebM', avi: 'AVI', mxf: 'MXF', mpg: 'MPEG', mpeg: 'MPEG', ts: 'MPEG-TS', gif: 'GIF', png: 'PNG sequence', jpg: 'JPEG sequence', tif: 'TIFF sequence', exr: 'OpenEXR sequence' };

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const comp = activeComp()!;
  const project = useEditor((s) => s.project)!;
  const settings = useEditor((s) => s.settings);
  const info = useEditor((s) => s.appInfo);
  const [codecs, setCodecs] = useState<CodecInfo[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [custom, setCustom] = useState<{ name: string; data: unknown }[]>([]);
  const [presetId, setPresetId] = useState(settings?.exportPreset ?? 'youtube');
  const [range, setRange] = useState<'all' | 'work' | 'custom'>(comp.workArea ? 'work' : 'all');
  const [validation, setValidation] = useState<Validation | null>(null);
  const [s, setS] = useState<ExportSettings>(() => ({
    container: 'mp4', codec: 'h264', path: '', width: comp.width, height: comp.height, fps: comp.fps, start: 0, end: comp.duration,
    quality: 80, bitrate: 0, alpha: false, hardware: settings?.hardwareEncode ?? true, bitDepth: 8, audio: true, audioCodec: 'aac',
    audioBitrate: 192, sampleRate: comp.sampleRate, channels: Math.min(2, comp.channels), colorSpace: comp.colorSpace, premultiplied: false,
  }));
  const set = (p: Partial<ExportSettings>) => setS((x) => ({ ...x, ...p }));
  const codec = codecs.find((c) => c.id === s.codec);

  useEffect(() => {
    api.exportCatalog().then((c) => { setCodecs(c.codecs); setPresets(c.presets); });
    api.listPresets('export').then((x) => setCustom(x)).catch(() => {});
  }, []);

  // Apply a preset.
  useEffect(() => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    const w = p.width || comp.width, h = p.height || comp.height;
    // Fit to the preset's frame while keeping the comp aspect if the preset size is the opposite orientation.
    set({ container: p.container, codec: p.codec, width: w, height: h, fps: p.fps || comp.fps, quality: p.quality, bitrate: p.bitrate, alpha: p.alpha, audioCodec: p.audioCodec, audioBitrate: p.audioBitrate || 192 });
  }, [presetId, presets]);

  // Default output path.
  useEffect(() => {
    if (s.path) return;
    const folder = settings?.exportFolder || (useEditor.getState().projectPath?.replace(/[\\/][^\\/]+$/, '') ?? '');
    const base = `${project.name}${comp.name !== 'Main' ? ` - ${comp.name}` : ''}`.replace(/[<>:"/\\|?*]/g, '_');
    set({ path: folder ? `${folder}\\${base}.${s.container}` : '' });
  }, [settings]);

  // Keep extension consistent with the container.
  useEffect(() => {
    if (!s.path) return;
    const next = s.path.replace(/\.[a-z0-9]+$/i, `.${s.container}`);
    if (next !== s.path) set({ path: next });
  }, [s.container]);

  useEffect(() => {
    const wa = comp.workArea;
    if (range === 'all') set({ start: 0, end: comp.duration });
    if (range === 'work' && wa) set({ start: wa[0], end: wa[1] });
  }, [range]);

  useEffect(() => {
    const id = window.setTimeout(() => api.validateExport(s, comp.id).then(setValidation).catch(() => {}), 150);
    return () => window.clearTimeout(id);
  }, [s, comp.id]);

  const containers = useMemo(() => Array.from(new Set(codecs.flatMap((c) => c.containers))), [codecs]);
  const codecsFor = codecs.filter((c) => c.containers.includes(s.container));
  const hwAvail = codec?.hw.filter((h) => info?.ffmpeg?.hwEncoders.includes(h)) ?? [];
  const frames = Math.round((s.end - s.start) * s.fps);

  const pick = async () => {
    const p = await save({ defaultPath: s.path || `${project.name}.${s.container}`, filters: [{ name: CONTAINER_LABEL[s.container] ?? s.container, extensions: [s.container] }] });
    if (p) set({ path: p });
  };
  const go = async (closeAfter: boolean) => {
    if (!s.path) { await pick(); return; }
    if (validation && !validation.ok) return;
    await queueExport(s, comp.id, `${s.path.split(/[\\/]/).pop()}`);
    useEditor.getState().toast('info', 'Export queued', s.path);
    if (closeAfter) onClose();
  };
  const savePreset = async () => {
    const name = window.prompt('Preset name');
    if (!name) return;
    await api.savePreset('export', name, s);
    setCustom(await api.listPresets('export'));
  };

  const groups = Array.from(new Set(presets.map((p) => p.group)));
  return (
    <Modal title={`Export — ${comp.name}`} onClose={onClose} width={880}
      footer={<>
        <button className="btn ghost" onClick={savePreset}>Save as preset…</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!!validation && !validation.ok} onClick={() => go(false)}>Add to Queue</button>
        <button className="btn primary" disabled={!!validation && !validation.ok} onClick={() => go(true)}>Export</button>
      </>}>
      <div className="export-grid">
        <div className="export-presets">
          {groups.map((g) => (
            <div key={g}>
              <div className="lib-head">{g}</div>
              {presets.filter((p) => p.group === g).map((p) => (
                <button key={p.id} className={`lib-item ${presetId === p.id ? 'on' : ''}`} onClick={() => setPresetId(p.id)}>
                  <span className="grow">{p.name}</span>{p.alpha && <span className="pill accent">α</span>}
                </button>
              ))}
            </div>
          ))}
          {custom.length > 0 && <div><div className="lib-head">My presets</div>{custom.map((p) => <button key={p.name} className="lib-item" onClick={() => setS({ ...(p.data as ExportSettings), path: s.path })}>{p.name}</button>)}</div>}
        </div>
        <div className="col" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <Field label="Format"><Select value={s.container} onChange={(v) => { const first = codecs.find((c) => c.containers.includes(v)); set({ container: v, codec: codecs.find((c) => c.id === s.codec)?.containers.includes(v) ? s.codec : first?.id ?? s.codec }); }} options={containers.map((c) => ({ value: c, label: CONTAINER_LABEL[c] ?? c }))} width={170} /></Field>
            <Field label="Codec"><Select value={s.codec} onChange={(v) => set({ codec: v, alpha: s.alpha && !!codecs.find((c) => c.id === v)?.alpha })} options={codecsFor.map((c) => ({ value: c.id, label: `${c.name}${c.alpha ? ' (α)' : ''}` }))} width={230} /></Field>
            <Field label="Bit depth"><Select value={s.bitDepth} onChange={(v) => set({ bitDepth: v })} options={[{ value: 8, label: '8-bit' }, ...(codec?.tenBit ? [{ value: 10, label: '10-bit' }] : [])]} width={90} /></Field>
          </div>
          <Field label="Output file">
            <div className="row"><input className="input grow" value={s.path} onChange={(e) => set({ path: e.target.value })} placeholder="Choose where to save…" /><button className="btn" onClick={pick}><FolderOpen size={13} /> Browse</button></div>
          </Field>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Field label="Resolution">
              <div className="row"><input className="input mono" type="number" style={{ width: 76 }} value={s.width} onChange={(e) => set({ width: Number(e.target.value) })} />×<input className="input mono" type="number" style={{ width: 76 }} value={s.height} onChange={(e) => set({ height: Number(e.target.value) })} />
                <button className="btn sm ghost" onClick={() => set({ width: comp.width, height: comp.height })}>Comp size</button>
                <button className="btn sm ghost" onClick={() => set({ width: Math.round(comp.width / 2), height: Math.round(comp.height / 2) })}>½</button></div>
            </Field>
            <Field label="Frame rate"><input className="input mono" type="number" step={0.001} style={{ width: 80 }} value={s.fps} onChange={(e) => set({ fps: Number(e.target.value) })} /></Field>
            <Field label="Range">
              <div className="row">
                <Select value={range} onChange={setRange} options={[{ value: 'all', label: 'Entire composition' }, ...(comp.workArea ? [{ value: 'work' as const, label: 'Work area (in/out)' }] : []), { value: 'custom', label: 'Custom' }]} />
                {range === 'custom' && <><input className="input mono" type="number" step={0.1} style={{ width: 64 }} value={s.start} onChange={(e) => set({ start: Number(e.target.value) })} />–<input className="input mono" type="number" step={0.1} style={{ width: 64 }} value={s.end} onChange={(e) => set({ end: Number(e.target.value) })} /></>}
              </div>
            </Field>
          </div>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Field label={`Quality ${Math.round(s.quality)}`}><Slider value={s.quality} min={0} max={100} step={1} onChange={(v) => set({ quality: v })} width={170} /></Field>
            <Field label="Bitrate (kbps, 0 = quality)"><input className="input mono" type="number" style={{ width: 100 }} value={s.bitrate} onChange={(e) => set({ bitrate: Math.max(0, Number(e.target.value)) })} /></Field>
            <Field label="Colour space"><Select value={s.colorSpace} onChange={(v) => set({ colorSpace: v })} options={[{ value: 'rec709', label: 'Rec. 709' }, { value: 'srgb', label: 'sRGB' }, { value: 'rec2020', label: 'Rec. 2020 (tagged)' }]} /></Field>
          </div>
          <div className="export-toggles">
            <label className="row" title={codec?.alpha ? 'Store the alpha channel' : 'This codec cannot store transparency'}>
              <Toggle on={s.alpha} onChange={(v) => { if (v && !codec?.alpha) { useEditor.getState().toast('warning', `${codec?.name} cannot store alpha — choose ProRes 4444, VP9, PNG/TIFF/EXR, FFV1 or QuickTime Animation`); return; } set({ alpha: v }); }} />
              <span>Alpha channel {codec && !codec.alpha && <span className="muted">(not supported by {codec.name})</span>}</span>
            </label>
            {s.alpha && <label className="row"><Toggle on={s.premultiplied} onChange={(v) => set({ premultiplied: v })} /><span>Premultiplied alpha</span></label>}
            <label className="row" title={hwAvail.length ? `Available: ${hwAvail.join(', ')}` : 'No hardware encoder available for this codec on this machine'}>
              <Toggle on={s.hardware && hwAvail.length > 0} onChange={(v) => set({ hardware: v })} />
              <span>Hardware encoding {hwAvail.length ? <span className="muted">({hwAvail[0]})</span> : <span className="muted">(unavailable)</span>}</span>
            </label>
            <label className="row"><Toggle on={s.audio} onChange={(v) => set({ audio: v })} /><span>Audio</span></label>
          </div>
          {s.audio && !codec?.sequence && (
            <div className="row" style={{ gap: 10 }}>
              <Field label="Audio codec"><Select value={s.audioCodec} onChange={(v) => set({ audioCodec: v })} options={[{ value: 'aac', label: 'AAC' }, { value: 'libopus', label: 'Opus' }, { value: 'libmp3lame', label: 'MP3' }, { value: 'pcm_s16le', label: 'PCM 16-bit' }, { value: 'pcm_s24le', label: 'PCM 24-bit' }, { value: 'flac', label: 'FLAC' }]} /></Field>
              <Field label="Bitrate"><Select value={s.audioBitrate} onChange={(v) => set({ audioBitrate: v })} options={[96, 128, 160, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps` }))} /></Field>
              <Field label="Sample rate"><Select value={s.sampleRate} onChange={(v) => set({ sampleRate: v })} options={[44100, 48000, 96000].map((r) => ({ value: r, label: `${r / 1000} kHz` }))} /></Field>
              <Field label="Channels"><Select value={s.channels} onChange={(v) => set({ channels: v })} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Stereo' }]} /></Field>
            </div>
          )}
          <div className="export-summary muted mono">{frames} frames · {(s.end - s.start).toFixed(2)}s · {s.width}×{s.height} @ {s.fps} fps</div>
          {validation && (
            <div className="col" style={{ gap: 4 }}>
              {validation.errors.map((e) => <div key={e} className="msg err"><AlertTriangle size={13} /> {e}</div>)}
              {validation.warnings.map((w) => <div key={w} className="msg warn"><Info size={13} /> {w}</div>)}
              {validation.ok && !validation.warnings.length && <div className="msg ok"><CheckCircle2 size={13} /> Ready to export</div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
