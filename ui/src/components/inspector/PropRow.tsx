// Generic animatable property rows: keyframe stopwatch, value editor, key navigation, expressions.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Equal } from 'lucide-react';
import type { Color, Layer, Prop } from '../../types/project';
import { getPath, useEditor } from '../../store/editor';
import { propAt } from '../../lib/anim';
import { toggleKey, hasKeyAt } from '../../lib/ops';
import { api, isTauri } from '../../lib/api';
import { ColorField, KeyButton, NumberField, Slider } from '../ui/primitives';
import { editLayers, writeProps } from './util';

const S = () => useEditor.getState();

export function PropRow<T>({ layers, path, label, children, noKeys, title }: {
  layers: Layer[]; path: string; label: ReactNode; title?: string; noKeys?: boolean;
  children: (v: T, set: (v: T) => void) => ReactNode;
}) {
  const time = useEditor((s) => s.time);
  const active = useEditor((s) => s.activeProp);
  const alt = useRef(false);
  const l0 = layers[0];
  const prop = (l0 ? getPath(l0, path) : undefined) as Prop<T> | undefined;
  const [exprOpen, setExprOpen] = useState(!!prop?.expr);
  if (!l0 || !prop || typeof prop !== 'object' || !('value' in prop)) return null;
  const lt = time - l0.start;
  const v = propAt(prop, lt);
  const keys = prop.keys ?? [];
  const animated = keys.length > 0;
  const atKey = hasKeyAt(prop as Prop<unknown>, lt);
  const ids = layers.map((l) => l.id);
  const set = (nv: T) => writeProps(ids.map((id) => ({ layerId: id, path, value: nv })), `Edit ${typeof label === 'string' ? label : 'Property'}`, `insp:${ids.join(',')}:${path}`);
  const jump = (dir: -1 | 1) => {
    const ts = keys.map((k) => k.t).sort((a, b) => a - b);
    const t = dir < 0 ? [...ts].reverse().find((x) => x < lt - 1e-4) : ts.find((x) => x > lt + 1e-4);
    if (t != null) S().setTime(l0.start + t);
  };
  const activeId = `${l0.id}::${path}`;
  return (
    <>
      <div className={`prop-row ${animated || prop.expr ? 'animated' : ''} ${active === activeId ? 'is-active' : ''}`}>
        {noKeys ? <span /> : (
          <span onPointerDownCapture={(e) => (alt.current = e.altKey)}>
            <KeyButton animated={animated} atKey={atKey} onClick={() => ids.forEach((id) => toggleKey(id, path, alt.current))} />
          </span>
        )}
        <span className="prop-label" title={title ?? (typeof label === 'string' ? label : undefined)} onClick={() => S().set({ activeProp: activeId })}>{label}</span>
        <span className="row prop-val">{children(v, set)}</span>
        <span className="row prop-tail">
          {animated && !noKeys && <>
            <button className="icon-btn sm" title="Previous keyframe" onClick={() => jump(-1)}><ChevronLeft size={11} /></button>
            <button className="icon-btn sm" title="Next keyframe" onClick={() => jump(1)}><ChevronRight size={11} /></button>
          </>}
          {!noKeys && <button className={`icon-btn sm ${prop.expr ? 'active' : ''}`} title="Expression" onClick={() => setExprOpen(!exprOpen)}><Equal size={11} /></button>}
        </span>
      </div>
      {exprOpen && <ExprEditor layers={layers} path={path} value={prop.expr ?? ''} />}
    </>
  );
}

function ExprEditor({ layers, path, value }: { layers: Layer[]; path: string; value: string }) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (!isTauri) return;
    const h = window.setTimeout(() => { void api.validateExpression(text).then((e) => setErr(text.trim() ? e : null)).catch(() => {}); }, 220);
    return () => window.clearTimeout(h);
  }, [text]);
  useEffect(() => {
    if (!isTauri || !value) return;
    const id = window.setInterval(() => {
      void api.expressionErrors().then((errs) => {
        const mine = errs.find(([k]) => k.startsWith(layers[0].id));
        if (mine) setRuntime(mine[1]);
      }).catch(() => {});
    }, 2500);
    return () => window.clearInterval(id);
  }, [value, layers]);
  const commit = (t: string) => editLayers(layers.map((l) => l.id), 'Edit Expression', (l) => {
    const p = getPath(l, path) as Prop<unknown> | undefined;
    if (p) p.expr = t.trim() ? t : null;
  }, `expr:${path}`);
  return (
    <div className="expr-box">
      <textarea className="input" rows={2} spellCheck={false} value={text} placeholder="e.g. wiggle(2, 30)  ·  value + [time*100, 0]  ·  loopOut('cycle')"
        onChange={(e) => { setText(e.target.value); setRuntime(null); commit(e.target.value); }} onKeyDown={(e) => e.stopPropagation()} />
      {(err || runtime) && <div className="expr-err">{err ?? runtime}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- convenience rows

export function NumRow({ layers, path, label, min, max, step = 1, unit, precision = 1, slider, mul = 1, noKeys }: {
  layers: Layer[]; path: string; label: string; min?: number; max?: number; step?: number; unit?: string; precision?: number; slider?: boolean; mul?: number; noKeys?: boolean;
}) {
  return (
    <PropRow<number> layers={layers} path={path} label={label} noKeys={noKeys}>
      {(v, set) => <>
        <NumberField value={v * mul} onChange={(x) => set(x / mul)} min={min} max={max} step={step} unit={unit} precision={precision} />
        {slider && min != null && max != null && <Slider value={v * mul} min={min} max={max} step={step} onChange={(x) => set(x / mul)} width={72} />}
      </>}
    </PropRow>
  );
}

export function VecRow({ layers, path, label, dims = 2, step = 1, unit, precision = 1, mul = 1 }: {
  layers: Layer[]; path: string; label: string; dims?: number; step?: number; unit?: string; precision?: number; mul?: number;
}) {
  return (
    <PropRow<number[]> layers={layers} path={path} label={label}>
      {(v, set) => <>{Array.from({ length: dims }, (_, i) => (
        <NumberField key={i} value={(v[i] ?? 0) * mul} step={step} unit={unit} precision={precision}
          onChange={(x) => { const n = [...v]; n[i] = x / mul; set(n); }} />
      ))}</>}
    </PropRow>
  );
}

export function ColorRow({ layers, path, label, alpha = true }: { layers: Layer[]; path: string; label: string; alpha?: boolean }) {
  return (
    <PropRow<Color> layers={layers} path={path} label={label}>
      {(v, set) => <ColorField value={v} onChange={set} alpha={alpha} />}
    </PropRow>
  );
}

/** Non-animatable row with the same grid alignment. */
export function PlainRow({ label, children, title }: { label: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div className="prop-row">
      <span />
      <span className="prop-label" title={title}>{label}</span>
      <span className="row prop-val">{children}</span>
      <span />
    </div>
  );
}
