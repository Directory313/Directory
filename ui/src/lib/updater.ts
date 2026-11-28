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
  /** Result of the most recent check, shown on the home screen. */
  lastCheck: { at: number; ok: boolean; message: string } | null;
}

export const useUpdater = create<UpdaterState>(() => ({ update: null, phase: 'idle', downloaded: 0, total: 0, error: '', lastCheck: null }));

let checking = false;

/** Looks for a newer version. `manual` (Check for Updates…) reports "up to date" and errors, and
 *  ignores a skipped version; automatic checks stay quiet and only record the result.
 *  Returns false when the check itself failed (offline, GitHub unreachable…). */
export async function checkForUpdates(manual = false): Promise<boolean> {
  if (!isTauri || checking) return true;
  const phase = useUpdater.getState().phase;
  if (phase !== 'idle') return true; // already offering, downloading or installing an update
  const toast = useEditor.getState().toast;
  checking = true;
  try {
    const u = await check({ timeout: 20_000 });
    if (!u) {
      const v = await getVersion();
      useUpdater.setState({ lastCheck: { at: Date.now(), ok: true, message: `Up to date (${v})` } });
      if (manual) toast('success', 'Directory is up to date', `You have the latest version (${v}).`);
      return true;
    }
    useUpdater.setState({ lastCheck: { at: Date.now(), ok: true, message: `Version ${u.version} available` } });
    if (!manual && useEditor.getState().settings?.skippedUpdate === u.version) { void u.close(); return true; }
    useUpdater.setState({ update: u, phase: 'available', error: '' });
    return true;
  } catch (e) {
    useUpdater.setState({ lastCheck: { at: Date.now(), ok: false, message: String(e) } });
    if (manual) toast('error', "Couldn't check for updates", `Check your internet connection and try again.\n${String(e)}`);
    else console.warn('update check failed', e);
    return false;
  } finally {
    checking = false;
  }
}

let autoStarted = false;

/** Automatic checks: shortly after launch (retrying if the network isn't ready yet), then every
 *  few hours while Directory stays open, so a release made while it's running is still offered.
 *  Independent of the rest of start-up, so nothing else failing can stop it. */
export function startAutoUpdateChecks() {
  if (!isTauri || autoStarted) return;
  autoStarted = true;
  const RETRIES = [30_000, 120_000, 600_000];
  const run = async (attempt: number) => {
    // Wait (briefly) for settings so a skipped version is respected.
    for (let i = 0; i < 20 && !useEditor.getState().settings; i++) await new Promise((r) => setTimeout(r, 250));
    const ok = await checkForUpdates(false);
    if (!ok && attempt < RETRIES.length) window.setTimeout(() => void run(attempt + 1), RETRIES[attempt]);
  };
  window.setTimeout(() => void run(0), 3000);
  window.setInterval(() => void checkForUpdates(false), 3 * 60 * 60 * 1000);
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
