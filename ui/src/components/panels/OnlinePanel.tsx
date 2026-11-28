// Library → Online: browse free asset sites inside Directory and drag results straight onto the
// timeline. Starts empty: search, or paste a link from one of the supported sites.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Download, ExternalLink, FolderOpen, Globe, Image as ImageIcon, KeyRound, Link2, Music, Plus, Search, Sun, Video } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { api, isTauri } from '../../lib/api';
import { on } from '../../lib/api';
import { beginPointerDrag, timelineTimeAtX } from '../../lib/pointerDrag';
import { bringIn, KIND_LABEL, MORE_SOURCES, parseLink, PROVIDERS, type OnlineItem, type OnlineKind, type Provider } from '../../lib/online';
import { Toggle } from '../ui/primitives';

const KIND_ICON: Record<OnlineKind, typeof Video> = { video: Video, image: ImageIcon, audio: Music, model: Box, hdri: Sun };
const S = () => useEditor.getState();

export function OnlinePanel() {
  const settings = useEditor((s) => s.settings);
  const [provider, setProvider] = useState<Provider>('polyhaven');
  const info = PROVIDERS.find((p) => p.id === provider)!;
  const [kind, setKind] = useState<OnlineKind>('model');
  const [input, setInput] = useState('');
  const [freeOnly, setFreeOnly] = useState(true);
  const [items, setItems] = useState<OnlineItem[]>([]);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsKey, setNeedsKey] = useState<Provider | null>(null);
  const [searched, setSearched] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const last = useRef<{ provider: Provider; kind: OnlineKind; query: string; id?: string } | null>(null);

  // Keep the type valid for the chosen source.
  useEffect(() => { if (!info.kinds.includes(kind)) setKind(info.kinds[0]); }, [provider]);
  useEffect(() => {
    if (!isTauri) return;
    const un = on<{ key: string; got: number; total: number }>('online-download', ({ key, got, total }) => {
      setProgress((p) => ({ ...p, [key]: total > 0 && got < total ? got / total : -1 }));
    });
    return () => { un.then((f) => f()); };
  }, []);

  const hasKey = (p: Provider) => { const f = PROVIDERS.find((x) => x.id === p)?.keyField; return !f || !!settings?.[f]?.trim(); };

  async function run(req: { provider: Provider; kind: OnlineKind; query: string; id?: string }, page = '', append = false) {
    if (!isTauri) { setError('Online search works in the Directory desktop app.'); return; }
    last.current = req;
    setBusy(true); setError(''); setNeedsKey(null); setSearched(true);
    try {
      const r = await api.onlineSearch(req.provider, req.kind, req.query, page, freeOnly, req.id);
      if (r.needsKey) { setNeedsKey(r.needsKey); setItems([]); setNext(''); return; }
      setItems(append ? [...items, ...r.items] : r.items);
      setNext(r.next);
    } catch (e) { setError(String(e)); if (!append) setItems([]); } finally { setBusy(false); }
  }

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    const link = parseLink(text);
    if (link) {
      setProvider(link.provider);
      setKind(link.kind);
      void run({ provider: link.provider, kind: link.kind, query: link.query ?? '', id: link.id });
      return;
    }
    if (/^https?:\/\//i.test(text)) { setError("That link isn't from a supported site. Supported: Pixabay, Pexels, Sketchfab, Poly Haven, Openverse."); return; }
    void run({ provider, kind, query: text });
  };

  const saveKey = (p: Provider, value: string) => {
    const f = PROVIDERS.find((x) => x.id === p)?.keyField;
    const s = S().settings;
    if (!f || !s) return;
    const nextS = { ...s, [f]: value.trim() };
    S().set({ settings: nextS });
    void api.setSettings(nextS).then(() => { S().toast('success', `${PROVIDERS.find((x) => x.id === p)!.name} key saved`); if (last.current) void run(last.current); });
  };

  return (
    <div className="online">
      <div className="online-bar">
        <div className="online-search">
          <Search size={13} className="muted" />
          <input className="input" placeholder="Search, or paste a link (Pixabay, Pexels, Sketchfab, Poly Haven, Openverse)" value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submit(); }} />
          <button className="btn sm primary" disabled={!input.trim() || busy} onClick={submit}>{busy ? '…' : 'Go'}</button>
        </div>
        <div className="row online-filters">
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)} title="Source">
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}{p.keyField && !hasKey(p.id) ? (p.id === 'sketchfab' ? ' (key needed to download)' : ' (needs key)') : ''}</option>)}
          </select>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as OnlineKind)} title="Type">
            {info.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          {provider === 'sketchfab' && <label className="row muted" title="Only models you can download for free"><Toggle on={freeOnly} onChange={setFreeOnly} /> Free only</label>}
          <span className="grow" />
          <button className="icon-btn sm" title="Open the Downloaded Assets folder" disabled={!isTauri} onClick={async () => api.reveal(await api.onlineFolder())}><FolderOpen size={13} /></button>
        </div>
      </div>

      <div className="online-body">
        {needsKey && <KeyCard provider={needsKey} onSave={saveKey} />}
        {error && <div className="online-error">{error}</div>}
        {!searched && !needsKey && <Welcome hasKey={hasKey} onPick={(p, k, q) => { setProvider(p); setKind(k); setInput(q); void run({ provider: p, kind: k, query: q }); }} onKey={(p) => { setProvider(p); setNeedsKey(p); setSearched(true); }} />}
        {searched && !busy && !error && !needsKey && items.length === 0 && <div className="muted online-empty">Nothing found. Try other words, another source or type.</div>}
        {items.length > 0 && (
          <div className="online-grid">
            {items.map((it) => <Card key={`${it.provider}:${it.id}`} item={it} progress={progress[`${it.provider}:${it.id}`]} />)}
          </div>
        )}
        {next && items.length > 0 && <button className="btn sm online-more" disabled={busy} onClick={() => last.current && void run(last.current, next, true)}>{busy ? 'Loading…' : 'Load more'}</button>}
        {items.length > 0 && <div className="muted online-note">Drag onto the timeline or viewer, or use the buttons. Files are saved in Documents › Directory Projects › Downloaded Assets. Credits are added to the project automatically.</div>}
      </div>
    </div>
  );
}

