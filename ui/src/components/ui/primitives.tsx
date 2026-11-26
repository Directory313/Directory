// Shared UI primitives used by every panel. Keep these small and consistent.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Diamond, Search as SearchIcon, X } from 'lucide-react';
import type { Color } from '../../types/project';

// ---------------------------------------------------------------- NumberField (scrub + type)
export function NumberField({ value, onChange, onCommit, step = 1, min, max, precision = 2, unit, width, title, disabled }: {
  value: number; onChange: (v: number) => void; onCommit?: () => void; step?: number; min?: number; max?: number;
  precision?: number; unit?: string; width?: number; title?: string; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const fmt = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(Math.min(precision, 1)) : v.toFixed(precision)).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m)) : '—');
  if (editing) {
    return (
      <input
        className="input num-input" autoFocus value={text} style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { commitText(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }}
      />
    );
  }
  function commitText() {
    setEditing(false);
    // Allow simple arithmetic like "100+20" or "*2".
    try {
      const src = text.trim().replace(/^([*/+-])/, `${value}$1`);
      if (!/^[\d\s.+\-*/()e]+$/i.test(src)) return;
      const v = Function(`"use strict";return (${src})`)() as number;
      if (Number.isFinite(v)) { onChange(clamp(v)); onCommit?.(); }
    } catch { /* ignore invalid input */ }
  }
  return (
    <span
      className="num" title={title ?? 'Drag to scrub · click to type · Shift ×10 · Ctrl ÷10'}
      style={{ ...(width ? { width } : {}), opacity: disabled ? 0.5 : 1 }}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (Math.abs(dx) > 2) d.moved = true;
        if (!d.moved) return;
        const mul = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
        onChange(clamp(d.v + dx * step * mul));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) { setText(String(+value.toFixed(4))); setEditing(true); }
        else onCommit?.();
      }}
    >
      {fmt(value)}{unit ? <span className="muted">{unit}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- Slider
export function Slider({ value, min, max, step = 0.01, onChange, width = 110 }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; width?: number }) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <input
      type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
      style={{ width, accentColor: 'var(--accent)', background: `linear-gradient(90deg, var(--accent) ${pct}%, var(--bg-4) ${pct}%)`, height: 3, borderRadius: 3, appearance: 'none', cursor: 'pointer' }}
    />
  );
}

// ---------------------------------------------------------------- Toggle
export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button type="button" className={`toggle ${on ? 'on' : ''}`} title={title} aria-pressed={on} onClick={() => onChange(!on)} />;
}

