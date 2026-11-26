// Playback engine: drives store.time from the audio clock (when the comp has audio) or the
// wall clock, loops over the work area, and tracks achieved preview fps / dropped frames.
import { activeComp, useEditor } from '../store/editor';
import { api, fileSrc, isTauri } from './api';
import { registerActions } from './actions';
import type { Composition, Project } from '../types/project';

const S = () => useEditor.getState();

let raf = 0;
let audio: HTMLAudioElement | null = null;
let audioKey = '';
let clockStart = 0;
let timeStart = 0;
let usingAudio = false;

// Frame statistics (fed by the viewer each time a frame is displayed).
let shown = 0;
let statStart = 0;
let statTime0 = 0;
let lowSince = 0;
/** Multiplier applied to the preview scale while playback cannot keep up (1 = off). */
export let adaptiveFactor = 1;
const adaptiveListeners = new Set<() => void>();
export function onAdaptiveChange(cb: () => void) { adaptiveListeners.add(cb); return () => adaptiveListeners.delete(cb); }
function setAdaptive(v: number) { if (v !== adaptiveFactor) { adaptiveFactor = v; adaptiveListeners.forEach((f) => f()); } }

export function workArea(c: Composition): [number, number] {
  const wa = c.workArea;
  if (wa && wa[1] > wa[0]) return [Math.max(0, wa[0]), Math.min(c.duration, wa[1])];
  return [0, c.duration];
}

function hasAudio(p: Project, c: Composition, depth = 0): boolean {
  if (depth > 8) return false;
  return c.layers.some((l) => {
    if (l.muted) return false;
    if (l.kind.type === 'media' || l.kind.type === 'audio') {
      const id = l.kind.asset;
      return !!p.assets.find((a) => a.id === id)?.info.hasAudio;
    }
    if (l.kind.type === 'comp') {
      const id = l.kind.comp;
      const n = p.compositions.find((x) => x.id === id);
      return !!n && hasAudio(p, n, depth + 1);
    }
    return false;
  });
}

async function prepareAudio(c: Composition): Promise<boolean> {
  const s = S();
  if (!isTauri || !s.project || !hasAudio(s.project, c)) return false;
  const key = `${c.id}:${s.revision}`;
  if (audio && audioKey === key) return true;
  try {
    await s.ensureSynced();
    const path = await api.previewAudio(c.id);
    if (!path) return false;
    if (!audio) audio = new Audio();
    audio.src = fileSrc(path);
    audio.preload = 'auto';
    audioKey = key;
    await new Promise<void>((res) => {
      const done = () => { audio!.removeEventListener('canplay', done); audio!.removeEventListener('error', done); res(); };
      audio!.addEventListener('canplay', done);
      audio!.addEventListener('error', done);
      window.setTimeout(done, 4000);
    });
    return !audio.error;
  } catch (e) {
    S().toast('warning', 'Audio preview unavailable', String(e));
    return false;
  }
}

function tick() {
  const s = S();
  const c = activeComp();
  if (!s.playing || !c) { raf = 0; return; }
  const [a, b] = workArea(c);
  let t = usingAudio && audio ? audio.currentTime : timeStart + (performance.now() - clockStart) / 1000;
  if (t >= b - 1e-6 || (usingAudio && audio?.ended)) {
    if (s.loop) {
      t = a;
      restartClock(a);
    } else {
      s.setTime(b);
      pause();
      return;
    }
  }
  const frame = Math.floor(t * c.fps + 1e-6) / c.fps;
  if (Math.abs(frame - s.time) > 1e-9) useEditor.setState({ time: frame });
  raf = requestAnimationFrame(tick);
}

function restartClock(t: number) {
  timeStart = t;
  clockStart = performance.now();
  statStart = performance.now();
  statTime0 = t;
  shown = 0;
  if (usingAudio && audio) {
    audio.currentTime = t;
    void audio.play().catch(() => { usingAudio = false; });
  }
}