function Card({ item, progress }: { item: OnlineItem; progress?: number }) {
  const Icon = KIND_ICON[item.kind];
  // Some free assets may only be used in non-commercial videos: say so on the card.
  const nc = /non-?commercial|\bnc\b/i.test(item.license);
  const loading = progress !== undefined && progress !== -1 && progress < 1;
  const meta = [item.width ? `${item.width}×${item.height}` : '', item.duration ? `${Math.round(item.duration)} s` : ''].filter(Boolean).join(' · ');
  return (
    <div className={`online-card ${item.free ? '' : 'paid'}`}
      title={`${item.title}\n${item.author ? `by ${item.author}\n` : ''}${item.license}${item.free ? '\nDrag onto the timeline or viewer to add it.' : '\nNot free to download: opens the website.'}`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        beginPointerDrag(e, {
          label: item.title || item.id, accepts: ['timeline', 'viewer', 'media'],
          onDrop: (d) => void bringIn(item, d.target === 'timeline' ? 'timeline' : d.target === 'viewer' ? 'viewer' : 'media', d.target === 'timeline' ? timelineTimeAtX(d.x) : undefined),
        });
      }}>
      <div className="online-thumb">
        {item.thumb ? <img src={item.thumb} alt="" loading="lazy" draggable={false} /> : <Icon size={22} className="muted" />}
        <span className={`online-badge ${item.free ? (nc ? 'nc' : 'free') : 'paid'}`} title={item.license}>{item.free ? (nc ? 'Free · non-commercial' : 'Free') : 'Paid / view only'}</span>
        {loading && <div className="online-progress"><div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>}
      </div>
      <div className="online-title"><Icon size={11} /> <span>{item.title || item.id}</span></div>
      <div className="online-meta muted">{item.author}{meta ? ` · ${meta}` : ''}</div>
      <div className="online-actions">
        {item.free ? <>
          <button className="btn sm" title="Download and add to the timeline at the playhead" onClick={() => void bringIn(item, 'timeline')}><Plus size={11} /> Timeline</button>
          <button className="icon-btn sm" title="Download into the Media panel" onClick={() => void bringIn(item, 'media')}><Download size={12} /></button>
        </> : <button className="btn sm" onClick={() => void api.openUrl(item.pageUrl)}><ExternalLink size={11} /> View on site</button>}
        <button className="icon-btn sm" title={`Open on ${item.provider} (licence: ${item.license})`} onClick={() => void api.openUrl(item.pageUrl)}><Globe size={12} /></button>
      </div>
    </div>
  );
}

