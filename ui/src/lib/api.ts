// Typed wrappers for every backend command (src-tauri/src/commands.rs) and event.
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Asset, Composition, Effect, EffectDef, Layer, Mask, Project, ShapeItem } from '../types/project';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface AppInfo {
  version: string; gpu: string; gpuBackend: string; softwareRender: boolean; gpuError?: string | null;
  ffmpeg?: { ffmpegVersion: string; ffmpegPath: string; encoders: string[]; hwEncoders: string[]; hwDecoders: string[] } | null;
  cpuThreads: number; ramGb: number; freeDiskGb: number; recommendedPreviewScale: number; crashedLastTime: boolean; dataDir: string; cacheDir: string;
}

export interface Settings {
  uiScale: number; reducedMotion: boolean; accentIntensity: number; startup: string; defaultProjectDir: string;
  autosaveEnabled: boolean; autosaveMinutes: number; backupsKept: number; ramCacheMb: number; diskCacheMb: number; cacheDir: string;
  backgroundRender: boolean; previewScale: number; adaptivePreview: boolean; preferResponsiveness: boolean; useProxies: boolean;
  proxyHeight: number; autoProxyAbove: number; hardwareDecode: boolean; hardwareEncode: boolean; cpuThreads: number;
  defaultFps: number; defaultWidth: number; defaultHeight: number; defaultStillDuration: number; defaultTransition: number;
  snapping: boolean; timeDisplay: 'timecode' | 'frames' | 'seconds'; defaultInterpolation: 'linear' | 'bezier' | 'hold';
  motionBlurSamples: number; exportFolder: string; exportPreset: string; blenderPath: string;
  shortcuts: Record<string, string>; workspaces: Record<string, unknown>; activeWorkspace: string; recent: string[];
  lutFolders: string[]; favoriteEffects: string[]; thumbnails: boolean; waveforms: boolean;
  /** Update version the user chose to skip; empty when none. */
  skippedUpdate: string;
}

