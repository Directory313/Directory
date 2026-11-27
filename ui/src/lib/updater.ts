// In-app updates. Directory checks the latest GitHub release (see plugins.updater in
// src-tauri/tauri.conf.json) and, when a newer signed version exists, the UpdateDialog offers it.
// Installing replaces the installed files; on Windows the app closes and the installer reopens it.
import { create } from 'zustand';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { api, isTauri } from './api';
import { useEditor } from '../store/editor';

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'installing' | 'error';

/** The parts of the plugin's Update object the dialog uses (lets the dev preview pass a stand-in). */
export type PendingUpdate = Pick<Update, 'version' | 'currentVersion' | 'body' | 'download' | 'install' | 'close'>;

interface UpdaterState {
  update: PendingUpdate | null;
  phase: UpdatePhase;
  downloaded: number;
  total: number;
  error: string;
}

export const useUpdater = create<UpdaterState>(() => ({ update: null, phase: 'idle', downloaded: 0, total: 0, error: '' }));

let checking = false;

/** Looks for a newer version. `manual` (Check for Updates…) reports "up to date" and errors, and
 *  ignores a skipped version; the automatic check at launch stays silent. */
export async function checkForUpdates(manual = false) {
  if (!isTauri || checking) return;
  const phase = useUpdater.getState().phase;
  if (phase === 'downloading' || phase === 'installing') return;
  const toast = useEditor.getState().toast;
  checking = true;
  try {
    const u = await check({ timeout: 20_000 });
    if (!u) {
      if (manual) toast('success', 'Directory is up to date', `You have the latest version (${await getVersion()}).`);
      return;
    }
    if (!manual && useEditor.getState().settings?.skippedUpdate === u.version) { void u.close(); return; }
    useUpdater.setState({ update: u, phase: 'available', error: '' });
  } catch (e) {
    if (manual) toast('error', "Couldn't check for updates", `Check your internet connection and try again.\n${String(e)}`);
    else console.warn('update check failed', e);
  } finally {
    checking = false;
  }
}

/** Closes the dialog; the update is offered again at the next launch. */
export function dismissUpdate() {
  const { update } = useUpdater.getState();
  useUpdater.setState({ update: null, phase: 'idle', error: '' });
  void update?.close().catch(() => {});
}

/** Stops offering this version at launch (Check for Updates… still finds it). */
export function skipUpdate() {
  const { update } = useUpdater.getState();
  const s = useEditor.getState();
  if (update && s.settings) {
    const next = { ...s.settings, skippedUpdate: update.version };
    s.set({ settings: next });
    void api.setSettings(next).catch(() => {});
  }
  dismissUpdate();
}

/** Downloads, verifies (signature checked by the plugin) and installs. Save the project first. */
export async function installUpdate() {
  const { update } = useUpdater.getState();
  if (!update) return;
  useUpdater.setState({ phase: 'downloading', downloaded: 0, total: 0, error: '' });
  let got = 0;
  let last = 0;
  try {
    await update.download((ev) => {
      if (ev.event === 'Started') useUpdater.setState({ total: ev.data.contentLength ?? 0 });
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        const now = performance.now();
        if (now - last > 100) { last = now; useUpdater.setState({ downloaded: got }); }
      } else useUpdater.setState({ downloaded: got });
    });
    useUpdater.setState({ phase: 'installing', downloaded: got });
    await api.prepareForUpdate().catch(() => {});
    await update.install(); // Windows: the app exits here and the installer reopens it.
  } catch (e) {
    useUpdater.setState({ phase: 'error', error: String(e) });
  }
}