function KeyCard({ provider, onSave }: { provider: Provider; onSave: (p: Provider, v: string) => void }) {
  const info = PROVIDERS.find((p) => p.id === provider)!;
  const current = useEditor((s) => (info.keyField ? s.settings?.[info.keyField] ?? '' : ''));
  const [v, setV] = useState(current);
  return (
    <div className="online-key">
      <div className="row" style={{ fontWeight: 600 }}><KeyRound size={14} /> {info.name} needs a free API key</div>
      <ol>
        <li>{info.keyHelp}</li>
        <li>Paste it here and press Save. It is stored only on this PC.</li>
      </ol>
      <div className="row">
        <button className="btn sm" onClick={() => info.keyUrl && void api.openUrl(info.keyUrl)}><ExternalLink size={11} /> Get a key</button>
        <input className="input grow" placeholder="Paste key" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && v.trim()) onSave(provider, v); }} />
        <button className="btn sm primary" disabled={!v.trim()} onClick={() => onSave(provider, v)}>Save</button>
      </div>
    </div>
  );
}

function Welcome({ hasKey, onPick, onKey }: { hasKey: (p: Provider) => boolean; onPick: (p: Provider, k: OnlineKind, q: string) => void; onKey: (p: Provider) => void }) {
  const ideas = useMemo(() => [
    { p: 'polyhaven' as Provider, k: 'model' as OnlineKind, q: 'chair' }, { p: 'polyhaven' as Provider, k: 'hdri' as OnlineKind, q: 'sunset' },
    { p: 'openverse' as Provider, k: 'image' as OnlineKind, q: 'city at night' }, { p: 'openverse' as Provider, k: 'audio' as OnlineKind, q: 'whoosh' },
  ], []);
  return (
    <div className="online-welcome">
      <div className="online-hint"><Link2 size={14} /> Search above, or paste a link from a supported site, such as a Pixabay search page or a Sketchfab model, to browse it here. Then drag results straight onto the timeline: Directory downloads and imports them for you.</div>
      <div className="lib-head">Sources</div>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="online-source">
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{p.name} <span className="muted" style={{ fontWeight: 400 }}>· {p.kinds.map((k) => KIND_LABEL[k]).join(', ')}</span></div>
            <div className="muted">{p.blurb}</div>
          </div>
          {p.keyField && <button className="btn sm ghost" onClick={() => onKey(p.id)}>{hasKey(p.id) ? 'Key added ✓' : 'Add key'}</button>}
          <button className="icon-btn sm" title={`Open ${p.site}`} onClick={() => void api.openUrl(p.site)}><ExternalLink size={12} /></button>
        </div>
      ))}
      <div className="lib-head">Try</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4, padding: '0 6px' }}>
        {ideas.map((i) => <button key={i.q} className="btn sm ghost" onClick={() => onPick(i.p, i.k, i.q)}>{i.q} · {PROVIDERS.find((x) => x.id === i.p)!.name}</button>)}
      </div>
      <div className="lib-head">More free sites (open in your browser)</div>
      {MORE_SOURCES.map((m) => (
        <button key={m.name} className="lib-item" onClick={() => void api.openUrl(m.url)}><ExternalLink size={12} /><span className="grow">{m.name} <span className="muted">· {m.what}</span></span></button>
      ))}
      <div className="muted online-note">Files you download from those sites can be dragged into Directory from File Explorer.</div>
    </div>
  );
}
