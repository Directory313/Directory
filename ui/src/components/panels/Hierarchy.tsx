import { useState } from 'react';
import { ChevronDown, ChevronRight, Link2Off } from 'lucide-react';
import { useComp, useEditor } from '../../store/editor';
import { setParent } from '../../lib/ops';
import type { Layer } from '../../types/project';
import { beginPointerDrag } from '../../lib/pointerDrag';

/** Parent–child hierarchy: drag a layer onto another to parent it; drop on the root to unparent. */
export function HierarchyPanel() {
  const comp = useComp();
  const sel = useEditor((s) => s.selectedLayers);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!comp) return <div className="panel"><div className="empty">No composition</div></div>;
  const kids = (id: string | null) => comp.layers.filter((l) => (l.parent ?? null) === id || (id === null && l.parent && !comp.layers.some((p) => p.id === l.parent)));
  const node = (l: Layer, depth: number): React.ReactNode => {
    const children = kids(l.id);
    return (
      <div key={l.id}>
        <div
          className={`tree-row ${sel.includes(l.id) ? 'sel' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} data-tree-id={l.id}
          onPointerDown={(e) => beginPointerDrag(e, {
            label: `Parent “${l.name}” to…`, accepts: ['*'],
            onDrop: (d) => {
              const onto = d.el?.closest<HTMLElement>('[data-tree-id]')?.dataset.treeId;
              if (onto && onto !== l.id) setParent([l.id], onto);
              else if (!onto && d.el?.closest('.tree-body')) setParent([l.id], null); // empty space: unparent
            },
          })}
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
      <div className="panel-body tree-body">
        {comp.layers.length === 0 ? <div className="empty">No layers</div> : kids(null).map((l) => node(l, 0))}
      </div>
    </div>
  );
}
