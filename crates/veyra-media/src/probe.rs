//! Media inspection via ffprobe, image-sequence detection and duplicate fingerprints.

use crate::ffmpeg::{self, MediaError, Result};
use serde_json::Value;
use std::path::Path;
use veyra_core::model::{AssetKind, MediaInfo};

pub const VIDEO_EXT: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "mpeg", "mpg", "m4v", "mxf", "ts", "mts", "m2ts", "flv", "wmv", "3gp", "gif", "ogv", "vob", "y4m"];
pub const AUDIO_EXT: &[&str] = &["wav", "mp3", "aac", "flac", "ogg", "opus", "aiff", "aif", "m4a", "wma", "ac3", "wv"];
pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "tif", "tiff", "tga", "bmp", "exr", "hdr", "psd", "dpx", "jp2", "avif", "jxl", "pbm", "ppm"];
pub const MODEL_EXT: &[&str] = &["glb", "gltf", "obj", "blend", "fbx", "usd", "usdz", "usda", "usdc", "abc"];

pub fn classify(path: &Path) -> Option<AssetKind> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let e = ext.as_str();
    if e == "svg" {
        Some(AssetKind::Svg)
    } else if e == "cube" {
        Some(AssetKind::Lut)
    } else if MODEL_EXT.contains(&e) {
        Some(AssetKind::Model3d)
    } else if IMAGE_EXT.contains(&e) {
        Some(AssetKind::Image)
    } else if AUDIO_EXT.contains(&e) {
        Some(AssetKind::Audio)
    } else if VIDEO_EXT.contains(&e) {
        Some(AssetKind::Video)
    } else {
        None
    }
}

fn parse_rate(s: &str) -> f64 {
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(1.0));
            if b == 0.0 { 0.0 } else { a / b }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

pub fn pix_fmt_has_alpha(p: &str) -> bool {
    let p = p.to_lowercase();
    p.starts_with("yuva") || p.starts_with("rgba") || p.starts_with("bgra") || p.starts_with("argb") || p.starts_with("abgr") || p.starts_with("ya") || p.starts_with("gbrap") || p == "pal8"
}

