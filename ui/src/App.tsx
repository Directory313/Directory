import { useEffect } from 'react';
import { useEditor } from './store/editor';
import { api, isTauri, on, type ExportProgress, type ExportReport } from './lib/api';
import { handleShortcut } from './lib/actions';
import { HomeScreen } from './components/shell/HomeScreen';
import { EditorShell } from './components/shell/EditorShell';
import { Toasts } from './components/shell/Toasts';
import { ContextMenuHost } from './components/ui/primitives';
import { useOsDragDrop } from './components/shell/dragdrop';
import './components/shell/coreActions';
import './lib/playback'; // registers transport shortcuts and the playback clock

export function App() {
  const screen = useEditor((s) => s.screen);
  const settings = useEditor((s) => s.settings);
  useOsDragDrop();

  // Boot: settings, effect registry, system info.
  useEffect(() => {
    if (!isTauri) return;
    api.getSettings().then(async (s) => {
      useEditor.setState({ settings: s, previewScale: s.previewScale, snapping: s.snapping });
      if (s.startup === 'last' && s.recent[0]) {
        const { openProjectPath } = await import('./components/shell/coreActions');
        const recovery = await api.listRecovery();
        if (!recovery.length) openProjectPath(s.recent[0]); // recovery prompt on the home screen takes precedence
      }
    }).catch(() => {});
    api.effects().then((d) => useEditor.setState({ effectDefs: d })).catch(() => {});
    api.appInfo().then((info) => {
      useEditor.setState({ appInfo: info });
      if (info.gpuError) useEditor.getState().toast('error', 'GPU unavailable — rendering cannot start', info.gpuError);
      else if (info.softwareRender) useEditor.getState().toast('warning', 'Using software rendering (no compatible GPU found); preview will be slower');
    }).catch((e) => useEditor.getState().toast('error', 'Engine failed to start', String(e)));
  }, []);

  // Interface scaling / reduced motion / accent intensity.
  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale || 1));
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
    const a = Math.max(0.4, Math.min(1, settings.accentIntensity || 1));
    document.documentElement.style.setProperty('--accent', `color-mix(in srgb, #f28d96 ${a * 100}%, #8a8a8a)`);
  }, [settings]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (useEditor.getState().screen === 'editor' || e.ctrlKey) handleShortcut(e); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Export / job events update the render queue even when its panel is closed.
  useEffect(() => {
    const subs = [
      on<{ id: string; progress: ExportProgress }>('export-progress', ({ id, progress }) => {
        useEditor.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: j.status === 'paused' ? 'paused' : 'running', progress } : j)) }));
      }),
      on<{ id: string; report?: ExportReport; error?: string; log?: string }>('export-done', ({ id, report, error, log }) => {
        const s = useEditor.getState();
        const job = s.jobs.find((j) => j.id === id);
        useEditor.setState({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: error ? (error === 'cancelled' ? 'cancelled' : 'failed') : 'done', report, error, log } : j)) });
        if (error && error !== 'cancelled') s.toast('error', `Export failed: ${job?.label ?? ''}`, error);
        else if (report) s.toast(report.validation.ok ? 'success' : 'warning', report.validation.ok ? `Export complete — ${job?.label ?? ''}` : 'Export finished with warnings', report.validation.messages.join('\n'));
      }),
      on<{ assetId: string; proxy?: string; error?: string }>('proxy-done', ({ assetId, proxy, error }) => {
        const s = useEditor.getState();
        if (error) { s.toast('error', 'Proxy generation failed', error); return; }
        s.edit('Attach Proxy', (d) => { const a = d.assets.find((x) => x.id === assetId); if (a) { a.proxy = proxy; a.useProxy = true; } });
        s.toast('success', 'Proxy ready');
      }),
    ];
    return () => { subs.forEach((p) => p.then((u) => u())); };
  }, []);

  // Warn before closing with unsaved work.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (useEditor.getState().dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // Autosave (to the recovery folder; never overwrites the user's file).
  useEffect(() => {
    if (!isTauri) return;
    const id = window.setInterval(() => {
      const s = useEditor.getState();
      if (!s.project || !s.dirty || !(s.settings?.autosaveEnabled ?? true)) return;
      api.autosave(s.project).then(() => useEditor.setState({ saveState: useEditor.getState().dirty ? 'autosaved' : 'saved' })).catch((e) => s.toast('warning', 'Autosave failed', String(e)));
    }, Math.max(0.25, settings?.autosaveMinutes ?? 2) * 60_000);
    return () => window.clearInterval(id);
  }, [settings?.autosaveMinutes]);

  return (
    <>
      {screen === 'home' ? <HomeScreen /> : <EditorShell />}
      <Toasts />
      <ContextMenuHost />
    </>
  );
}
