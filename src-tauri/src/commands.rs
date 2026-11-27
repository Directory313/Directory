//! Tauri commands (the UI ↔ engine contract). Mirrored by `ui/src/lib/api.ts`.

use crate::state::*;
use crate::tracking;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use veyra_core::model::*;
use veyra_core::{factory, interop, io as pio, ops, registry};
use veyra_export::formats;
use veyra_media::{probe, tools, Source};
use veyra_render::RenderOptions;

type R<T> = Result<T, String>;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> impl std::future::Future<Output = R<T>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

fn st(app: &AppHandle) -> State<'_, AppState> {
    app.state::<AppState>()
}

// ------------------------------------------------------------------ app / system

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    gpu: String,
    gpu_backend: String,
    software_render: bool,
    gpu_error: Option<String>,
    ffmpeg: Option<tools::Capabilities>,
    cpu_threads: usize,
    ram_gb: f64,
    free_disk_gb: f64,
    recommended_preview_scale: f64,
    crashed_last_time: bool,
    data_dir: String,
    cache_dir: String,
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> R<AppInfo> {
    blocking(move || {
        let s = st(&app);
        let r = s.renderer();
        let caps = s.caps.get_or_init(tools::detect_capabilities).clone();
        let (ram, disk) = crate::sys::memory_and_disk(&s.dirs.cache);
        let (gpu, backend, sw, err) = match &r {
            Ok(r) => (r.gpu.adapter_name.clone(), r.gpu.backend.clone(), r.gpu.software, None),
            Err(e) => (String::new(), String::new(), true, Some(e.clone())),
        };
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let rec = if sw || ram < 8.5 || threads <= 4 { 0.25 } else if ram < 16.5 { 0.5 } else { 1.0 };
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            gpu,
            gpu_backend: backend,
            software_render: sw,
            gpu_error: err,
            ffmpeg: Some(caps),
            cpu_threads: threads,
            ram_gb: ram,
            free_disk_gb: disk,
            recommended_preview_scale: rec,
            crashed_last_time: s.crashed_last_time,
            data_dir: s.dirs.data.to_string_lossy().into(),
            cache_dir: s.dirs.cache.to_string_lossy().into(),
        })
    })
    .await
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: Settings) -> R<()> {
    let ram = settings.ram_cache_mb.clamp(64, 1 << 20) as usize * 1024 * 1024;
    let mut settings = settings;
    settings.settings_version = crate::state::SETTINGS_VERSION;
    let (old_tier, new_tier) = (state.settings.read().disk_cache_tier(&state.dirs.cache), settings.disk_cache_tier(&state.dirs.cache));
    // Reconfiguring wipes the disk tier, so only do it when the cache settings changed.
    if old_tier != new_tier || state.settings.read().ram_cache_mb != settings.ram_cache_mb {
        state.cache.configure(ram, new_tier.as_ref().map(|t| t.0.clone()), new_tier.map_or(0, |t| t.1));
    }
    veyra_media::decode::HW_DECODE.store(settings.hardware_decode, Ordering::Relaxed);
    state.decoders.clear(); // restart decoders with the new decode mode
    *state.settings.write() = settings;
    state.save_settings();
    Ok(())
}

#[tauri::command]
pub fn registry_effects() -> serde_json::Value {
    serde_json::to_value(registry::effects()).unwrap_or_default()
}

#[tauri::command]
pub fn export_catalog() -> serde_json::Value {
    json!({ "codecs": formats::CODECS, "presets": formats::PRESETS })
}

#[tauri::command]
pub async fn list_fonts() -> R<Vec<String>> {
    blocking(|| Ok(veyra_render::raster::font_families())).await
}

#[tauri::command]
pub async fn import_font(path: String) -> R<()> {
    blocking(move || veyra_render::raster::load_font_file(&path)).await
}

#[tauri::command]
pub fn validate_expression(src: String) -> Option<String> {
    veyra_core::expr::validate(&src)
}

#[tauri::command]
pub fn expression_errors() -> Vec<(String, String)> {
    veyra_core::eval::EXPR_ERRORS.lock().map(|mut e| std::mem::take(&mut *e)).unwrap_or_default()
}

/// Called right before the updater installs a new version. The installer closes the app without
/// the normal window-close path, so release what that path would: the session lock (otherwise the
/// next launch reports a crash) and open decoders (file handles).
#[tauri::command]
pub fn prepare_for_update(app: AppHandle) -> R<()> {
    let s = st(&app);
    let _ = std::fs::remove_file(s.dirs.data.join("session.lock"));
    s.decoders.clear();
    s.cache.shutdown();
    Ok(())
}