export interface ExportSettings {
  container: string; codec: string; path: string; width: number; height: number; fps: number; start: number; end: number;
  quality: number; bitrate: number; alpha: boolean; hardware: boolean; bitDepth: number; audio: boolean; audioCodec: string;
  audioBitrate: number; sampleRate: number; channels: number; colorSpace: string; premultiplied: boolean;
}
export interface CodecInfo { id: string; name: string; encoder: string; containers: string[]; alpha: boolean; sequence: boolean; hw: string[]; tenBit: boolean }
export interface Preset { id: string; name: string; group: string; container: string; codec: string; width: number; height: number; fps: number; quality: number; bitrate: number; alpha: boolean; audioCodec: string; audioBitrate: number }
export interface Validation { ok: boolean; errors: string[]; warnings: string[] }
export interface ExportProgress { frame: number; total: number; fps: number; etaSeconds: number; elapsedSeconds: number; bytesWritten: number; estimatedSize: number; stage: string }
export interface ExportReport { path: string; frames: number; seconds: number; fileSize: number; validation: { ok: boolean; duration: number; width: number; height: number; pixFmt: string; codec: string; hasAlpha: boolean; hasAudio: boolean; messages: string[] }; log: string }
export interface Scopes { histogram: number[][]; waveform: number[]; parade: number[]; vectorscope: number[]; cols: number }
export interface CacheStats { frames: number; ramBytes: number; ramBudget: number; diskBytes: number; diskBudget: number; hits: number; misses: number }
export interface Recovery { autosavePath: string; projectPath?: string | null; name: string; time: number }
export interface Opened { project: Project; path: string; missing: string[]; recoveredFrom?: string | null }
export interface TrackResult { frames: [number, [number, number][]][]; confidence: number[]; lostAt?: number | null }
export interface ModelImport { asset: Asset; layers: Layer[]; report: string[] }

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  getSettings: () => call<Settings>('get_settings'),
  setSettings: (settings: Settings) => call<void>('set_settings', { settings }),
  prepareForUpdate: () => call<void>('prepare_for_update'),
  effects: () => call<EffectDef[]>('registry_effects'),
  exportCatalog: () => call<{ codecs: CodecInfo[]; presets: Preset[] }>('export_catalog'),
  fonts: () => call<string[]>('list_fonts'),
  importFont: (path: string) => call<void>('import_font', { path }),
  validateExpression: (src: string) => call<string | null>('validate_expression', { src }),
  expressionErrors: () => call<[string, string][]>('expression_errors'),
  reveal: (path: string) => call<void>('reveal_path', { path }),

  newProject: (opts: { name: string; width: number; height: number; fps: number; duration: number; background?: number[]; transparent?: boolean }) => call<Project>('new_project', { opts }),
  newComposition: (width: number, height: number, fps: number, duration: number, name: string) => call<Composition>('new_composition', { width, height, fps, duration, name }),
  syncProject: (project: Project) => call<number>('sync_project', { project }),
  openProject: (path: string) => call<Opened>('open_project', { path }),
  saveProject: (project: Project, path: string) => call<string>('save_project', { project, path }),
  /** Per-project workspace layout, stored as layout.json in the project folder. */
  readProjectLayout: (projectPath: string) => call<string | null>('read_project_layout', { projectPath }),
  writeProjectLayout: (projectPath: string, json: string) => call<void>('write_project_layout', { projectPath, json }),
  autosave: (project: Project) => call<string>('autosave', { project }),
  listRecovery: () => call<Recovery[]>('list_recovery'),
  recoverProject: (autosavePath: string) => call<Opened>('recover_project', { autosavePath }),
  discardRecovery: (autosavePath: string) => call<void>('discard_recovery', { autosavePath }),
  recentProjects: () => call<{ path: string; name: string; exists: boolean }[]>('recent_projects'),
  relinkMedia: (project: Project, searchDir: string) => call<[Project, number]>('relink_media', { project, searchDir }),
  relinkAsset: (project: Project, assetId: string, newPath: string) => call<Project>('relink_asset', { project, assetId, newPath }),
  collectProject: (project: Project, dir: string) => call<[Project, number]>('collect_project', { project, dir }),

  importMedia: (paths: string[], asSequence = false, existingFingerprints: string[] = []) =>
    call<{ assets: Asset[]; errors: string[]; duplicates: string[] }>('import_media', { paths, asSequence, existingFingerprints }),
  thumbnail: (path: string, time: number, width: number, still: boolean) => call<string>('thumbnail', { path, time, width, still }),
  filmstrip: (assetId: string, path: string, duration: number, count: number) => call<string[]>('filmstrip', { assetId, path, duration, count }),
  waveform: async (assetId: string, path: string) => new Uint8Array(await call<ArrayBuffer>('waveform', { assetId, path })),
  generateProxy: (assetId: string, path: string, duration: number, height: number) => call<string>('generate_proxy', { assetId, path, duration, height }),

  createLayer: (comp: Composition, req: { kind: string; variant?: string; start?: number; text?: string; asset?: Asset; nested?: Composition; color?: number[] }) => call<Layer>('create_layer', { comp, req }),
  createEffect: (kind: string) => call<Effect>('create_effect', { kind }),
  createMask: (kind: string, width: number, height: number) => call<Mask>('create_mask', { kind, width, height }),
  createShapeItem: (kind: string, size: number) => call<ShapeItem>('create_shape_item', { kind, size }),
  makeCompound: (project: Project, compId: string, layerIds: string[], name: string) => call<[Project, string]>('make_compound', { project, compId, layerIds, name }),
  unpackCompound: (project: Project, compId: string, layerId: string) => call<Project>('unpack_compound', { project, compId, layerId }),
  splitLayers: (comp: Composition, layerIds: string[], time: number) => call<Composition>('split_layers', { comp, layerIds, time }),
  rippleDelete: (comp: Composition, layerIds: string[]) => call<Composition>('ripple_delete', { comp, layerIds }),
  shiftKeys: (layer: Layer, dt: number) => call<Layer>('shift_keys', { layer, dt }),
  unparentPreserving: (project: Project, compId: string, layerId: string, time: number) => call<Layer>('unparent_preserving', { project, compId, layerId, time }),
  checkParent: (comp: Composition, child: string, parent: string) => call<boolean>('check_parent', { comp, child, parent }),

  /** Returns {width, height, data: RGBA straight alpha} */
  renderFrame: async (compId: string, time: number, scale: number, draft: boolean) => {
    const buf = await call<ArrayBuffer>('render_frame', { compId, time, scale, draft });
    const dv = new DataView(buf);
    return { width: dv.getUint32(0, true), height: dv.getUint32(4, true), data: new Uint8ClampedArray(buf, 8) };
  },
  prerender: (compId: string, start: number, end: number, scale: number) => call<void>('prerender', { compId, start, end, scale }),
  stopPrerender: () => call<void>('stop_prerender'),
  cachedFrames: (compId: string, scale: number) => call<number[]>('cached_frames', { compId, scale }),
  cacheStats: () => call<CacheStats>('cache_stats'),
  clearCache: () => call<void>('clear_cache'),
  renderWarnings: () => call<string[]>('render_warnings'),
  scopes: (compId: string, time: number, scale: number) => call<Scopes>('scopes', { compId, time, scale }),
  previewAudio: (compId: string) => call<string | null>('preview_audio', { compId }),

  validateExport: (settings: ExportSettings, compId: string) => call<Validation>('validate_export', { settings, compId }),
  startExport: (settings: ExportSettings, compId: string, project: Project, label: string) => call<string>('start_export', { settings, compId, project, label }),
  jobControl: (id: string, action: 'cancel' | 'pause' | 'resume') => call<void>('job_control', { id, action }),
  convertMedia: (src: string, settings: ExportSettings) => call<string>('convert_media', { src, settings }),

  importSubtitles: (comp: Composition, path: string) => call<Layer[]>('import_subtitles', { comp, path }),
  exportInterchange: (project: Project, compId: string, format: 'srt' | 'vtt' | 'otio' | 'edl', path: string) => call<void>('export_interchange', { project, compId, format, path }),
  importModel: (comp: Composition, path: string) => call<ModelImport>('import_model', { comp, path }),
  findBlender: () => call<string | null>('find_blender'),
  importBlend: (comp: Composition, path: string) => call<ModelImport>('import_blend', { comp, path }),
  trackPoints: (req: { asset: string; start: number; end: number; points: [number, number][]; patch: number; search: number; scale: number; backwards?: boolean }) => call<TrackResult>('track_points', { req }),
  activeJobs: () => call<{ id: string; kind: string; label: string }[]>('active_jobs'),

  savePreset: (kind: string, name: string, data: unknown) => call<string>('save_preset', { kind, name, data }),
  listPresets: (kind: string) => call<{ name: string; kind: string; data: unknown }[]>('list_presets', { kind }),
  deletePreset: (kind: string, name: string) => call<void>('delete_preset', { kind, name }),
  importPresetFile: (path: string) => call<unknown>('import_preset_file', { path }),
  listLuts: () => call<string[]>('list_luts'),
};

export const fileSrc = (path: string) => (isTauri ? convertFileSrc(path) : path);

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return listen<T>(event, (e) => cb(e.payload));
}
