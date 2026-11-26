import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEditor } from '../../store/editor';

const ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const I = ICON[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <I size={15} className="toast-icon" />
            <div className="grow">
              <div>{t.text}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
            </div>
            <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}
