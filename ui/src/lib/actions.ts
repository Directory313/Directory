// Command registry: every user action (menus, shortcuts, command palette) is registered here.
// Panels register their actions with `registerActions` at module load.
import { useEditor } from '../store/editor';

export interface Action {
  id: string;
  label: string;
  group: string;
  /** Default shortcut, e.g. "Ctrl+S", "Shift+D", "Space", "Alt+[". */
  shortcut?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
}

const registry = new Map<string, Action>();

export function registerActions(list: Action[]) {
  for (const a of list) registry.set(a.id, a);
}

export function allActions(): Action[] {
  return Array.from(registry.values());
}

export function runAction(id: string) {
  const a = registry.get(id);
  if (!a || (a.enabled && !a.enabled())) return false;
  Promise.resolve(a.run()).catch((e) => useEditor.getState().toast('error', `${a.label} failed`, String(e)));
  return true;
}

export function shortcutFor(id: string): string | undefined {
  const custom = useEditor.getState().settings?.shortcuts?.[id];
  return custom ?? registry.get(id)?.shortcut;
}

export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return parts.join('+');
  parts.push(k);
  return parts.join('+');
}

/** Global keyboard dispatch. Ignored while typing in inputs. */
export function handleShortcut(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  const combo = eventToShortcut(e);
  for (const a of registry.values()) {
    if (shortcutFor(a.id) === combo) {
      if (a.enabled && !a.enabled()) continue;
      e.preventDefault();
      runAction(a.id);
      return true;
    }
  }
  return false;
}
