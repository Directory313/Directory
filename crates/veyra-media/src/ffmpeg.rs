//! Locating and running the bundled FFmpeg executables.
//!
//! VEYRA ships `ffmpeg.exe` and `ffprobe.exe` in `<install dir>/ffmpeg/`. Search order:
//! 1. `VEYRA_FFMPEG_DIR` environment variable (developer override)
//! 2. explicitly registered resource dir (set by the app at startup)
//! 3. `<exe dir>/ffmpeg/`, `<exe dir>/resources/ffmpeg/`, `<exe dir>`
//! 4. the repository's `src-tauri/resources/ffmpeg` (dev builds)
//! 5. `PATH` (last resort, logged as a warning)

use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static RESOURCE_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
static FOUND: OnceLock<Option<(PathBuf, PathBuf)>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("the bundled media engine (FFmpeg) could not be found; reinstall VEYRA")]
    NotFound,
    #[error("media engine failed: {0}")]
    Failed(String),
    #[error("could not start the media engine: {0}")]
    Spawn(std::io::Error),
    #[error("unsupported or unreadable file: {0}")]
    Unsupported(String),
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, MediaError>;

pub fn set_resource_dir(p: PathBuf) {
    *RESOURCE_DIR.write() = Some(p);
}

fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(d) = std::env::var("VEYRA_FFMPEG_DIR") {
        v.push(PathBuf::from(d));
    }
    if let Some(r) = RESOURCE_DIR.read().clone() {
        v.push(r.join("ffmpeg"));
        v.push(r.join("resources").join("ffmpeg"));
        v.push(r);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.join("ffmpeg"));
            v.push(d.join("resources").join("ffmpeg"));
            v.push(d.to_path_buf());
            // target/debug -> repo/src-tauri/resources/ffmpeg
            for up in d.ancestors().take(5) {
                v.push(up.join("src-tauri").join("resources").join("ffmpeg"));
            }
        }
    }
    v
}

fn locate() -> Option<(PathBuf, PathBuf)> {
    for d in candidates() {
        let (f, p) = (d.join("ffmpeg.exe"), d.join("ffprobe.exe"));
        if f.is_file() && p.is_file() {
            log::info!("media engine: using bundled FFmpeg at {}", d.display());
            return Some((f, p));
        }
    }
    // PATH fallback
    let path = std::env::var_os("PATH")?;
    for d in std::env::split_paths(&path) {
        let (f, p) = (d.join("ffmpeg.exe"), d.join("ffprobe.exe"));
        if f.is_file() && p.is_file() {
            log::warn!("media engine: bundled FFmpeg not found, falling back to PATH ({})", d.display());
            return Some((f, p));
        }
    }
    None
}

fn found() -> Result<&'static (PathBuf, PathBuf)> {
    FOUND.get_or_init(locate).as_ref().ok_or(MediaError::NotFound)
}

pub fn ffmpeg_path() -> Result<&'static Path> {
    Ok(&found()?.0)
}
pub fn ffprobe_path() -> Result<&'static Path> {
    Ok(&found()?.1)
}

/// Build a command that never flashes a console window.
pub fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

pub fn ffmpeg() -> Result<Command> {
    let mut c = command(ffmpeg_path()?);
    c.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    Ok(c)
}

pub fn ffprobe() -> Result<Command> {
    let mut c = command(ffprobe_path()?);
    c.args(["-hide_banner", "-loglevel", "error"]);
    Ok(c)
}

/// Run to completion, returning stdout or a descriptive error from stderr.
pub fn run(mut c: Command) -> Result<Vec<u8>> {
    let out = c.stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(MediaError::Spawn)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("unknown error").to_string();
        return Err(MediaError::Failed(line));
    }
    Ok(out.stdout)
}

pub fn version() -> Result<String> {
    let mut c = command(ffmpeg_path()?);
    c.arg("-version");
    let out = run(c)?;
    Ok(String::from_utf8_lossy(&out).lines().next().unwrap_or("").to_string())
}

/// List encoders available in the bundled build (`-encoders`).
pub fn encoders() -> Result<Vec<String>> {
    let mut c = command(ffmpeg_path()?);
    c.args(["-hide_banner", "-encoders"]);
    let out = String::from_utf8_lossy(&run(c)?).to_string();
    Ok(out
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("------"))
        .skip(1)
        .filter_map(|l| l.split_whitespace().nth(1).map(|s| s.to_string()))
        .collect())
}
