// "Update available" pop-up. Not dismissable while downloading or installing, so no edits are
// made that the restart would lose.
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { useUpdater, installUpdate, dismissUpdate, skipUpdate } from '../../lib/updater';
import { saveProject } from '../shell/coreActions';

const mb = (b: number) => (b / 1024 / 1024).toFixed(0);

export function UpdateDialog() {
  const { update, phase, downloaded, total, error } = useUpdater();
  const dirty = useEditor((s) => s.dirty && !!s.project);
  const exporting = useEditor((s) => s.jobs.some((j) => j.status === 'running' || j.status === 'paused' || j.status === 'queued'));
  if (!update || phase === 'idle') return null;

  const start = async () => {
    if (useEditor.getState().dirty && useEditor.getState().project) {
      await saveProject(false);
      if (useEditor.getState().dirty) return; // save cancelled or failed: stay on the dialog
    }
    await installUpdate();
  };
  const pct = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
  const working = phase === 'downloading' || phase === 'installing';

  let body;
  let footer = null;
  if (phase === 'downloading') {
    body = (
      <>
        <div>Downloading Directory {update.version}…</div>
        <div className="progress" style={{ margin: '12px 0 6px' }}><div style={{ width: `${pct}%` }} /></div>
        <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{total > 0 ? `${mb(downloaded)} of ${mb(total)} MB` : `${mb(downloaded)} MB`}</div>
      </>
    );
  } else if (phase === 'installing') {
    body = <div>Installing… Directory will close and reopen by itself in a moment.</div>;
  } else if (phase === 'error') {
    body = (
      <>
        <div>The update couldn't be installed. Your current version hasn't been changed.</div>
        <div className="toast-detail" style={{ marginTop: 8 }}>{error}</div>
      </>
    );
    footer = <><span className="grow" /><button className="btn" onClick={dismissUpdate}>Close</button><button className="btn primary" onClick={() => void installUpdate()}>Try again</button></>;
  } else {
    body = (
      <>
        <div>Directory <b>{update.version}</b> is ready to install. You have {update.currentVersion}.</div>
        {update.body?.trim() && (
          <>
            <div style={{ marginTop: 14, fontWeight: 600 }}>What's new</div>
            <div className="toast-detail" style={{ maxHeight: 200, fontSize: 'var(--fs-md)', color: 'var(--text-2)' }}>{update.body.trim()}</div>
          </>
        )}
        <div className="muted" style={{ marginTop: 14, fontSize: 'var(--fs-sm)' }}>
          Directory will close, install the update and reopen. Your projects and settings are kept.
          {dirty && !exporting && ' Your project has unsaved changes; it will be saved first.'}
        </div>
        {exporting && <div style={{ marginTop: 10, color: 'var(--warn)' }}>An export is in progress. Finish or cancel it in the Render Queue before updating.</div>}
      </>
    );
    footer = (
      <>
        <button className="btn ghost" onClick={skipUpdate}>Skip this version</button>
        <span className="grow" />
        <button className="btn" onClick={dismissUpdate}>Not now</button>
        <button className="btn primary" disabled={exporting} onClick={() => void start()}>{dirty ? 'Save & Update' : 'Update now'}</button>
      </>
    );
  }

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => { if (!working && phase !== 'error' && e.target === e.currentTarget) dismissUpdate(); }}>
      <div className="modal" style={{ width: 480 }} role="dialog" aria-modal="true" aria-label="Update available">
        <div className="modal-head"><span className="grow row"><Download size={16} /> {phase === 'error' ? 'Update failed' : 'Update available'}</span></div>
        <div className="modal-body">{body}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