/// Inspect a media file (or an ffmpeg-style image sequence pattern).
pub fn probe(path: &str, sequence: Option<(u32, f64)>) -> Result<MediaInfo> {
    let mut c = ffmpeg::ffprobe()?;
    c.args(["-print_format", "json", "-show_streams", "-show_format"]);
    if let Some((start, fps)) = sequence {
        c.args(["-f", "image2", "-start_number", &start.to_string(), "-framerate", &fps.to_string()]);
    }
    c.arg(path);
    let out = ffmpeg::run(c).map_err(|e| match e {
        MediaError::Failed(m) => MediaError::Unsupported(m),
        o => o,
    })?;
    let v: Value = serde_json::from_slice(&out).map_err(|e| MediaError::Unsupported(e.to_string()))?;
    let mut info = MediaInfo::default();
    let fmt = &v["format"];
    info.duration = fmt["duration"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    info.bit_rate = fmt["bit_rate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
    info.file_size = fmt["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
    let format_name = fmt["format_name"].as_str().unwrap_or("");
    let is_still_container = format_name.contains("_pipe") || format_name == "image2" || format_name == "png_pipe";
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    for s in &streams {
        match s["codec_type"].as_str() {
            Some("video") if !info.has_video => {
                // Skip attached cover art in audio files.
                if s["disposition"]["attached_pic"].as_i64() == Some(1) {
                    continue;
                }
                info.has_video = true;
                info.width = s["width"].as_u64().unwrap_or(0) as u32;
                info.height = s["height"].as_u64().unwrap_or(0) as u32;
                info.video_codec = s["codec_name"].as_str().unwrap_or("").to_string();
                info.pix_fmt = s["pix_fmt"].as_str().unwrap_or("").to_string();
                let r = parse_rate(s["r_frame_rate"].as_str().unwrap_or("0/1"));
                let avg = parse_rate(s["avg_frame_rate"].as_str().unwrap_or("0/1"));
                info.fps = if avg > 0.0 && avg < 1000.0 { avg } else { r };
                info.variable_frame_rate = r > 0.0 && avg > 0.0 && (r - avg).abs() / r > 0.01;
                info.frame_count = s["nb_frames"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
                info.color_space = s["color_space"].as_str().unwrap_or("").to_string();
                let alpha_tag = s["tags"]["alpha_mode"].as_str() == Some("1") || s["tags"]["ALPHA_MODE"].as_str() == Some("1");
                info.has_alpha = pix_fmt_has_alpha(&info.pix_fmt) || alpha_tag;
                if let Some(d) = s["duration"].as_str().and_then(|x| x.parse::<f64>().ok()) {
                    if info.duration <= 0.0 {
                        info.duration = d;
                    }
                }
                // Display-matrix rotation (phone footage).
                if let Some(sd) = s["side_data_list"].as_array() {
                    for d in sd {
                        if let Some(r) = d["rotation"].as_i64() {
                            info.rotation = r as i32;
                        }
                    }
                }
                if let Some(r) = s["tags"]["rotate"].as_str().and_then(|x| x.parse::<i32>().ok()) {
                    info.rotation = r;
                }
                if info.rotation.abs() == 90 || info.rotation.abs() == 270 {
                    std::mem::swap(&mut info.width, &mut info.height);
                }
            }
            Some("audio") if !info.has_audio => {
                info.has_audio = true;
                info.audio_codec = s["codec_name"].as_str().unwrap_or("").to_string();
                info.sample_rate = s["sample_rate"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
                info.channels = s["channels"].as_u64().unwrap_or(0) as u32;
                if info.duration <= 0.0 {
                    info.duration = s["duration"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0.0);
                }
            }
            _ => {}
        }
    }
    if !info.has_video && !info.has_audio {
        return Err(MediaError::Unsupported("no audio or video streams".into()));
    }
    if is_still_container && sequence.is_none() {
        info.duration = 0.0;
        info.fps = 0.0;
    }
    if let Some((_, fps)) = sequence {
        info.fps = fps;
        if info.frame_count > 0 {
            info.duration = info.frame_count as f64 / fps;
        }
    }
    if info.has_video && info.fps <= 0.0 {
        info.fps = 30.0;
    }
    Ok(info)
}

/// If `path` looks like one frame of a numbered sequence (`name_0001.png`) with at least two
/// siblings, return (`pattern`, first number, frame count).
pub fn detect_sequence(path: &Path) -> Option<(String, u32, u32)> {
    let ext = path.extension()?.to_string_lossy().to_string();
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let digits = stem.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let prefix = &stem[..stem.len() - digits];
    let dir = path.parent()?;
    let mut nums: Vec<u32> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let rest = n.strip_prefix(prefix)?.strip_suffix(&format!(".{ext}"))?;
            (rest.len() == digits && rest.chars().all(|c| c.is_ascii_digit())).then(|| rest.parse().ok()).flatten()
        })
        .collect();
    if nums.len() < 2 {
        return None;
    }
    nums.sort_unstable();
    let pattern = dir.join(format!("{prefix}%0{digits}d.{ext}")).to_string_lossy().replace('\\', "/");
    Some((pattern, nums[0], nums.len() as u32))
}

/// Cheap content fingerprint (size + first/last 64 KiB) for duplicate detection.
pub fn fingerprint(path: &Path) -> String {
    use std::hash::{Hash, Hasher};
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    len.hash(&mut h);
    let mut buf = vec![0u8; 65536];
    if let Ok(n) = f.read(&mut buf) {
        buf[..n].hash(&mut h);
    }
    if len > 131072 && f.seek(SeekFrom::End(-65536)).is_ok() {
        if let Ok(n) = f.read(&mut buf) {
            buf[..n].hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}
