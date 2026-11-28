// In-app drag & drop built on pointer events. The desktop app keeps the WebView's file drop
// enabled (dragging files in from Explorer gives us their paths), and on Windows that disables
// HTML5 drag & drop inside the page. So every in-app drag (media, library items, online assets)
// uses this instead: a ghost label follows the pointer and the drop target is found under it.

export interface DropInfo {
  /** `data-drop` area under the pointer ('timeline', 'viewer', 'media'…), or null. */
  target: string | null;
  x: number;
  y: number;
  /** Element under the pointer (e.g. to find a timeline clip via [data-layer]). */
  el: HTMLElement | null;
}

export function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
}

function highlight(target: string | null) {
  document.querySelectorAll<HTMLElement>('[data-drop]').forEach((el) => el.classList.toggle('drop-hot', el.dataset.drop === target));
}

/** Call from onPointerDown. A drag starts once the pointer moves a few pixels; a plain click is
 *  left alone. `accepts` limits which areas light up / receive the drop. */
export function beginPointerDrag(e: React.PointerEvent, opts: { label: string; accepts: string[]; onDrop: (d: DropInfo) => void }) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let over: string | null = null;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = opts.label;
      document.body.appendChild(ghost);
      document.body.classList.add('dragging-items');
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
    const t = dropTargetAt(ev.clientX, ev.clientY);
    // '*' accepts anywhere (the caller decides from the element under the pointer).
    const ok = opts.accepts.includes('*') ? (t ?? '*') : t && opts.accepts.includes(t) ? t : null;
    if (ok !== over) { over = ok; highlight(ok); }
    ghost.classList.toggle('ok', !!ok);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!ghost) return; // it was a click
    ghost.remove();
    document.body.classList.remove('dragging-items');
    highlight(null);
    // Swallow the click the browser fires after the pointer is released.
    const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
    if (ev.type === 'pointercancel' || !over) return;
    opts.onDrop({ target: over, x: ev.clientX, y: ev.clientY, el: document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

// The timeline registers how to turn a screen x into a time, so drops land under the pointer.
let timelineTimeAt: ((clientX: number) => number) | null = null;
export function registerTimelineDrop(fn: ((clientX: number) => number) | null) { timelineTimeAt = fn; }
export function timelineTimeAtX(clientX: number): number | undefined { return timelineTimeAt?.(clientX); }
