import { CheckCircle2, FolderOpen, Pause, Play, RotateCcw, Trash2, X, XCircle } from 'lucide-react';
import { useEditor, type ExportJob } from '../../store/editor';
import { api } from '../../lib/api';

const fmt = (s: number) => (Number.isFinite(s) && s > 0 ? (s > 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`) : '—');
const mb = (b: number) => (b ? `${(b / 1e6).toFixed(1)} MB` : '—');

export async function queueExport(settings: ExportJob['settings'], compId: string, label: string) {
  const s = useEditor.getState();
  if (!s.project) return;
  await s.ensureSynced();
  const id = await api.startExport(settings, compId, s.project, label);
  useEditor.setState({ jobs: [...useEditor.getState().jobs, { id, label, status: 'queued', settings, compId, started: Date.now() }] });
  return id;
}

function Job({ j }: { j: ExportJob }) {
  const p = j.progress;
  const pct = p ? (p.frame / Math.max(1, p.total)) * 100 : 0;
  const set = (patch: Partial<ExportJob>) => useEditor.setState((s) => ({ jobs: s.jobs.map((x) => (x.id === j.id ? { ...x, ...patch } : x)) }));
  const active = j.status === 'running' || j.status === 'queued' || j.status === 'paused';
  return (
    <div className={`job ${j.status}`}>
      <div className="row">
        {j.status === 'done' ? <CheckCircle2 size={15} color="var(--ok)" /> : j.status === 'failed' ? <XCircle size={15} color="var(--error)" /> : null}
        <span className="grow job-title" title={j.settings.path}>{j.label}</span>
        <span className="pill">{j.settings.codec} · {j.settings.width}×{j.settings.height}{j.settings.alpha ? ' · alpha' : ''}</span>
        {j.status === 'running' && <button className="icon-btn sm" title="Pause" onClick={() => { api.jobControl(j.id, 'pause'); set({ status: 'paused' }); }}><Pause size={12} /></button>}
        {j.status === 'paused' && <button className="icon-btn sm" title="Resume" onClick={() => { api.jobControl(j.id, 'resume'); set({ status: 'running' }); }}><Play size={12} /></button>}
        {active && <button className="icon-btn sm" title="Cancel" onClick={() => api.jobControl(j.id, 'cancel').catch(() => set({ status: 'cancelled' }))}><X size={12} /></button>}
        {(j.status === 'failed' || j.status === 'cancelled') && <button className="icon-btn sm" title="Retry" onClick={() => { useEditor.setState((s) => ({ jobs: s.jobs.filter((x) => x.id !== j.id) })); queueExport(j.settings, j.compId, j.label); }}><RotateCcw size={12} /></button>}
        {j.status === 'done' && <button className="icon-btn sm" title="Show in Explorer" onClick={() => api.reveal(j.report?.path ?? j.settings.path)}><FolderOpen size={12} /></button>}
        {!active && <button className="icon-btn sm" title="Remove from list" onClick={() => useEditor.setState((s) => ({ jobs: s.jobs.filter((x) => x.id !== j.id) }))}><Trash2 size={12} /></button>}
      </div>
      {active && (
        <>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          <div className="row muted mono job-stats">
            <span>{j.status === 'queued' ? 'Waiting…' : j.status === 'paused' ? 'Paused' : p?.stage ?? 'Starting…'}</span>
            <span>{p ? `${p.frame}/${p.total}` : ''}</span>
            <span>{p ? `${p.fps.toFixed(1)} fps` : ''}</span>
            <span>ETA {fmt(p?.etaSeconds ?? NaN)}</span>
            <span>~{mb(p?.estimatedSize ?? 0)}</span>
          </div>
        </>
      )}
      {j.status === 'done' && j.report && (
        <div className="muted mono job-stats">
          {mb(j.report.fileSize)} · {fmt(j.report.seconds)} · {j.report.validation.codec} {j.report.validation.pixFmt}{j.report.validation.hasAlpha ? ' (alpha ✓)' : ''}{j.report.validation.hasAudio ? ' · audio ✓' : ''} · {j.report.validation.messages.join('; ')}
        </div>
      )}
      {j.status === 'failed' && <div className="job-error">{j.error}{j.log ? <button className="btn sm ghost" onClick={() => api.reveal(j.log!)}>View log</button> : null}</div>}
    </div>
  );
}

export function RenderQueuePanel() {
  const jobs = useEditor((s) => s.jobs);
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label grow">Render Queue — jobs run one at a time</span>
        <button className="btn sm" onClick={() => useEditor.setState({ dialog: 'export' })}>Add export…</button>
        <button className="btn sm ghost" onClick={() => useEditor.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'paused') }))}>Clear finished</button>
      </div>
      <div className="panel-body" style={{ padding: 8 }}>
        {jobs.length === 0 ? <div className="empty">No exports yet</div> : [...jobs].reverse().map((j) => <Job key={j.id} j={j} />)}
      </div>
    </div>
  );
}
