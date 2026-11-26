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
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
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
            let settings: Settings = std::fs::read_to_string(data.join("settings.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            if settings.cpu_threads > 0 {
                let _ = rayon::ThreadPoolBuilder::new().num_threads(settings.cpu_threads).build_global();
            }
            let frame_cache = Arc::new(veyra_render::cache::FrameCache::new(settings.ram_cache_mb as usize * 1024 * 1024));
            let disk_dir = if settings.cache_dir.is_empty() { cache.join("frames") } else { std::path::PathBuf::from(&settings.cache_dir).join("frames") };
            frame_cache.configure(settings.ram_cache_mb as usize * 1024 * 1024, Some(disk_dir.clone()), settings.disk_cache_mb * 1024 * 1024);
            // Frames cached on disk by an earlier session use stale keys; start clean.
            let _ = std::fs::remove_dir_all(&disk_dir);
            let _ = std::fs::create_dir_all(&disk_dir);
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
            commands::new_project,
            commands::new_composition,
            commands::sync_project,
            commands::open_project,
            commands::save_project,
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
