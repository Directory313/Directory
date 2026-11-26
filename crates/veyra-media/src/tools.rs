//! Thumbnails, filmstrips, waveforms, proxies and hardware capability detection.

use crate::ffmpeg::{self, MediaError, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

/// One JPEG thumbnail (bytes) at time `t`, `width` px wide.
pub fn thumbnail(path: &str, t: f64, width: u32, still: bool) -> Result<Vec<u8>> {
    let mut c = ffmpeg::ffmpeg()?;
    if !still && t > 0.0 {
        c.args(["-ss", &format!("{t:.3}")]);
    }
    c.arg("-i").arg(path);
    c.args(["-frames:v", "1", "-an", "-vf", &format!("scale={width}:-2:flags=bicubic"), "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"]);
    let out = ffmpeg::run(c)?;
    if out.is_empty() {
        return Err(MediaError::Failed("empty thumbnail".into()));
    }
    Ok(out)
}

/// `count` evenly spaced thumbnails written to `dir/strip_###.jpg`; returns the file paths.
pub fn filmstrip(path: &str, duration: f64, count: u32, height: u32, dir: &Path) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dir).map_err(|e| MediaError::Failed(e.to_string()))?;
    let count = count.clamp(1, 200);
    let rate = (count as f64 / duration.max(0.1)).max(0.001);
    let mut c = ffmpeg::ffmpeg()?;
    c.arg("-i").arg(path);
    c.args(["-an", "-vf", &format!("fps={rate},scale=-2:{height}"), "-frames:v", &count.to_string(), "-q:v", "6", "-y"]);
    c.arg(dir.join("strip_%03d.jpg"));
    ffmpeg::run(c)?;
    let mut v: Vec<PathBuf> = (1..=count).map(|i| dir.join(format!("strip_{i:03}.jpg"))).filter(|p| p.exists()).collect();
    v.sort();
    Ok(v)
}

/// Peak envelope: `per_second` buckets per second, each 0..1 (max abs sample).
pub fn waveform(path: &str, per_second: u32) -> Result<Vec<f32>> {
    let sr = (per_second * 40).clamp(400, 8000);
    let mut c = ffmpeg::ffmpeg()?;
    c.arg("-i").arg(path);
    c.args(["-vn", "-ac", "1", "-ar", &sr.to_string(), "-f", "s16le", "-"]);
    c.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().map_err(MediaError::Spawn)?;
    let mut out = child.stdout.take().unwrap();
    let bucket = (sr / per_second).max(1) as usize;
    let mut peaks = Vec::new();
    let mut buf = vec![0u8; bucket * 2 * 256];
    let (mut cur, mut n) = (0f32, 0usize);
    loop {
        let k = out.read(&mut buf).map_err(|e| MediaError::Failed(e.to_string()))?;
        if k == 0 {
            break;
        }
        for s in buf[..k - k % 2].chunks_exact(2) {
            let v = (i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).abs();
            cur = cur.max(v);
            n += 1;
            if n == bucket {
                peaks.push(cur);
                cur = 0.0;
                n = 0;
            }
        }
        if peaks.len() > 20_000_000 {
            break;
        }
    }
    if n > 0 {
        peaks.push(cur);
    }
    let _ = child.wait();
    Ok(peaks)
}

/// Generate an H.264 proxy at `height` px. Reports progress 0..1; cancellable.
pub fn make_proxy(src: &str, dst: &Path, height: u32, duration: f64, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<()> {
    if let Some(d) = dst.parent() {
        std::fs::create_dir_all(d).map_err(|e| MediaError::Failed(e.to_string()))?;
    }
    let tmp = dst.with_extension("part.mp4");
    let mut c = ffmpeg::ffmpeg()?;
    c.arg("-i").arg(src);
    c.args([
        "-vf", &format!("scale=-2:{height}:flags=bicubic"),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-g", "15", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-y",
    ]);
    c.arg(&tmp);
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(MediaError::Spawn)?;
    let out = child.stdout.take().unwrap();
    for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&tmp);
            return Err(MediaError::Cancelled);
        }
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            progress((us / 1e6 / duration.max(0.01)).clamp(0.0, 1.0));
        }
    }
    let status = child.wait().map_err(MediaError::Spawn)?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(MediaError::Failed("proxy encode failed".into()));
    }
    std::fs::rename(&tmp, dst).map_err(|e| MediaError::Failed(e.to_string()))?;
    progress(1.0);
    Ok(())
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub ffmpeg_version: String,
    pub ffmpeg_path: String,
    pub encoders: Vec<String>,
    /// Hardware encoders that actually initialised on this machine.
    pub hw_encoders: Vec<String>,
    pub hw_decoders: Vec<String>,
}

/// Probe a hardware encoder by encoding a few synthetic frames.
fn try_encoder(enc: &str) -> bool {
    let Ok(mut c) = ffmpeg::ffmpeg() else { return false };
    c.args(["-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2", "-c:v", enc, "-frames:v", "3", "-f", "null", "-"]);
    ffmpeg::run(c).is_ok()
}

fn hwaccels() -> Vec<String> {
    let Ok(p) = ffmpeg::ffmpeg_path() else { return vec![] };
    let mut c = ffmpeg::command(p);
    c.args(["-hide_banner", "-hwaccels"]);
    ffmpeg::run(c)
        .map(|o| String::from_utf8_lossy(&o).lines().skip(1).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

pub fn detect_capabilities() -> Capabilities {
    let encoders = ffmpeg::encoders().unwrap_or_default();
    let hw_candidates = ["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "hevc_qsv", "av1_qsv", "h264_amf", "hevc_amf", "av1_amf"];
    let hw_encoders = std::thread::scope(|s| {
        let handles: Vec<_> = hw_candidates
            .iter()
            .filter(|e| encoders.iter().any(|x| x == *e))
            .map(|e| (e.to_string(), s.spawn(move || try_encoder(e))))
            .collect();
        handles.into_iter().filter_map(|(e, h)| h.join().ok().filter(|ok| *ok).map(|_| e)).collect()
    });
    Capabilities {
        ffmpeg_version: ffmpeg::version().unwrap_or_else(|e| e.to_string()),
        ffmpeg_path: ffmpeg::ffmpeg_path().map(|p| p.display().to_string()).unwrap_or_default(),
        encoders,
        hw_encoders,
        hw_decoders: hwaccels(),
    }
}
