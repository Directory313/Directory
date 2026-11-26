//! Application state shared by all commands.

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, OnceLock};
use veyra_core::model::Project;
use veyra_core::ops::CacheKeys;
use veyra_media::DecoderPool;
use veyra_render::cache::FrameCache;
use veyra_render::Renderer;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub ui_scale: f64,
    pub reduced_motion: bool,
    pub accent_intensity: f64,
    pub startup: String,
    pub default_project_dir: String,
    pub autosave_enabled: bool,
    pub autosave_minutes: f64,
    pub backups_kept: usize,
    pub ram_cache_mb: u64,
    pub disk_cache_mb: u64,
    pub cache_dir: String,
    pub background_render: bool,
    pub preview_scale: f64,
    pub adaptive_preview: bool,
    pub prefer_responsiveness: bool,
    pub use_proxies: bool,
    pub proxy_height: u32,
    pub auto_proxy_above: u32,
    pub hardware_decode: bool,
    pub hardware_encode: bool,
    pub cpu_threads: usize,
    pub default_fps: f64,
    pub default_width: u32,
    pub default_height: u32,
    pub default_still_duration: f64,
    pub default_transition: f64,
    pub snapping: bool,
    pub time_display: String,
    pub default_interpolation: String,
    pub motion_blur_samples: u32,
    pub export_folder: String,
    pub export_preset: String,
    pub blender_path: String,
    pub shortcuts: HashMap<String, String>,
    pub workspaces: HashMap<String, serde_json::Value>,
    pub active_workspace: String,
    pub recent: Vec<String>,
    pub lut_folders: Vec<String>,
    pub favorite_effects: Vec<String>,
    pub thumbnails: bool,
    pub waveforms: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ui_scale: 1.0,
            reduced_motion: false,
            accent_intensity: 1.0,
            startup: "home".into(),
            default_project_dir: String::new(),
            autosave_enabled: true,
            autosave_minutes: 2.0,
            backups_kept: 10,
            ram_cache_mb: 1024,
            disk_cache_mb: 4096,
            cache_dir: String::new(),
            background_render: true,
            preview_scale: 0.5,
            adaptive_preview: true,
            prefer_responsiveness: true,
            use_proxies: true,
            proxy_height: 540,
            auto_proxy_above: 2160,
            hardware_decode: true,
            hardware_encode: true,
            cpu_threads: 0,
            default_fps: 30.0,
            default_width: 1920,
            default_height: 1080,
            default_still_duration: 5.0,
            default_transition: 0.5,
            snapping: true,
            time_display: "timecode".into(),
            default_interpolation: "bezier".into(),
            motion_blur_samples: 8,
            export_folder: String::new(),
            export_preset: "youtube".into(),
            blender_path: String::new(),
            shortcuts: HashMap::new(),
            workspaces: HashMap::new(),
            active_workspace: "Editing".into(),
            recent: vec![],
            lut_folders: vec![],
            favorite_effects: vec![],
            thumbnails: true,
            waveforms: true,
        }
    }
}

pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub control: Arc<veyra_export::Control>,
}

pub struct Dirs {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub autosave: PathBuf,
    pub presets: PathBuf,
    pub logs: PathBuf,
}

pub struct AppState {
    pub project: RwLock<Project>,
    pub revision: AtomicU64,
    pub project_path: Mutex<Option<PathBuf>>,
    pub renderer: OnceLock<Result<Arc<Renderer>, String>>,
    pub decoders: Arc<DecoderPool>,
    pub cache: Arc<FrameCache>,
    pub keys: Mutex<Option<(u64, String, Arc<CacheKeys>)>>,
    pub jobs: Mutex<HashMap<String, Job>>,
    pub settings: RwLock<Settings>,
    pub caps: OnceLock<veyra_media::tools::Capabilities>,
    pub dirs: Dirs,
    pub crashed_last_time: bool,
    pub prerender_gen: AtomicU64,
}

impl AppState {
    pub fn renderer(&self) -> Result<Arc<Renderer>, String> {
        self.renderer
            .get_or_init(|| {
                veyra_render::Gpu::new()
                    .map(|g| Arc::new(Renderer::new(Arc::new(g), self.decoders.clone())))
                    .map_err(|e| e.to_string())
            })
            .clone()
    }

    pub fn hw_encoders(&self) -> Vec<String> {
        self.caps.get().map(|c| c.hw_encoders.clone()).unwrap_or_default()
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dirs.data.join("settings.json")
    }

    pub fn save_settings(&self) {
        let s = self.settings.read().clone();
        if let Ok(json) = serde_json::to_vec_pretty(&s) {
            let tmp = self.settings_path().with_extension("tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(tmp, self.settings_path());
            }
        }
    }

    /// Cache keys for the given composition at the current revision.
    pub fn cache_keys(&self, comp_id: &str) -> Arc<CacheKeys> {
        let rev = self.revision.load(std::sync::atomic::Ordering::SeqCst);
        let mut k = self.keys.lock();
        if let Some((r, c, keys)) = k.as_ref() {
            if *r == rev && c == comp_id {
                return keys.clone();
            }
        }
        let p = self.project.read();
        let keys = Arc::new(match p.comp(comp_id) {
            Some(c) => CacheKeys::build(&p, c),
            None => CacheKeys::build(&p, &p.compositions[0]),
        });
        *k = Some((rev, comp_id.to_string(), keys.clone()));
        keys
    }
}