#[tauri::command]
pub fn reveal_path(path: String) -> R<()> {
    let p = PathBuf::from(&path);
    let mut c = std::process::Command::new("explorer");
    if p.is_file() {
        c.arg(format!("/select,{}", p.display()));
    } else {
        c.arg(p.parent().filter(|_| !p.exists()).unwrap_or(&p));
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ project

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    name: String,
    width: u32,
    height: u32,
    fps: f64,
    duration: f64,
    background: Option<[f64; 4]>,
    transparent: Option<bool>,
}

#[tauri::command]
pub fn new_project(state: State<'_, AppState>, opts: NewProject) -> Project {
    let mut p = Project::new(&opts.name);
    let c = &mut p.compositions[0];
    c.width = opts.width.clamp(16, 16384);
    c.height = opts.height.clamp(16, 16384);
    c.fps = opts.fps.clamp(1.0, 240.0);
    c.duration = opts.duration.max(1.0 / c.fps);
    c.name = "Main".into();
    if let Some(b) = opts.background {
        c.background = b;
    }
    c.transparent = opts.transparent.unwrap_or(false);
    *state.project.write() = p.clone();
    *state.project_path.lock() = None;
    state.revision.fetch_add(1, Ordering::SeqCst);
    p
}

#[tauri::command]
pub fn new_composition(width: u32, height: u32, fps: f64, duration: f64, name: String) -> Composition {
    Composition::new(&name, width.clamp(16, 16384), height.clamp(16, 16384), fps.clamp(1.0, 240.0), duration.max(0.04))
}

/// The UI owns the document and pushes it here after each edit (debounced).
#[tauri::command]
pub fn sync_project(state: State<'_, AppState>, project: Project) -> R<u64> {
    project.check_nesting()?;
    *state.project.write() = project;
    Ok(state.revision.fetch_add(1, Ordering::SeqCst) + 1)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    project: Project,
    path: String,
    missing: Vec<String>,
    recovered_from: Option<String>,
}

fn push_recent(state: &AppState, path: &str) {
    let mut s = state.settings.write();
    s.recent.retain(|p| p != path);
    s.recent.insert(0, path.to_string());
    s.recent.truncate(15);
    drop(s);
    state.save_settings();
}

#[tauri::command]
pub async fn open_project(app: AppHandle, path: String) -> R<Opened> {
    blocking(move || {
        let s = st(&app);
        let p = pio::load(Path::new(&path)).map_err(|e| e.to_string())?;
        let missing = p.assets.iter().filter(|a| a.missing).map(|a| a.name.clone()).collect();
        *s.project.write() = p.clone();
        *s.project_path.lock() = Some(PathBuf::from(&path));
        s.revision.fetch_add(1, Ordering::SeqCst);
        s.decoders.clear();
        push_recent(&s, &path);
        Ok(Opened { project: p, path, missing, recovered_from: None })
    })
    .await
}

#[tauri::command]
pub async fn save_project(app: AppHandle, project: Project, path: String) -> R<String> {
    blocking(move || {
        let s = st(&app);
        let keep = s.settings.read().backups_kept;
        pio::save(&project, Path::new(&path), keep).map_err(|e| e.to_string())?;
        *s.project_path.lock() = Some(PathBuf::from(&path));
        // A successful manual save supersedes the autosave.
        let _ = std::fs::remove_file(s.dirs.autosave.join(format!("{}.veyra", project.id)));
        push_recent(&s, &path);
        Ok(path)
    })
    .await
}

#[tauri::command]
pub async fn autosave(app: AppHandle, project: Project) -> R<String> {
    blocking(move || {
        let s = st(&app);
        let path = s.dirs.autosave.join(format!("{}.veyra", project.id));
        pio::save(&project, &path, 0).map_err(|e| e.to_string())?;
        let meta = json!({ "projectPath": s.project_path.lock().as_ref().map(|p| p.to_string_lossy().to_string()), "name": project.name, "time": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) });
        let _ = std::fs::write(path.with_extension("json"), meta.to_string());
        Ok(path.to_string_lossy().into())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    autosave_path: String,
    project_path: Option<String>,
    name: String,
    time: u64,
}

#[tauri::command]
pub fn list_recovery(state: State<'_, AppState>) -> Vec<Recovery> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&state.dirs.autosave) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "veyra") {
                let meta: serde_json::Value = std::fs::read_to_string(p.with_extension("json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
                out.push(Recovery {
                    autosave_path: p.to_string_lossy().into(),
                    project_path: meta["projectPath"].as_str().map(|s| s.to_string()),
                    name: meta["name"].as_str().unwrap_or("Untitled").to_string(),
                    time: meta["time"].as_u64().unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

#[tauri::command]
pub async fn recover_project(app: AppHandle, autosave_path: String) -> R<Opened> {
    blocking(move || {
        let s = st(&app);
        let mut p = pio::load(Path::new(&autosave_path)).map_err(|e| e.to_string())?;
        let meta: serde_json::Value = std::fs::read_to_string(Path::new(&autosave_path).with_extension("json")).ok().and_then(|x| serde_json::from_str(&x).ok()).unwrap_or_default();
        let orig = meta["projectPath"].as_str().map(|x| x.to_string());
        if let Some(o) = &orig {
            if let Some(dir) = Path::new(o).parent() {
                pio::resolve_media(&mut p, dir);
            }
        }
        let missing = p.assets.iter().filter(|a| a.missing).map(|a| a.name.clone()).collect();
        *s.project.write() = p.clone();
        *s.project_path.lock() = orig.as_ref().map(PathBuf::from);
        s.revision.fetch_add(1, Ordering::SeqCst);
        Ok(Opened { project: p, path: orig.unwrap_or_default(), missing, recovered_from: Some(autosave_path) })
    })
    .await
}

#[tauri::command]
pub fn discard_recovery(autosave_path: String) {
    let p = PathBuf::from(autosave_path);
    let _ = std::fs::remove_file(&p);
    let _ = std::fs::remove_file(p.with_extension("json"));
}

#[tauri::command]
pub fn recent_projects(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    state
        .settings
        .read()
        .recent
        .iter()
        .map(|p| json!({ "path": p, "name": Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), "exists": Path::new(p).exists() }))
        .collect()
}

#[tauri::command]
pub async fn relink_media(app: AppHandle, project: Project, search_dir: String) -> R<(Project, usize)> {
    blocking(move || {
        let mut p = project;
        let n = pio::relink_in_dir(&mut p, Path::new(&search_dir));
        let _ = st(&app);
        Ok((p, n))
    })
    .await
}

#[tauri::command]
pub async fn relink_asset(project: Project, asset_id: String, new_path: String) -> R<Project> {
    blocking(move || {
        let mut p = project;
        let info = probe::probe(&new_path, None).map_err(|e| e.to_string())?;
        let a = p.assets.iter_mut().find(|a| a.id == asset_id).ok_or("asset not found")?;
        a.path = new_path;
        a.info = info;
        a.missing = false;
        Ok(p)
    })
    .await
}

#[tauri::command]
pub async fn collect_project(project: Project, dir: String) -> R<(Project, usize)> {
    blocking(move || {
        let mut p = project;
        let n = pio::collect_media(&mut p, Path::new(&dir)).map_err(|e| e.to_string())?;
        Ok((p, n))
    })
    .await
}

// ------------------------------------------------------------------ media import

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    assets: Vec<Asset>,
    errors: Vec<String>,
    duplicates: Vec<String>,
}

fn import_one(path: &str, as_sequence: bool, fps: f64) -> R<Asset> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("{path}: file not found"));
    }
    let kind = probe::classify(p).ok_or_else(|| format!("{}: unsupported file type", p.file_name().unwrap_or_default().to_string_lossy()))?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut asset = Asset {
        id: new_id(),
        name,
        kind,
        path: path.to_string(),
        relative_path: None,
        info: MediaInfo::default(),
        folder: None,
        tags: vec![],
        favorite: false,
        proxy: None,
        use_proxy: true,
        sequence_pattern: None,
        sequence_start: 0,
        missing: false,
        fingerprint: probe::fingerprint(p),
    };
    match kind {
        AssetKind::Svg => {
            let (w, h) = veyra_render::raster::svg_size(path).ok_or("could not read SVG")?;
            asset.info = MediaInfo { width: w, height: h, has_video: true, has_alpha: true, ..Default::default() };
        }
        AssetKind::Model3d | AssetKind::Lut => {}
        AssetKind::Image if as_sequence => {
            let (pattern, start, count) = probe::detect_sequence(p).ok_or("not part of a numbered image sequence")?;
            let mut info = probe::probe(&pattern, Some((start, fps))).map_err(|e| e.to_string())?;
            info.frame_count = count as u64;
            info.duration = count as f64 / fps;
            info.fps = fps;
            asset.kind = AssetKind::ImageSequence;
            asset.name = format!("{} [{} frames]", Path::new(&pattern).file_name().unwrap_or_default().to_string_lossy(), count);
            asset.sequence_pattern = Some(pattern);
            asset.sequence_start = start;
            asset.info = info;
        }
        _ => {
            asset.info = probe::probe(path, None).map_err(|e| format!("{}: {e}", asset.name))?;
            if kind == AssetKind::Video && !asset.info.has_video && asset.info.has_audio {
                asset.kind = AssetKind::Audio;
            }
            if kind == AssetKind::Video && asset.info.duration <= 0.0 && asset.info.has_video {
                asset.kind = AssetKind::Image;
            }
        }
    }
    Ok(asset)
}

/// Import files in parallel. Emits `import-progress` per file so the UI can show items as
/// they arrive; thumbnails/waveforms are generated lazily afterwards.
#[tauri::command]
pub async fn import_media(app: AppHandle, paths: Vec<String>, as_sequence: bool, existing_fingerprints: Vec<String>) -> R<ImportResult> {
    blocking(move || {
        use rayon::prelude::*;
        let fps = st(&app).settings.read().default_fps;
        // Expand folders.
        let mut files = vec![];
        for p in paths {
            let pb = PathBuf::from(&p);
            if pb.is_dir() {
                if let Ok(rd) = std::fs::read_dir(&pb) {
                    let mut v: Vec<_> = rd.flatten().map(|e| e.path()).filter(|x| x.is_file() && probe::classify(x).is_some()).collect();
                    v.sort();
                    files.extend(v.into_iter().map(|x| x.to_string_lossy().to_string()));
                }
            } else {
                files.push(p);
            }
        }
        let total = files.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let results: Vec<R<Asset>> = files
            .par_iter()
            .map(|f| {
                let r = import_one(f, as_sequence, fps);
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit("import-progress", json!({ "done": n, "total": total, "file": f, "ok": r.is_ok() }));
                r
            })
            .collect();
        let mut out = ImportResult { assets: vec![], errors: vec![], duplicates: vec![] };
        let mut seen_seq = std::collections::HashSet::new();
        for r in results {
            match r {
                Ok(a) => {
                    if let Some(p) = &a.sequence_pattern {
                        if !seen_seq.insert(p.clone()) {
                            continue;
                        }
                    }
                    if !a.fingerprint.is_empty() && existing_fingerprints.contains(&a.fingerprint) {
                        out.duplicates.push(a.name.clone());
                    }
                    out.assets.push(a);
                }
                Err(e) => out.errors.push(e),
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn thumbnail(path: String, time: f64, width: u32, still: bool) -> R<String> {
    blocking(move || {
        if path.to_lowercase().ends_with(".svg") {
            let (w, h) = veyra_render::raster::svg_size(&path).ok_or("bad svg")?;
            let th = (width as f64 * h as f64 / w.max(1) as f64).round() as u32;
            let pm = veyra_render::raster::svg(&path, width, th.max(1)).ok_or("bad svg")?;
            let png = pm.encode_png().map_err(|e| e.to_string())?;
            return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
        }
        let jpg = tools::thumbnail(&path, time, width, still).map_err(|e| e.to_string())?;
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg)))
    })
    .await
}

#[tauri::command]
pub async fn filmstrip(app: AppHandle, asset_id: String, path: String, duration: f64, count: u32) -> R<Vec<String>> {
    blocking(move || {
        let dir = st(&app).dirs.cache.join("filmstrips").join(&asset_id).join(count.to_string());
        let existing: Vec<PathBuf> = (1..=count).map(|i| dir.join(format!("strip_{i:03}.jpg"))).filter(|p| p.exists()).collect();
        let files = if existing.len() as u32 >= count.min(1) && !existing.is_empty() { existing } else { tools::filmstrip(&path, duration, count, 72, &dir).map_err(|e| e.to_string())? };
        Ok(files
            .iter()
            .filter_map(|f| std::fs::read(f).ok())
            .map(|b| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
            .collect())
    })
    .await
}

/// Waveform peaks (0..255 per bucket, 100 buckets/second), cached on disk.
#[tauri::command]
pub async fn waveform(app: AppHandle, asset_id: String, path: String) -> R<tauri::ipc::Response> {
    blocking(move || {
        let cache = st(&app).dirs.cache.join("waveforms").join(format!("{asset_id}.peaks"));
        if let Ok(b) = std::fs::read(&cache) {
            return Ok(tauri::ipc::Response::new(b));
        }
        let peaks = tools::waveform(&path, 100).map_err(|e| e.to_string())?;
        let bytes: Vec<u8> = peaks.iter().map(|p| (p.clamp(0.0, 1.0) * 255.0).round() as u8).collect();
        if let Some(d) = cache.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&cache, &bytes);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub async fn generate_proxy(app: AppHandle, asset_id: String, path: String, duration: f64, height: u32) -> R<String> {
    let job_id = new_id();
    let control = Arc::new(veyra_export::Control::default());
    st(&app).jobs.lock().insert(job_id.clone(), Job { id: job_id.clone(), kind: "proxy".into(), label: format!("Proxy {asset_id}"), control: control.clone() });
    let app2 = app.clone();
    let jid = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dst = st(&app2).dirs.cache.join("proxies").join(format!("{asset_id}_{height}p.mp4"));
        let r = tools::make_proxy(&path, &dst, height, duration, &control.cancel, &|p| {
            let _ = app2.emit("job-progress", json!({ "id": jid, "kind": "proxy", "progress": p }));
        });
        st(&app2).jobs.lock().remove(&jid);
        let _ = match r {
            Ok(()) => app2.emit("proxy-done", json!({ "id": jid, "assetId": asset_id, "proxy": dst.to_string_lossy() })),
            Err(e) => app2.emit("proxy-done", json!({ "id": jid, "assetId": asset_id, "error": e.to_string() })),
        };
    });
    Ok(job_id)
}

// ------------------------------------------------------------------ factories & ops

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerReq {
    kind: String,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    asset: Option<Asset>,
    #[serde(default)]
    nested: Option<Composition>,
    #[serde(default)]
    color: Option<[f64; 4]>,
}

#[tauri::command]
pub fn create_layer(comp: Composition, req: LayerReq) -> R<Layer> {
    let v = req.variant.as_deref().unwrap_or("");
    Ok(match req.kind.as_str() {
        "media" => factory::media_layer(&comp, req.asset.as_ref().ok_or("asset required")?, req.start),
        "solid" => factory::solid_layer(&comp, req.color.unwrap_or([1.0, 1.0, 1.0, 1.0]), req.start),
        "text" => factory::text_layer(&comp, req.text.as_deref().unwrap_or("Your Text"), req.start),
        "shape" => factory::shape_layer(&comp, if v.is_empty() { "rect" } else { v }, req.start),
        "null" => factory::null_layer(&comp, req.start),
        "adjustment" => factory::adjustment_layer(&comp, req.start),
        "camera" => factory::camera_layer(&comp, req.start),
        "light" => factory::light_layer(
            &comp,
            match v {
                "directional" => LightKind::Directional,
                "spot" => LightKind::Spot,
                "area" => LightKind::Area,
                "ambient" => LightKind::Ambient,
                "environment" => LightKind::Environment,
                _ => LightKind::Point,
            },
            req.start,
        ),
        "mesh" => factory::mesh_layer(&comp, if v.is_empty() { "cube" } else { v }, req.start),
        "particles" => factory::particle_layer(&comp, req.start),
        "generator" => factory::generator_layer(
            &comp,
            match v {
                "noise" => GeneratorKind::Noise,
                "wave" => GeneratorKind::Wave,
                "gradient" => GeneratorKind::Gradient,
                "checkerboard" => GeneratorKind::Checkerboard,
                "animatedBackground" => GeneratorKind::AnimatedBackground,
                _ => GeneratorKind::Grid,
            },
            req.start,
        ),
        "comp" => factory::comp_layer(&comp, req.nested.as_ref().ok_or("nested composition required")?, req.start),
        other => return Err(format!("unknown layer kind {other}")),
    })
}

#[tauri::command]
pub fn create_effect(kind: String) -> R<Effect> {
    registry::instantiate(&kind).ok_or_else(|| format!("unknown effect {kind}"))
}

#[tauri::command]
pub fn create_mask(kind: String, width: f64, height: f64) -> Mask {
    factory::mask(&kind, width, height)
}

#[tauri::command]
pub fn create_shape_item(kind: String, size: f64) -> ShapeItem {
    factory::shape_item(factory::geometry(&kind, size), &kind, [1.0, 1.0, 1.0, 1.0])
}

#[tauri::command]
pub fn make_compound(mut project: Project, comp_id: String, layer_ids: Vec<String>, name: String) -> R<(Project, String)> {
    let id = ops::make_compound(&mut project, &comp_id, &layer_ids, &name)?;
    Ok((project, id))
}

#[tauri::command]
pub fn unpack_compound(mut project: Project, comp_id: String, layer_id: String) -> R<Project> {
    ops::unpack_compound(&mut project, &comp_id, &layer_id)?;
    Ok(project)
}

#[tauri::command]
pub fn split_layers(mut comp: Composition, layer_ids: Vec<String>, time: f64) -> Composition {
    for id in layer_ids {
        ops::split_layer(&mut comp, &id, time);
    }
    comp
}

#[tauri::command]
pub fn ripple_delete(mut comp: Composition, layer_ids: Vec<String>) -> Composition {
    ops::ripple_delete(&mut comp, &layer_ids);
    comp
}

#[tauri::command]
pub fn shift_keys(mut layer: Layer, dt: f64) -> Layer {
    ops::shift_layer_keys(&mut layer, dt);
    layer
}

#[tauri::command]
pub fn unparent_preserving(project: Project, comp_id: String, layer_id: String, time: f64) -> R<Layer> {
    let comp = project.comp(&comp_id).ok_or("comp")?;
    let layer = comp.layer(&layer_id).ok_or("layer")?;
    let ctx = veyra_core::eval::EvalCtx::new(&project, comp, time);
    let (pos, scale, rot) = veyra_core::eval::decompose_world(&ctx, layer, time);
    let mut l = layer.clone();
    l.parent = None;
    l.transform.position.value = pos.to_array();
    l.transform.scale.value = scale.to_array();
    l.transform.rotation.value = if l.is_3d { rot.to_array() } else { [0.0, 0.0, rot.z] };
    Ok(l)
}

#[tauri::command]
pub fn check_parent(comp: Composition, child: String, parent: String) -> bool {
    !veyra_core::eval::would_cycle(&comp, &child, &parent)
}

// ------------------------------------------------------------------ rendering / preview

fn render_cached(s: &AppState, comp_id: &str, t: f64, scale: f64, draft: bool) -> R<Arc<veyra_render::Image>> {
    let renderer = s.renderer()?;
    let keys = s.cache_keys(comp_id);
    let key = keys.frame_key(t, scale.to_bits() ^ (draft as u64));
    if let Some(img) = s.cache.get(key) {
        return Ok(img);
    }
    let use_proxies = s.settings.read().use_proxies;
    let p = s.project.read().clone();
    let img = Arc::new(renderer.render(&p, comp_id, t, RenderOptions { scale, use_proxies, draft })?);
    s.cache.put(key, img.clone());
    Ok(img)
}

fn snap_time(s: &AppState, comp_id: &str, t: f64) -> f64 {
    let p = s.project.read();
    match p.comp(comp_id) {
        Some(c) => c.frame_time(c.time_to_frame(t.clamp(0.0, c.duration))),
        None => t,
    }
}

/// Render one frame. Response: [width u32 LE][height u32 LE][rgba bytes].
#[tauri::command]
pub async fn render_frame(app: AppHandle, comp_id: String, time: f64, scale: f64, draft: bool) -> R<tauri::ipc::Response> {
    blocking(move || {
        let s = st(&app);
        let t = snap_time(&s, &comp_id, time);
        let img = render_cached(&s, &comp_id, t, scale.clamp(0.05, 2.0), draft)?;
        let mut out = Vec::with_capacity(img.data.len() + 8);
        out.extend_from_slice(&img.width.to_le_bytes());
        out.extend_from_slice(&img.height.to_le_bytes());
        out.extend_from_slice(&img.data);
        Ok(tauri::ipc::Response::new(out))
    })
    .await
}

/// Pre-render a time range into the frame cache (background pre-rendering and the Render
/// Preview command). A newer request cancels an older one. Stops once the frames rendered fill
/// what the cache can hold, since rendering more would only push out the first ones.
/// Emits `cache-progress` { compId, frames: [cached frame indices] }; the last event also has
/// `done: true`, `rendered` (frames) and `limited` (stopped early because the cache was full).
#[tauri::command]
pub async fn prerender(app: AppHandle, comp_id: String, start: f64, end: f64, scale: f64) -> R<()> {
    let gen = st(&app).prerender_gen.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let s = st(&app);
        let (fps, dur) = {
            let p = s.project.read();
            match p.comp(&comp_id) {
                Some(c) => (c.fps, c.duration),
                None => return,
            }
        };
        let (f0, f1) = ((start.max(0.0) * fps).floor() as u64, (end.min(dur) * fps).ceil() as u64);
        // Leave a tenth of the cache for frames the viewer needs while this runs.
        let room = s.cache.capacity() / 10 * 9;
        let (mut used, mut rendered, mut limited) = (0u64, 0u64, false);
        let mut batch = vec![];
        for f in f0..f1 {
            if s.prerender_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            let t = f as f64 / fps;
            let Ok(img) = render_cached(&s, &comp_id, t, scale, false) else { break };
            used += img.data.len() as u64;
            rendered += 1;
            batch.push(f);
            if batch.len() >= 8 {
                let _ = app.emit("cache-progress", json!({ "compId": comp_id, "frames": std::mem::take(&mut batch) }));
            }
            if used + img.data.len() as u64 > room {
                limited = f + 1 < f1;
                break;
            }
        }
        let _ = app.emit("cache-progress", json!({ "compId": comp_id, "frames": batch, "done": true, "rendered": rendered, "limited": limited }));
    });
    Ok(())
}

#[tauri::command]
pub fn stop_prerender(state: State<'_, AppState>) {
    state.prerender_gen.fetch_add(1, Ordering::SeqCst);
}

/// Which frames of a composition are currently cached at `scale` (for the timeline cache bar).
#[tauri::command]
pub fn cached_frames(state: State<'_, AppState>, comp_id: String, scale: f64) -> Vec<u64> {
    let keys = state.cache_keys(&comp_id);
    let (fps, n) = {
        let p = state.project.read();
        match p.comp(&comp_id) {
            Some(c) => (c.fps, c.frame_count()),
            None => return vec![],
        }
    };
    (0..n.min(200_000)).filter(|f| state.cache.contains(keys.frame_key(*f as f64 / fps, scale.to_bits()))).collect()
}

#[tauri::command]
pub fn cache_stats(state: State<'_, AppState>) -> veyra_render::cache::CacheStats {
    state.cache.stats()
}

#[tauri::command]
pub fn clear_cache(state: State<'_, AppState>) {
    state.cache.clear();
    if let Some(Ok(r)) = state.renderer.get() {
        r.clear_caches();
    }
}

#[tauri::command]
pub fn render_warnings(state: State<'_, AppState>) -> Vec<String> {
    match state.renderer.get() {
        Some(Ok(r)) => std::mem::take(&mut *r.warnings.lock()),
        _ => vec![],
    }
}

#[tauri::command]
pub async fn scopes(app: AppHandle, comp_id: String, time: f64, scale: f64) -> R<veyra_render::color::Scopes> {
    blocking(move || {
        let s = st(&app);
        let t = snap_time(&s, &comp_id, time);
        let img = render_cached(&s, &comp_id, t, scale, true)?;
        Ok(veyra_render::color::scopes(&img.data, img.width, img.height))
    })
    .await
}

/// Render the composition's audio mix to a WAV in the cache for synced preview playback.
#[tauri::command]
pub async fn preview_audio(app: AppHandle, comp_id: String) -> R<Option<String>> {
    blocking(move || {
        let s = st(&app);
        let p = s.project.read().clone();
        let comp = p.comp(&comp_id).ok_or("comp")?;
        let mut clips = vec![];
        veyra_export::audio::collect(&p, comp, 0.0, comp.duration, 0.0, 0.0, 0, &mut clips);
        if clips.is_empty() {
            return Ok(None);
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        use std::hash::{Hash, Hasher};
        format!("{:?}{}", clips, comp.duration).hash(&mut h);
        let out = s.dirs.cache.join("audio").join(format!("{:016x}.wav", h.finish()));
        if !out.exists() {
            veyra_export::job::render_audio(&p, &comp_id, 0.0, comp.duration, comp.sample_rate, comp.channels.min(2), &out)?;
        }
        Ok(Some(out.to_string_lossy().into()))
    })
    .await
}

// ------------------------------------------------------------------ export

#[tauri::command]
pub fn validate_export(state: State<'_, AppState>, settings: formats::ExportSettings, comp_id: String) -> formats::Validation {
    let transparent = state.project.read().comp(&comp_id).map(|c| c.transparent).unwrap_or(false);
    let encoders = state.caps.get().map(|c| c.encoders.clone()).unwrap_or_default();
    formats::validate(&settings, transparent, &encoders)
}

/// Queue an export. Jobs run one at a time in submission order. Events: `export-progress`,
/// `export-done` { id, report | error }.
#[tauri::command]
pub async fn start_export(app: AppHandle, settings: formats::ExportSettings, comp_id: String, project: Project, label: String) -> R<String> {
    let id = new_id();
    let control = Arc::new(veyra_export::Control::default());
    st(&app).jobs.lock().insert(id.clone(), Job { id: id.clone(), kind: "export".into(), label, control: control.clone() });
    let jid = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        static QUEUE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _turn = QUEUE.lock();
        let s = st(&app);
        if control.cancel.load(Ordering::SeqCst) {
            s.jobs.lock().remove(&jid);
            let _ = app.emit("export-done", json!({ "id": jid, "error": "cancelled" }));
            return;
        }
        let res = s.renderer().and_then(|r| {
            let hw = s.hw_encoders();
            veyra_export::job::run(&r, &project, &comp_id, &settings, &hw, &control, &|p| {
                let _ = app.emit("export-progress", json!({ "id": jid, "progress": p }));
            })
        });
        s.jobs.lock().remove(&jid);
        let log_dir = s.dirs.logs.join(format!("export-{jid}.log"));
        let _ = match res {
            Ok(rep) => {
                let _ = std::fs::write(&log_dir, &rep.log);
                app.emit("export-done", json!({ "id": jid, "report": rep, "log": log_dir }))
            }
            Err(e) => {
                let _ = std::fs::write(&log_dir, &e);
                app.emit("export-done", json!({ "id": jid, "error": e, "log": log_dir }))
            }
        };
    });
    Ok(id)
}

#[tauri::command]
pub fn job_control(state: State<'_, AppState>, id: String, action: String) -> R<()> {
    let jobs = state.jobs.lock();
    let j = jobs.get(&id).ok_or("job not found (already finished?)")?;
    match action.as_str() {
        "cancel" => j.control.cancel.store(true, Ordering::SeqCst),
        "pause" => j.control.pause.store(true, Ordering::SeqCst),
        "resume" => j.control.pause.store(false, Ordering::SeqCst),
        _ => return Err("unknown action".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn convert_media(app: AppHandle, src: String, settings: formats::ExportSettings) -> R<String> {
    blocking(move || {
        let hw = st(&app).hw_encoders();
        veyra_export::job::convert_media(&src, &settings, &hw)?;
        Ok(settings.path)
    })
    .await
}

// ------------------------------------------------------------------ interchange

#[tauri::command]
pub fn import_subtitles(comp: Composition, path: String) -> R<Vec<Layer>> {
    let src = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cues = interop::parse_subtitles(&src);
    if cues.is_empty() {
        return Err("no subtitle cues found".into());
    }
    Ok(cues
        .into_iter()
        .map(|c| {
            let mut l = factory::text_layer(&comp, &c.text, c.start);
            l.duration = (c.end - c.start).max(0.1);
            if let LayerKind::Text(tp) = &mut l.kind {
                tp.font_size.value = (comp.height as f64 / 18.0).round();
                tp.background = Some(TextBackground { color: veyra_core::anim::Prop::new([0.0, 0.0, 0.0, 0.55]), padding: 12.0, radius: 8.0 });
            }
            l.transform.position.value = [comp.width as f64 / 2.0, comp.height as f64 * 0.86, 0.0];
            l
        })
        .collect())
}

#[tauri::command]
pub fn export_interchange(project: Project, comp_id: String, format: String, path: String) -> R<()> {
    let comp = project.comp(&comp_id).ok_or("comp")?;
    let data = match format.as_str() {
        "srt" => interop::export_subtitles(comp, false),
        "vtt" => interop::export_subtitles(comp, true),
        "otio" => serde_json::to_string_pretty(&interop::export_otio(&project, comp)).map_err(|e| e.to_string())?,
        "edl" => interop::export_edl(&project, comp),
        _ => return Err("unknown format".into()),
    };
    std::fs::write(path, data).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ 3D / Blender

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImport {
    asset: Asset,
    layers: Vec<Layer>,
    report: Vec<String>,
}

fn gltf_layers(comp: &Composition, asset: &Asset) -> R<(Vec<Layer>, Vec<String>)> {
    let mut layers = vec![];
    let mut report = vec![];
    let path = &asset.path;
    let lower = path.to_lowercase();
    if lower.ends_with(".obj") {
        let mut l = factory::mesh_layer(comp, "cube", 0.0);
        l.name = asset.name.clone();
        l.kind = LayerKind::Mesh(Box::new(MeshProps { primitive: MeshPrimitive::Imported { asset: asset.id.clone(), node: None }, wireframe: false, smooth: true }));
        l.transform.rotation.value = [0.0, 0.0, 0.0];
        layers.push(l);
        return Ok((layers, report));
    }
    let (doc, _, _) = gltf::import(path).map_err(|e| e.to_string())?;
    let scene_scale = comp.height as f64 / 2.0;
    for node in doc.nodes() {
        let name = node.name().unwrap_or("Object").to_string();
        let (t, r, s) = node.transform().decomposed();
        let q = glam::DQuat::from_xyzw(r[0] as f64, r[1] as f64, r[2] as f64, r[3] as f64);
        let (rx, ry, rz) = q.to_euler(glam::EulerRot::XYZ);
        let place = |l: &mut Layer| {
            l.name = name.clone();
            l.is_3d = true;
            l.transform.anchor.value = [0.0, 0.0, 0.0];
            l.transform.position.value = [comp.width as f64 / 2.0 + t[0] as f64 * scene_scale / 2.0, comp.height as f64 / 2.0 - t[1] as f64 * scene_scale / 2.0, t[2] as f64 * scene_scale / 2.0];
            l.transform.rotation.value = [-rx.to_degrees(), -ry.to_degrees(), rz.to_degrees()];
            l.transform.scale.value = [s[0] as f64 * 100.0, s[1] as f64 * 100.0, s[2] as f64 * 100.0];
        };
        if node.mesh().is_some() {
            let mut l = factory::mesh_layer(comp, "cube", 0.0);
            l.kind = LayerKind::Mesh(Box::new(MeshProps { primitive: MeshPrimitive::Imported { asset: asset.id.clone(), node: Some(node.index()) }, wireframe: false, smooth: true }));
            l.name = name.clone();
            // Mesh geometry is baked with its node transform at scene scale.
            l.transform.anchor.value = [0.0, 0.0, 0.0];
            l.transform.rotation.value = [0.0, 0.0, 0.0];
            l.transform.position.value = [comp.width as f64 / 2.0, comp.height as f64 / 2.0, 0.0];
            if let Some(m) = node.mesh().and_then(|m| m.primitives().next()) {
                let pbr = m.material().pbr_metallic_roughness();
                let c = pbr.base_color_factor();
                l.material.base_color.value = [c[0] as f64, c[1] as f64, c[2] as f64, c[3] as f64];
                l.material.metallic.value = pbr.metallic_factor() as f64;
                l.material.roughness.value = pbr.roughness_factor() as f64;
                if pbr.base_color_texture().is_some() {
                    report.push(format!("{name}: base colour texture not transferred (assign an image to the material's Base Texture)"));
                }
            }
            layers.push(l);
        } else if let Some(cam) = node.camera() {
            let mut l = factory::camera_layer(comp, 0.0);
            place(&mut l);
            if let LayerKind::Camera(cp) = &mut l.kind {
                cp.use_point_of_interest = false;
                if let gltf::camera::Projection::Perspective(p) = cam.projection() {
                    cp.zoom.value = comp.height as f64 / 2.0 / (p.yfov() as f64 / 2.0).tan();
                }
            }
            layers.push(l);
        } else if let Some(light) = node.light() {
            let kind = match light.kind() {
                gltf::khr_lights_punctual::Kind::Directional => LightKind::Directional,
                gltf::khr_lights_punctual::Kind::Spot { .. } => LightKind::Spot,
                gltf::khr_lights_punctual::Kind::Point => LightKind::Point,
            };
            let mut l = factory::light_layer(comp, kind, 0.0);
            place(&mut l);
            if let LayerKind::Light(lp) = &mut l.kind {
                let c = light.color();
                lp.color.value = [c[0] as f64, c[1] as f64, c[2] as f64, 1.0];
            }
            layers.push(l);
        }
    }
    if doc.animations().count() > 0 {
        report.push(format!("{} animation clip(s) found: node animation is not yet transferred to VEYRA keyframes", doc.animations().count()));
    }
    if doc.skins().count() > 0 {
        report.push("Skinned/rigged meshes are imported in their rest pose".into());
    }
    Ok((layers, report))
}

#[tauri::command]
pub async fn import_model(comp: Composition, path: String) -> R<ModelImport> {
    blocking(move || {
        let p = Path::new(&path);
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !matches!(ext.as_str(), "glb" | "gltf" | "obj") {
            return Err(format!(".{ext} models are imported through the Blender bridge (glTF/GLB/OBJ load directly)"));
        }
        let asset = Asset {
            id: new_id(),
            name: p.file_name().unwrap_or_default().to_string_lossy().into(),
            kind: AssetKind::Model3d,
            path: path.clone(),
            relative_path: None,
            info: MediaInfo::default(),
            folder: None,
            tags: vec![],
            favorite: false,
            proxy: None,
            use_proxy: false,
            sequence_pattern: None,
            sequence_start: 0,
            missing: false,
            fingerprint: probe::fingerprint(p),
        };
        let (layers, report) = gltf_layers(&comp, &asset)?;
        Ok(ModelImport { asset, layers, report })
    })
    .await
}

#[tauri::command]
pub fn find_blender(state: State<'_, AppState>) -> Option<String> {
    crate::sys::find_blender(&state.settings.read().blender_path)
}

/// Convert a .blend (or FBX/USD/Alembic) via a background Blender process to GLB, then
/// import it like any glTF. Reports anything glTF could not represent.
#[tauri::command]
pub async fn import_blend(app: AppHandle, comp: Composition, path: String) -> R<ModelImport> {
    blocking(move || {
        let s = st(&app);
        let blender = crate::sys::find_blender(&s.settings.read().blender_path).ok_or("Blender was not found. Install Blender (blender.org) or set its location in Settings → Media; VEYRA uses it in the background to convert .blend scenes.")?;
        let script = app.path().resource_dir().map_err(|e| e.to_string())?.join("blender").join("export_scene.py");
        let script = if script.exists() { script } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/blender/export_scene.py") };
        let out_dir = s.dirs.cache.join("blender").join(new_id());
        std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        let glb = out_dir.join(format!("{}.glb", Path::new(&path).file_stem().unwrap_or_default().to_string_lossy()));
        let report_path = out_dir.join("report.json");
        let ext = Path::new(&path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let mut cmd = veyra_media::ffmpeg::command(Path::new(&blender));
        if ext == "blend" {
            cmd.arg("-b").arg(&path).arg("--python").arg(&script).arg("--").arg(&glb).arg(&report_path);
        } else {
            let importer = match ext.as_str() {
                "fbx" => "bpy.ops.import_scene.fbx(filepath=p)",
                "abc" => "bpy.ops.wm.alembic_import(filepath=p)",
                "usd" | "usda" | "usdc" | "usdz" => "bpy.ops.wm.usd_import(filepath=p)",
                _ => return Err(format!("unsupported model format .{ext}")),
            };
            let expr = format!(
                "import bpy,sys; bpy.ops.wm.read_factory_settings(use_empty=True); p=r'''{path}'''; {importer}; sys.argv=['x','--',r'''{}''',r'''{}''']; exec(open(r'''{}''').read())",
                glb.display(),
                report_path.display(),
                script.display()
            );
            cmd.arg("-b").arg("--python-expr").arg(expr);
        }
        let out = cmd.output().map_err(|e| format!("could not run Blender: {e}"))?;
        if !glb.exists() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("Blender conversion failed: {}", err.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
        }
        let rep: serde_json::Value = std::fs::read_to_string(&report_path).ok().and_then(|x| serde_json::from_str(&x).ok()).unwrap_or_default();
        let mut asset_import = {
            let p = glb.to_string_lossy().to_string();
            let asset = Asset {
                id: new_id(),
                name: Path::new(&path).file_name().unwrap_or_default().to_string_lossy().into(),
                kind: AssetKind::Model3d,
                path: p.clone(),
                relative_path: None,
                info: MediaInfo::default(),
                folder: None,
                tags: vec!["blender".into()],
                favorite: false,
                proxy: None,
                use_proxy: false,
                sequence_pattern: None,
                sequence_start: 0,
                missing: false,
                fingerprint: probe::fingerprint(Path::new(&path)),
            };
            let (layers, report) = gltf_layers(&comp, &asset)?;
            ModelImport { asset, layers, report }
        };
        if let Some(u) = rep["untranslated"].as_array() {
            asset_import.report.extend(u.iter().filter_map(|x| x.as_str().map(|s| s.to_string())));
        }
        asset_import.asset.tags.push(format!("source:{path}"));
        Ok(asset_import)
    })
    .await
}

// ------------------------------------------------------------------ tracking

#[tauri::command]
pub async fn track_points(app: AppHandle, req: tracking::TrackRequest) -> R<tracking::TrackResult> {
    let job = new_id();
    let control = Arc::new(veyra_export::Control::default());
    st(&app).jobs.lock().insert(job.clone(), Job { id: job.clone(), kind: "track".into(), label: "Tracking".into(), control: control.clone() });
    let j2 = job.clone();
    let res = blocking(move || {
        let s = st(&app);
        let p = s.project.read().clone();
        let a = p.asset(&req.asset).ok_or("asset not found")?.clone();
        let src = Source::from_asset(&a, false);
        let cancel: &AtomicBool = &control.cancel;
        let r = tracking::track(&s.decoders, &src, a.info.width, a.info.height, &req, cancel, &|pr| {
            let _ = app.emit("job-progress", json!({ "id": j2, "kind": "track", "progress": pr }));
        });
        s.jobs.lock().remove(&j2);
        r
    })
    .await;
    res
}

#[tauri::command]
pub fn active_jobs(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    state.jobs.lock().values().map(|j| json!({ "id": j.id, "kind": j.kind, "label": j.label })).collect()
}

// ------------------------------------------------------------------ presets on disk

#[tauri::command]
pub fn save_preset(state: State<'_, AppState>, kind: String, name: String, data: serde_json::Value) -> R<String> {
    let dir = state.dirs.presets.join(&kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let p = dir.join(format!("{safe}.json"));
    std::fs::write(&p, serde_json::to_vec_pretty(&json!({ "name": name, "kind": kind, "data": data })).unwrap()).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into())
}

#[tauri::command]
pub fn list_presets(state: State<'_, AppState>, kind: String) -> Vec<serde_json::Value> {
    let dir = state.dirs.presets.join(&kind);
    let mut v: Vec<serde_json::Value> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    v
}

#[tauri::command]
pub fn delete_preset(state: State<'_, AppState>, kind: String, name: String) -> R<()> {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    std::fs::remove_file(state.dirs.presets.join(kind).join(format!("{safe}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_preset_file(state: State<'_, AppState>, path: String) -> R<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let kind = v["kind"].as_str().ok_or("not a VEYRA preset file")?.to_string();
    let name = v["name"].as_str().unwrap_or("Imported").to_string();
    save_preset(state, kind, name, v["data"].clone())?;
    Ok(v)
}

#[tauri::command]
pub fn list_luts(state: State<'_, AppState>) -> Vec<String> {
    let folders = state.settings.read().lut_folders.clone();
    let mut out = vec![];
    for f in folders {
        if let Ok(rd) = std::fs::read_dir(&f) {
            out.extend(rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("cube"))).map(|p| p.to_string_lossy().to_string()));
        }
    }
    out
}

// ---------------------------------------------------------------- per-project workspace layout

fn layout_file(project_path: &str) -> R<PathBuf> {
    let p = Path::new(project_path);
    let dir = p.parent().ok_or_else(|| "project has no folder".to_string())?;
    Ok(dir.join("layout.json"))
}

/// The workspace layout saved next to a project (`<project folder>/layout.json`), if any.
#[tauri::command]
pub fn read_project_layout(project_path: String) -> R<Option<String>> {
    let f = layout_file(&project_path)?;
    Ok(std::fs::read_to_string(f).ok())
}

/// Save the workspace layout for a project. Layouts never leak between projects.
#[tauri::command]
pub fn write_project_layout(project_path: String, json: String) -> R<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let f = layout_file(&project_path)?;
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}
