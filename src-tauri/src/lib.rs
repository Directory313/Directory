//! VEYRA desktop application (Tauri 2 shell around the Rust engines).

mod commands;
mod state;
mod sys;
mod tracking;

use parking_lot::{Mutex, RwLock};
use state::*;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, OnceLock};
use tauri::Manager;

pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,wgpu_hal=warn,wgpu_core=warn,naga=warn")).try_init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            migrate_from_veyra(&data);
            let cache = app.path().app_local_data_dir()?.join("cache");
            let dirs = Dirs { autosave: data.join("autosave"), presets: data.join("presets"), logs: data.join("logs"), cache: cache.clone(), data: data.clone() };
            for d in [&dirs.data, &dirs.cache, &dirs.autosave, &dirs.presets, &dirs.logs] {
                std::fs::create_dir_all(d)?;
            }
            if let Ok(res) = app.path().resource_dir() {
                veyra_media::ffmpeg::set_resource_dir(res);
            }
            // Crash detection: a lock file that survives means the last session did not exit cleanly.
            let lock = data.join("session.lock");
            let crashed = lock.exists();
            let _ = std::fs::write(&lock, std::process::id().to_string());
            let mut settings: Settings = std::fs::read_to_string(data.join("settings.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let migrated = migrate_settings(&mut settings);
            veyra_media::decode::HW_DECODE.store(settings.hardware_decode, std::sync::atomic::Ordering::Relaxed);
            if settings.cpu_threads > 0 {
                let _ = rayon::ThreadPoolBuilder::new().num_threads(settings.cpu_threads).build_global();
            }
            // Rendered frames live in RAM; the disk tier is only used when turned on in Settings.
            // Either way, frames left on disk by an earlier session (stale keys) are deleted.
            let frame_cache = Arc::new(veyra_render::cache::FrameCache::new(settings.ram_cache_mb as usize * 1024 * 1024));
            frame_cache.set_free_space_guard(DISK_CACHE_MIN_FREE, sys::free_bytes);
            let default_frames = if settings.cache_dir.is_empty() { cache.join("frames") } else { std::path::PathBuf::from(&settings.cache_dir).join("frames") };
            let _ = std::fs::remove_dir_all(&default_frames);
            let tier = settings.disk_cache_tier(&cache);
            frame_cache.configure(settings.ram_cache_mb as usize * 1024 * 1024, tier.as_ref().map(|t| t.0.clone()), tier.map_or(0, |t| t.1));
            let st = AppState {
                project: RwLock::new(veyra_core::model::Project::new("Untitled")),
                revision: AtomicU64::new(1),
                project_path: Mutex::new(None),
                renderer: OnceLock::new(),
                decoders: Arc::new(veyra_media::DecoderPool::default()),
                cache: frame_cache,
                keys: Mutex::new(None),
                jobs: Mutex::new(Default::default()),
                settings: RwLock::new(settings),
                caps: OnceLock::new(),
                dirs,
                crashed_last_time: crashed,
                prerender_gen: AtomicU64::new(0),
            };
            app.manage(st);
            if migrated {
                app.state::<AppState>().save_settings();
            }
            // Warm up the GPU and media capability probe off the UI thread.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let s = handle.state::<AppState>();
                if let Err(e) = s.renderer() {
                    log::error!("GPU initialisation failed: {e}");
                }
                s.caps.get_or_init(veyra_media::tools::detect_capabilities);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let s = window.state::<AppState>();
                let _ = std::fs::remove_file(s.dirs.data.join("session.lock"));
                s.decoders.clear();
                s.cache.shutdown(); // never leave rendered frames on disk after closing
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_settings,
            commands::registry_effects,
            commands::export_catalog,
            commands::list_fonts,
            commands::import_font,
            commands::validate_expression,
            commands::expression_errors,
            commands::reveal_path,
            commands::prepare_for_update,
            commands::new_project,
            commands::new_composition,
            commands::sync_project,
            commands::open_project,
            commands::save_project,
            commands::read_project_layout,
            commands::write_project_layout,
            commands::autosave,
            commands::list_recovery,
            commands::recover_project,
            commands::discard_recovery,
            commands::recent_projects,
            commands::relink_media,
            commands::relink_asset,
            commands::collect_project,
            commands::import_media,
            commands::thumbnail,
            commands::filmstrip,
            commands::waveform,
            commands::generate_proxy,
            commands::create_layer,
            commands::create_effect,
            commands::create_mask,
            commands::create_shape_item,
            commands::make_compound,
            commands::unpack_compound,
            commands::split_layers,
            commands::ripple_delete,
            commands::shift_keys,
            commands::unparent_preserving,
            commands::check_parent,
            commands::render_frame,
            commands::prerender,
            commands::stop_prerender,
            commands::cached_frames,
            commands::cache_stats,
            commands::clear_cache,
            commands::render_warnings,
            commands::scopes,
            commands::preview_audio,
            commands::validate_export,
            commands::start_export,
            commands::job_control,
            commands::convert_media,
            commands::import_subtitles,
            commands::export_interchange,
            commands::import_model,
            commands::find_blender,
            commands::import_blend,
            commands::track_points,
            commands::active_jobs,
            commands::save_preset,
            commands::list_presets,
            commands::delete_preset,
            commands::import_preset_file,
            commands::list_luts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VEYRA");
}

/// Applies changed defaults to settings saved by older versions. Returns true when anything
/// changed (the caller saves the file).
fn migrate_settings(s: &mut Settings) -> bool {
    if s.settings_version >= SETTINGS_VERSION {
        return false;
    }
    if s.settings_version < 2 {
        // 0.9.3: previews render live in RAM. Background pre-rendering and the disk cache
        // filled the drive (4 GB cache rewritten after every edit), so both are now opt-in.
        s.background_render = false;
        s.disk_cache = false;
        s.disk_cache_mb = s.disk_cache_mb.clamp(512, 2048);
        s.ram_cache_mb = s.ram_cache_mb.min(1024);
    }
    s.settings_version = SETTINGS_VERSION;
    true
}

/// The app was renamed from VEYRA to Directory (new app identifier). On first launch, copy
/// settings, presets and autosaves from the old data folder so nothing is lost.
fn migrate_from_veyra(data: &std::path::Path) {
    if data.exists() {
        return;
    }
    let Some(parent) = data.parent() else { return };
    let old = parent.join("studio.veyra.editor");
    if !old.is_dir() {
        return;
    }
    fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)?.flatten() {
            let p = e.path();
            let name = e.file_name();
            if name == "session.lock" || name == "logs" {
                continue;
            }
            if p.is_dir() {
                copy_dir(&p, &to.join(&name))?;
            } else {
                std::fs::copy(&p, to.join(&name))?;
            }
        }
        Ok(())
    }
    match copy_dir(&old, data) {
        Ok(()) => log::info!("migrated settings from {}", old.display()),
        Err(e) => log::warn!("could not migrate old settings: {e}"),
    }
}
