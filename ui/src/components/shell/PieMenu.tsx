// Blender-style pie menu (Alt+Z): a ring of workspaces around the mouse. Move toward a slice to
// highlight it, then click, or let go of Z to switch. Esc or a click in the middle closes it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registerActions } from '../../lib/actions';
import { useEditor } from '../../store/editor';
import { WORKSPACE_NAMES } from './workspaces';
import { setWorkspace } from './EditorShell';

let mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; }, { passive: true });

let openPie: (() => void) | null = null;
registerActions([{ id: 'workspace.pie', label: 'Workspace Pie Menu', group: 'Window', shortcut: 'Alt+Z', run: () => openPie?.() }]);

const R = 128;      // radius of the ring of labels
const DEAD = 22;    // no slice is picked inside this circle

export function PieMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [hot, setHot] = useState(-1);
  const hotRef = useRef(-1);
  const moved = useRef(false);
  const current = useEditor((s) => s.workspace);
  const custom = useEditor((s) => s.settings?.workspaces);
  const names = [...WORKSPACE_NAMES, ...Object.keys(custom ?? {}).filter((n) => !WORKSPACE_NAMES.includes(n))];

  useEffect(() => {
    openPie = () => {
      // Keep the whole ring on screen.
      const x = Math.min(Math.max(mouse.x, R + 70), window.innerWidth - R - 70);
      const y = Math.min(Math.max(mouse.y, R + 30), window.innerHeight - R - 30);
      moved.current = false;
      hotRef.current = -1;
      setHot(-1);
      setAt({ x, y });
    };
    return () => { openPie = null; };
  }, []);

  useEffect(() => {
    if (!at) return;
    const n = names.length;
    const pick = (i: number) => { setAt(null); if (i >= 0 && names[i]) setWorkspace(names[i]); };
    const move = (e: PointerEvent) => {
      const dx = e.clientX - at.x, dy = e.clientY - at.y;
      if (Math.hypot(dx, dy) < DEAD) { hotRef.current = -1; setHot(-1); return; }
      moved.current = true;
      // Slice 0 is at the top; slices go clockwise.
      const a = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      const i = Math.round(a / ((Math.PI * 2) / n)) % n;
      hotRef.current = i;
      setHot(i);
    };
    const down = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      // The click that follows must not reach whatever is under the menu.
      const swallow = (c: MouseEvent) => { c.preventDefault(); c.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
      pick(hotRef.current);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setAt(null); }
    };
    // Releasing Z after moving toward a slice picks it (hold-and-flick, like Blender).
    const keyUp = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'z' && moved.current && hotRef.current >= 0) pick(hotRef.current); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', keyUp, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', keyUp, true);
    };
  }, [at, names.join('|')]);

  if (!at) return null;
  const n = names.length;
  return createPortal(
    <div className="pie-root">
      <svg className="pie-svg" style={{ left: at.x - R - 70, top: at.y - R - 70, width: (R + 70) * 2, height: (R + 70) * 2 }}>
        <circle cx={R + 70} cy={R + 70} r={DEAD} className="pie-center" />
        {hot >= 0 && (() => {
          const a = (hot / n) * Math.PI * 2 - Math.PI / 2;
          return <line x1={R + 70} y1={R + 70} x2={R + 70 + Math.cos(a) * (R - 34)} y2={R + 70 + Math.sin(a) * (R - 34)} className="pie-ray" />;
        })()}
      </svg>
      {names.map((name, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        return (
          <div key={name} className={`pie-item ${i === hot ? 'hot' : ''} ${name === current ? 'current' : ''}`}
            style={{ left: at.x + Math.cos(a) * R, top: at.y + Math.sin(a) * R }}>
            {name}
          </div>
        );
      })}
      <div className="pie-title" style={{ left: at.x, top: at.y + R + 44 }}>Workspace · move toward one and click (or let go of Z) · Esc to close</div>
    </div>,
    document.body,
  );
}
