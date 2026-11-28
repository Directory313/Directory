// Online asset sources (Library → Online): provider info, link parsing, and download + import.
import { api } from './api';
import { useEditor } from '../store/editor';
import { importPaths } from '../components/shell/dragdrop';

export type Provider = 'pixabay' | 'pexels' | 'sketchfab' | 'polyhaven' | 'openverse';
export type OnlineKind = 'video' | 'image' | 'audio' | 'model' | 'hdri';

export interface OnlineItem {
  provider: Provider; id: string; kind: OnlineKind; title: string; author: string; license: string; licenseUrl: string;
  thumb: string; pageUrl: string; free: boolean; width: number; height: number; duration: number; download: string; ext: string;
}
export interface SearchResult { items: OnlineItem[]; total: number; needsKey?: Provider | null; next: string }

export interface ProviderInfo {
  id: Provider; name: string; kinds: OnlineKind[]; site: string;
  /** Settings field holding its key; undefined when no key is needed. */
  keyField?: 'pixabayKey' | 'pexelsKey' | 'sketchfabToken';
  keyUrl?: string; keyHelp?: string; blurb: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'polyhaven', name: 'Poly Haven', kinds: ['model', 'hdri', 'image'], site: 'https://polyhaven.com', blurb: '3D models, HDRIs and textures. Everything is CC0 (free for any use). No key needed.' },
  { id: 'openverse', name: 'Openverse', kinds: ['image', 'audio'], site: 'https://openverse.org', blurb: 'Millions of Creative Commons photos and sounds. No key needed. Check each licence: some need a credit.' },
  { id: 'pixabay', name: 'Pixabay', kinds: ['video', 'image'], site: 'https://pixabay.com', keyField: 'pixabayKey', keyUrl: 'https://pixabay.com/api/docs/', keyHelp: 'Sign in to Pixabay (free), open the API page and copy "Your API key", shown in green under Parameters.', blurb: 'Free stock videos and photos. Needs a free API key.' },
  { id: 'pexels', name: 'Pexels', kinds: ['video', 'image'], site: 'https://www.pexels.com', keyField: 'pexelsKey', keyUrl: 'https://www.pexels.com/api/new/', keyHelp: 'Sign in to Pexels (free), request an API key (describe Directory as a personal video editor) and copy it.', blurb: 'Free stock videos and photos. Needs a free API key.' },
  { id: 'sketchfab', name: 'Sketchfab', kinds: ['model'], site: 'https://sketchfab.com', keyField: 'sketchfabToken', keyUrl: 'https://sketchfab.com/settings/password', keyHelp: 'Sign in to Sketchfab (free), go to Settings → Password & API and copy the "API Token". Searching works without it; downloading needs it.', blurb: '3D models. Free downloadable models only when "Free only" is on; paid ones open the store page.' },
];

/** Other good free sites that have no public API: opened in the browser. */
export const MORE_SOURCES: { name: string; url: string; what: string }[] = [
  { name: 'Mixkit', url: 'https://mixkit.co', what: 'Videos, music, sound effects, templates' },
  { name: 'Coverr', url: 'https://coverr.co', what: 'Stock videos' },
  { name: 'Videvo', url: 'https://www.videvo.net', what: 'Stock videos and motion graphics (filter for free)' },
  { name: 'Freesound', url: 'https://freesound.org', what: 'Sound effects (Creative Commons)' },
  { name: 'Free Music Archive', url: 'https://freemusicarchive.org', what: 'Music (check each licence)' },
  { name: 'Unsplash', url: 'https://unsplash.com', what: 'Photos' },
  { name: 'ambientCG', url: 'https://ambientcg.com', what: 'CC0 textures, HDRIs and 3D models' },
];

export const KIND_LABEL: Record<OnlineKind, string> = { video: 'Videos', image: 'Photos', audio: 'Audio', model: '3D models', hdri: 'HDRIs' };

/** Understand a pasted link: which source, what kind, and either a search or one asset. */
export function parseLink(raw: string): { provider: Provider; kind: OnlineKind; query?: string; id?: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const tailId = (seg?: string) => seg?.match(/(\d+)\/?$/)?.[1];
  if (host.endsWith('pixabay.com')) {
    const kind: OnlineKind = parts[0] === 'videos' ? 'video' : 'image';
    const si = parts.indexOf('search');
    if (si >= 0) return { provider: 'pixabay', kind, query: (parts[si + 1] ?? u.searchParams.get('q') ?? '').replace(/[-+]/g, ' ') };
    const id = tailId(parts[1]);
    if (id) return { provider: 'pixabay', kind, id };
    return { provider: 'pixabay', kind, query: u.searchParams.get('q') ?? '' };
  }
  if (host.endsWith('pexels.com')) {
    if (parts[0] === 'search') {
      const video = parts[1] === 'videos';
      return { provider: 'pexels', kind: video ? 'video' : 'image', query: (video ? parts[2] : parts[1] ?? '').replace(/[-+]/g, ' ') };
    }
    if (parts[0] === 'video' || parts[0] === 'photo') { const id = tailId(parts[1]); if (id) return { provider: 'pexels', kind: parts[0] === 'video' ? 'video' : 'image', id }; }
    return null;
  }
  if (host.endsWith('sketchfab.com')) {
    if (parts[0] === '3d-models' && parts[1]) { const uid = parts[1].match(/([0-9a-f]{32})$/)?.[1]; if (uid) return { provider: 'sketchfab', kind: 'model', id: uid }; }
    if (parts[0] === 'models' && parts[1]) return { provider: 'sketchfab', kind: 'model', id: parts[1] };
    return { provider: 'sketchfab', kind: 'model', query: u.searchParams.get('q') ?? (parts[0] === 'tags' ? parts[1] ?? '' : '') };
  }
  if (host.endsWith('polyhaven.com')) {
    if (parts[0] === 'a' && parts[1]) return { provider: 'polyhaven', kind: 'model', id: parts[1] };
    const kind: OnlineKind = parts[0] === 'hdris' ? 'hdri' : parts[0] === 'textures' ? 'image' : 'model';
    return { provider: 'polyhaven', kind, query: u.searchParams.get('s') ?? parts[1] ?? '' };
  }
  if (host.endsWith('openverse.org')) {
    const kind: OnlineKind = parts.includes('audio') ? 'audio' : 'image';
    return { provider: 'openverse', kind, query: u.searchParams.get('q') ?? '' };
  }
  return null;
}

const S = () => useEditor.getState();

/** Download an asset, import it, and optionally put it on the timeline at `at` seconds. Adds a
 *  credit line (title, author, licence, link) to the project's credits. */
export async function bringIn(item: OnlineItem, target: 'media' | 'timeline' | 'viewer', at?: number) {
  if (!item.free) { void api.openUrl(item.pageUrl); return; }
  const s = S();
  s.toast('info', `Downloading “${item.title || item.id}”…`, `${item.provider} · ${item.license}`);
  let path: string;
  try {
    path = await api.onlineDownload(item);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('NEEDS_KEY:sketchfab')) { s.toast('warning', 'Add your Sketchfab API token to download models', 'Library → Online → Sketchfab → Add key.'); return; }
    s.toast('error', 'Download failed', msg);
    return;
  }
  await importPaths([path], target === 'media' ? null : target, at);
  const credit = `${item.title || item.id}: ${item.author || 'unknown'} · ${item.license} · ${item.pageUrl}`;
  S().edit('Add Credit', (d) => {
    const lines = (d.meta.credits ?? '').split('\n').filter(Boolean);
    if (!lines.includes(credit)) d.meta.credits = [...lines, credit].join('\n');
  });
}
