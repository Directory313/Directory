import { useState } from 'react';
import { ChevronDown, ChevronRight, Link2Off } from 'lucide-react';
import { useComp, useEditor } from '../../store/editor';
import { setParent } from '../../lib/ops';
import type { Layer } from '../../types/project';

/** Parent–child hierarchy: drag a layer onto another to parent it; drop on the root to unparent. */
export function HierarchyPanel() {
  const comp = useComp();
  const sel = useEditor((s) => s.selectedLayers);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  if (!comp) return <div className="panel"><div className="empty">No composition</div></div>;
  const kids = (id: string | null) => comp.layers.filter((l) => (l.parent ?? null) === id || (id === null && l.parent && !comp.layers.some((p) => p.id === l.parent)));
  const node = (l: Layer, depth: number): React.ReactNode => {
    const children = kids(l.id);
    return (
      <div key={l.id}>
        <div
          className={`tree-row ${sel.includes(l.id) ? 'sel' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} draggable
          onDragStart={(e) => { setDragId(l.id); e.dataTransfer.setData('text/plain', l.id); }}
          onDragOver={(e) => { if (dragId && dragId !== l.id) e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragId && dragId !== l.id) setParent([dragId], l.id); setDragId(null); }}
          onClick={(e) => useEditor.getState().select([l.id], e.ctrlKey)}
        >
          {children.length ? (
            <button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [l.id]: !c[l.id] })); }}>{collapsed[l.id] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</button>
          ) : <span style={{ width: 20 }} />}
          <span className={`tree-kind ${l.kind.type}`}>{l.kind.type}</span>
          <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
          {l.is3d && <span className="pill">3D</span>}
          {l.parent && <button className="icon-btn sm" title="Unparent (keeps world position)" onClick={(e) => { e.stopPropagation(); setParent([l.id], null); }}><Link2Off size={11} /></button>}
        </div>
        {!collapsed[l.id] && children.map((c) => node(c, depth + 1))}
      </div>
    );
  };
  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Hierarchy — drag onto a layer to parent</span></div>
      <div className="panel-body"
        onDragOver={(e) => dragId && e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (dragId) setParent([dragId], null); setDragId(null); }}>
        {comp.layers.length === 0 ? <div className="empty">No layers</div> : kids(null).map((l) => node(l, 0))}
      </div>
    </div>
  );
}