export async function play(from?: number) {
  const s = S();
  const c = activeComp();
  if (!c) return;
  const [a, b] = workArea(c);
  let t = from ?? s.time;
  if (t >= b - 1 / c.fps || t < a) t = a;
  s.setTime(t);
  usingAudio = await prepareAudio(c);
  useEditor.setState({ playing: true, droppedFrames: 0, playbackFps: 0 });
  lowSince = 0;
  restartClock(t);
  if (!raf) raf = requestAnimationFrame(tick);
}

export function pause() {
  useEditor.setState({ playing: false });
  if (audio) audio.pause();
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  setAdaptive(1);
}

export function toggle() {
  if (S().playing) pause(); else void play();
}

/** Called by the viewer whenever a frame is presented. */
export function frameShown() {
  const s = S();
  const c = activeComp();
  if (!s.playing || !c) return;
  shown++;
  const el = (performance.now() - statStart) / 1000;
  if (el < 0.5) return;
  const fps = shown / el;
  const expected = Math.max(0, (s.time - statTime0) * c.fps);
  const dropped = Math.max(0, Math.round(expected - shown));
  useEditor.setState({ playbackFps: Math.round(fps * 10) / 10, droppedFrames: dropped });
  if (s.settings?.adaptivePreview !== false) {
    const now = performance.now();
    if (fps < c.fps * 0.6) {
      if (!lowSince) lowSince = now;
      else if (now - lowSince > 900 && adaptiveFactor > 0.25) { setAdaptive(adaptiveFactor / 2); lowSince = now; }
    } else lowSince = 0;
  }
  if (el > 3) { statStart = performance.now(); statTime0 = s.time; shown = 0; }
}

export function step(frames: number) {
  const c = activeComp();
  if (!c) return;
  if (S().playing) pause();
  S().setTime(S().time + frames / c.fps);
}

export function goTo(where: 'start' | 'end') {
  const c = activeComp();
  if (!c) return;
  if (S().playing) pause();
  const [a, b] = workArea(c);
  const t = where === 'start' ? (S().time > a + 1e-6 ? a : 0) : (S().time < b - 1 / c.fps - 1e-6 ? b - 1 / c.fps : c.duration - 1 / c.fps);
  S().setTime(t);
}

registerActions([
  { id: 'playback.toggle', label: 'Play / Pause', group: 'Playback', shortcut: 'Space', run: toggle, enabled: () => !!S().project },
  { id: 'playback.fromStart', label: 'Play from Work Area Start', group: 'Playback', shortcut: 'Shift+Space', run: () => { const c = activeComp(); if (c) void play(workArea(c)[0]); } },
  { id: 'playback.toStart', label: 'Go to Start', group: 'Playback', shortcut: 'Ctrl+ArrowLeft', run: () => goTo('start') },
  { id: 'playback.toEnd', label: 'Go to End', group: 'Playback', shortcut: 'Ctrl+ArrowRight', run: () => goTo('end') },
  { id: 'playback.home', label: 'Go to Composition Start', group: 'Playback', shortcut: 'Home', run: () => { pause(); S().setTime(0); } },
  { id: 'playback.endKey', label: 'Go to Composition End', group: 'Playback', shortcut: 'End', run: () => { const c = activeComp(); pause(); if (c) S().setTime(c.duration - 1 / c.fps); } },
  { id: 'playback.prevFrame', label: 'Previous Frame', group: 'Playback', shortcut: 'PageUp', run: () => step(-1) },
  { id: 'playback.nextFrame', label: 'Next Frame', group: 'Playback', shortcut: 'PageDown', run: () => step(1) },
  { id: 'playback.prevFrameComma', label: 'Previous Frame (,)', group: 'Playback', shortcut: ',', run: () => step(-1) },
  { id: 'playback.nextFramePeriod', label: 'Next Frame (.)', group: 'Playback', shortcut: '.', run: () => step(1) },
  { id: 'playback.back10', label: 'Back 10 Frames', group: 'Playback', shortcut: 'Shift+PageUp', run: () => step(-10) },
  { id: 'playback.fwd10', label: 'Forward 10 Frames', group: 'Playback', shortcut: 'Shift+PageDown', run: () => step(10) },
  { id: 'playback.loop', label: 'Toggle Loop Playback', group: 'Playback', run: () => useEditor.setState({ loop: !S().loop }) },
]);