// ---------------------------------------------------------------- Select
export function Select<T extends string | number>({ value, options, onChange, width }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; width?: number | string }) {
  return (
    <select className="input" value={String(value)} style={{ width }} onChange={(e) => {
      const o = options.find((x) => String(x.value) === e.target.value);
      if (o) onChange(o.value);
    }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- Colour
const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
export const colorToHex = (c: Color) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
export const hexToColor = (h: string, a = 1): Color => {
  const m = h.replace('#', '');
  const n = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255, a];
};
export const colorCss = (c: Color) => `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})`;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

export function ColorField({ value, onChange, onCommit, alpha = true }: { value: Color; onChange: (c: Color) => void; onCommit?: () => void; alpha?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={ref} className="swatch" onClick={() => setOpen(!open)} title={colorToHex(value)}><i style={{ background: colorCss(value) }} /></span>
      {open && ref.current && (
        <Popover anchor={ref.current} onClose={() => { setOpen(false); onCommit?.(); }}>
          <ColorPicker value={value} onChange={onChange} alpha={alpha} />
        </Popover>
      )}
    </>
  );
}

export function ColorPicker({ value, onChange, alpha = true }: { value: Color; onChange: (c: Color) => void; alpha?: boolean }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(value[0], value[1], value[2]));
  const sv = useRef<HTMLDivElement>(null);
  const emit = (h: number, s: number, v: number, a = value[3]) => { setHsv([h, s, v]); const [r, g, b] = hsvToRgb(h, s, v); onChange([r, g, b, a]); };
  const dragSV = (e: React.PointerEvent) => {
    const r = sv.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    emit(hsv[0], s, v);
  };
  const [hexText, setHexText] = useState(colorToHex(value));
  useEffect(() => setHexText(colorToHex(value)), [value]);
  return (
    <div className="col" style={{ width: 204, gap: 8 }}>
      <div ref={sv} style={{ height: 130, borderRadius: 6, position: 'relative', cursor: 'crosshair', background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]},100%,50%))` }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragSV(e); }}
        onPointerMove={(e) => e.buttons && dragSV(e)}>
        <span style={{ position: 'absolute', left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, width: 10, height: 10, borderRadius: '50%', border: '2px solid #fff', transform: 'translate(-50%,-50%)', boxShadow: '0 0 0 1px #0008' }} />
      </div>
      <input type="range" min={0} max={360} value={hsv[0]} onChange={(e) => emit(Number(e.target.value), hsv[1], hsv[2])}
        style={{ appearance: 'none', height: 10, borderRadius: 5, background: 'linear-gradient(90deg,red,#ff0,lime,cyan,blue,#f0f,red)' }} />
      {alpha && <div className="row"><span className="label" style={{ width: 40 }}>Alpha</span><Slider value={value[3]} min={0} max={1} onChange={(a) => onChange([value[0], value[1], value[2], a])} width={150} /></div>}
      <div className="row">
        <input className="input mono grow" value={hexText} onChange={(e) => setHexText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && /^#?[0-9a-f]{6}$/i.test(hexText)) { const c = hexToColor(hexText, value[3]); setHsv(rgbToHsv(c[0], c[1], c[2])); onChange(c); } e.stopPropagation(); }} />
        <span className="swatch" style={{ width: 28, height: 22 }}><i style={{ background: colorCss(value) }} /></span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {['#101010', '#f4f4f4', '#f28d96', '#eaa4aa', '#ffc0c5', '#e7b46a', '#8fbf9a', '#7fb2e5', '#b29be0', '#000000', '#ffffff'].map((h) => (
          <span key={h} className="swatch" style={{ width: 16, height: 16 }} onClick={() => { const c = hexToColor(h, value[3]); setHsv(rgbToHsv(c[0], c[1], c[2])); onChange(c); }}><i style={{ background: h }} /></span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Popover / Menu
export function Popover({ anchor, onClose, children, placement = 'below' }: { anchor: HTMLElement | { x: number; y: number }; onClose: () => void; children: ReactNode; placement?: 'below' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: -9999, y: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let x: number, y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = placement === 'right' ? r.right + 4 : r.left;
      y = placement === 'right' ? r.top : r.bottom + 4;
    } else { x = anchor.x; y = anchor.y; }
    const w = el.offsetWidth, h = el.offsetHeight;
    x = Math.min(x, window.innerWidth - w - 8);
    y = y + h > window.innerHeight - 8 ? Math.max(8, y - h - (anchor instanceof HTMLElement ? anchor.getBoundingClientRect().height + 8 : 0)) : y;
    setPos({ x: Math.max(8, x), y });
  }, [anchor, placement]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="popover" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>{children}</div>, document.body);
}

export interface MenuItem { label?: string; shortcut?: string; icon?: ReactNode; action?: () => void; disabled?: boolean; separator?: boolean; header?: string; submenu?: MenuItem[]; checked?: boolean }

export function Menu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [sub, setSub] = useState<{ idx: number; el: HTMLElement } | null>(null);
  return (
    <div className="menu" role="menu">
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        if (it.header) return <div key={i} className="menu-head">{it.header}</div>;
        return (
          <div key={i} role="menuitem" className={`menu-item ${it.disabled ? 'disabled' : ''} ${sub?.idx === i ? 'hot' : ''}`}
            onPointerEnter={(e) => setSub(it.submenu ? { idx: i, el: e.currentTarget } : null)}
            onClick={() => { if (it.submenu) return; it.action?.(); onClose(); }}>
            <span style={{ width: 16, display: 'inline-flex', color: 'var(--text-2)' }}>{it.checked ? '✓' : it.icon}</span>
            <span>{it.label}</span>
            {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
            {it.submenu && <ChevronRight size={13} style={{ marginLeft: 'auto', color: 'var(--text-3)' }} />}
          </div>
        );
      })}
      {sub && items[sub.idx]?.submenu && (
        <Popover anchor={sub.el} placement="right" onClose={() => setSub(null)}>
          <Menu items={items[sub.idx].submenu!} onClose={onClose} />
        </Popover>
      )}
    </div>
  );
}

let openMenuSetter: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;
/** Show a context menu at the pointer. */
export function contextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  openMenuSetter?.({ x: e.clientX, y: e.clientY, items });
}
export function ContextMenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => { openMenuSetter = setM; return () => { openMenuSetter = null; }; }, []);
  if (!m) return null;
  return <Popover anchor={{ x: m.x, y: m.y }} onClose={() => setM(null)}><Menu items={m.items} onClose={() => setM(null)} /></Popover>;
}

// ---------------------------------------------------------------- Section / Modal / Search / Keyframe button
export function Section({ title, children, defaultOpen = true, actions, id }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string }) {
  const key = id ? `veyra.section.${id}` : null;
  const [open, setOpen] = useState(() => {
    if (!key) return defaultOpen;
    try { const v = localStorage.getItem(key); return v == null ? defaultOpen : v === '1'; } catch { return defaultOpen; }
  });
  const toggle = () => { setOpen(!open); if (key) try { localStorage.setItem(key, open ? '0' : '1'); } catch { /* storage unavailable */ } };
  return (
    <div className="section">
      <div className="section-head" onClick={toggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="grow">{title}</span>
        <span onClick={(e) => e.stopPropagation()} className="row">{actions}</span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true">
        <div className="modal-head"><span className="grow">{title}</span><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search', autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div className="search grow">
      <SearchIcon size={12} />
      <input className="input" style={{ width: '100%' }} value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </div>
  );
}

export function KeyButton({ animated, atKey, onClick, title }: { animated: boolean; atKey: boolean; onClick: () => void; title?: string }) {
  return (
    <button className={`kf-btn ${animated ? 'on' : ''}`} onClick={onClick} title={title ?? (animated ? 'Add/remove keyframe at playhead (Alt-click: remove all keyframes)' : 'Enable keyframes')}>
      <Diamond size={11} fill={atKey ? 'currentColor' : 'none'} strokeWidth={2} />
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="col" style={{ gap: 4 }}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{hint}</span>}
    </label>
  );
}
