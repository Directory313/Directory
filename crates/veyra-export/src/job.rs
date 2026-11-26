//! Export job: render frames on the GPU and stream them into FFmpeg, mux the audio mix,
//! then validate the written file.

use crate::audio;
use crate::formats::{self, ExportSettings};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use veyra_core::model::Project;
use veyra_media::ffmpeg;
use veyra_render::{RenderOptions, Renderer};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub frame: u64,
    pub total: u64,
    pub fps: f64,
    pub eta_seconds: f64,
    pub elapsed_seconds: f64,
    pub bytes_written: u64,
    pub estimated_size: u64,
    pub stage: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub frames: u64,
    pub seconds: f64,
    pub file_size: u64,
    pub validation: OutputCheck,
    pub log: String,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutputCheck {
    pub ok: bool,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: String,
    pub codec: String,
    pub has_alpha: bool,
    pub has_audio: bool,
    pub messages: Vec<String>,
}

#[derive(Default)]
pub struct Control {
    pub cancel: AtomicBool,
    pub pause: AtomicBool,
}

fn sequence_pattern(path: &str, ext: &str) -> (PathBuf, String) {
    let p = Path::new(path);
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "frame".into());
    let stem = stem.trim_end_matches(|c: char| c.is_ascii_digit() || c == '_' || c == '%' || c == '0').to_string();
    let stem = if stem.is_empty() { "frame".into() } else { stem };
    (dir.clone(), dir.join(format!("{stem}_%05d.{ext}")).to_string_lossy().to_string())
}

pub fn run(
    renderer: &Renderer,
    project: &Project,
    comp_id: &str,
    s: &ExportSettings,
    hw_available: &[String],
    ctl: &Control,
    progress: &dyn Fn(&Progress),
) -> Result<ExportReport, String> {
    let comp = project.comp(comp_id).ok_or("composition not found")?;
    let v = formats::validate(s, comp.transparent, &[]);
    if !v.ok {
        return Err(v.errors.join("; "));
    }
    let codec = formats::codec(&s.codec).unwrap();
    let (w, h) = if matches!(codec.encoder, "libx264" | "libx265" | "libsvtav1" | "libvpx-vp9" | "mpeg2video" | "dnxhd" | "prores_ks" | "mjpeg") || s.hardware { (s.width & !1, s.height & !1) } else { (s.width, s.height) };
    let total = ((s.end - s.start) * s.fps).round().max(1.0) as u64;
    let duration = total as f64 / s.fps;
    let scale = w as f64 / comp.width as f64;
    let probe_frame = renderer.render(project, comp_id, s.start, RenderOptions { scale, use_proxies: false, draft: false })?;
    let (rw, rh) = (probe_frame.width, probe_frame.height);

    let (out_path, seq_dir) = if codec.sequence {
        let (dir, pat) = sequence_pattern(&s.path, &s.container);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        (pat, Some(dir))
    } else {
        if let Some(d) = Path::new(&s.path).parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        (s.path.clone(), None)
    };
    // Write to a temp name and rename on success so a failed render never leaves a
    // truncated file under the requested name.
    let tmp_path = if codec.sequence { out_path.clone() } else {
        let p = Path::new(&out_path);
        p.with_file_name(format!(".{}.part.{}", p.file_stem().unwrap_or_default().to_string_lossy(), s.container)).to_string_lossy().to_string()
    };

    let mut clips = Vec::new();
    if s.audio {
        audio::collect(project, comp, s.start, s.end, 0.0, 0.0, 0, &mut clips);
    }
    let mut cmd = ffmpeg::ffmpeg().map_err(|e| e.to_string())?;
    cmd.args(["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{rw}x{rh}"), "-r", &format!("{}", s.fps), "-i", "-"]);
    // No audible clips → no audio stream (rather than muxing silence).
    let want_audio = s.audio && !codec.sequence && s.codec != "gif" && !clips.is_empty();
    let (ainputs, agraph) = audio::build_mix(&clips, duration, s.sample_rate, s.channels, 1);
    if want_audio {
        cmd.args(&ainputs);
        cmd.args(["-filter_complex", &agraph, "-map", "0:v", "-map", "[aout]"]);
    } else {
        cmd.args(["-map", "0:v"]);
    }
    let mut vf = vec![];
    if (rw, rh) != (w, h) {
        vf.push(format!("scale={w}:{h}:flags=lanczos"));
    }
    if s.premultiplied && s.alpha {
        vf.push("premultiply=inplace=1".to_string());
    }
    let vargs = formats::video_args(s, hw_available);
    if !vf.is_empty() && !vargs.iter().any(|a| a == "-vf") {
        cmd.args(["-vf", &vf.join(",")]);
    }
    cmd.args(&vargs);
    cmd.args(formats::color_args(s));
    if want_audio {
        let ac = match (s.container.as_str(), s.audio_codec.as_str()) {
            ("webm", _) => "libopus",
            ("mpg" | "mpeg" | "ts", "aac") => "mp2",
            ("mxf", _) => "pcm_s16le",
            ("avi", "aac") => "pcm_s16le",
            (_, c) => c,
        };
        cmd.args(["-c:a", ac, "-ar", &s.sample_rate.to_string(), "-ac", &s.channels.to_string()]);
        if !ac.starts_with("pcm") && !ac.starts_with("flac") {
            cmd.args(["-b:a", &format!("{}k", s.audio_bitrate.max(32))]);
        }
    }
    if matches!(s.container.as_str(), "mp4" | "mov") {
        cmd.args(["-movflags", "+faststart"]);
    }
    if codec.sequence {
        cmd.args(["-f", "image2", "-start_number", "0"]);
    }
    cmd.args(["-frames:v", &total.to_string(), "-progress", "pipe:2", "-nostats"]);
    cmd.arg(&tmp_path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let cmdline = format!("{cmd:?}");
    let mut child = cmd.spawn().map_err(|e| format!("could not start encoder: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let log = Arc::new(parking_lot::Mutex::new(String::new()));
    let log2 = log.clone();
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            if line.contains('=') && !line.contains(' ') {
                continue; // progress key=value lines
            }
            let mut l = log2.lock();
            if l.len() < 200_000 {
                l.push_str(&line);
                l.push('\n');
            }
        }
    });

    // Writer thread: lets the GPU render the next frame while FFmpeg encodes this one.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(3);
    let writer = std::thread::spawn(move || -> Result<(), String> {
        for buf in rx {
            stdin.write_all(&buf).map_err(|e| format!("encoder stopped accepting frames: {e}"))?;
        }
        Ok(())
    });

    let started = Instant::now();
    let opts = RenderOptions { scale, use_proxies: false, draft: false };
    let mut result: Result<(), String> = Ok(());
    let mut first = Some(probe_frame);
    for i in 0..total {
        while ctl.pause.load(Ordering::Relaxed) && !ctl.cancel.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if ctl.cancel.load(Ordering::Relaxed) {
            result = Err("cancelled".into());
            break;
        }
        let t = s.start + i as f64 / s.fps;
        let img = match first.take() {
            Some(f) if i == 0 => f,
            _ => match renderer.render(project, comp_id, t, opts) {
                Ok(f) => f,
                Err(e) => {
                    result = Err(format!("render failed at {t:.3}s: {e}"));
                    break;
                }
            },
        };
        let mut data = img.data;
        if !s.alpha {
            // Flatten onto black so codecs without alpha see the intended colours.
            for px in data.chunks_exact_mut(4) {
                let a = px[3] as u32;
                if a < 255 {
                    for c in &mut px[..3] {
                        *c = ((*c as u32 * a + 127) / 255) as u8;
                    }
                    px[3] = 255;
                }
            }
        }
        if tx.send(data).is_err() {
            result = Err("encoder exited early".into());
            break;
        }
        let el = started.elapsed().as_secs_f64();
        let fps = (i + 1) as f64 / el.max(1e-3);
        let bytes = if codec.sequence { 0 } else { std::fs::metadata(&tmp_path).map(|m| m.len()).unwrap_or(0) };
        progress(&Progress {
            frame: i + 1,
            total,
            fps,
            eta_seconds: (total - i - 1) as f64 / fps.max(1e-3),
            elapsed_seconds: el,
            bytes_written: bytes,
            estimated_size: if i > 5 { bytes * total / (i + 1) } else { 0 },
            stage: "rendering".into(),
        });
    }
    drop(tx);
    let wres = writer.join().unwrap_or_else(|_| Err("writer thread panicked".into()));
    if result.is_err() || wres.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = err_thread.join();
    let log_text = format!("{cmdline}\n\n{}", log.lock());
    if let Err(e) = result {
        cleanup(&tmp_path, codec.sequence);
        return Err(e);
    }
    if let Err(e) = wres {
        cleanup(&tmp_path, codec.sequence);
        return Err(format!("{e}\n{}", last_lines(&log_text)));
    }
    if !status.success() {
        cleanup(&tmp_path, codec.sequence);
        return Err(format!("encoder failed: {}", last_lines(&log_text)));
    }
    progress(&Progress { frame: total, total, stage: "validating".into(), ..Default::default() });
    if !codec.sequence {
        if Path::new(&s.path).exists() {
            let _ = std::fs::remove_file(&s.path);
        }
        std::fs::rename(&tmp_path, &s.path).map_err(|e| format!("could not move output into place: {e}"))?;
    }
    // Image sequences: write the audio mix as a sidecar WAV.
    if codec.sequence && s.audio && !clips.is_empty() {
        if let Some(dir) = &seq_dir {
            let _ = render_audio(project, comp_id, s.start, s.end, s.sample_rate, s.channels, &dir.join("audio.wav"));
        }
    }
    let check_path = if codec.sequence { out_path.replace("%05d", "00000") } else { s.path.clone() };
    let validation = check_output(&check_path, s, codec.sequence, if codec.sequence { 0.0 } else { duration }, want_audio && !clips.is_empty());
    let file_size = if codec.sequence {
        seq_dir.as_ref().and_then(|d| std::fs::read_dir(d).ok()).map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0)
    } else {
        std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0)
    };
    Ok(ExportReport { path: if codec.sequence { out_path } else { s.path.clone() }, frames: total, seconds: started.elapsed().as_secs_f64(), file_size, validation, log: log_text })
}

fn cleanup(path: &str, sequence: bool) {
    if !sequence {
        let _ = std::fs::remove_file(path);
    }
}

fn last_lines(s: &str) -> String {
    s.lines().rev().filter(|l| !l.trim().is_empty()).take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Probe the written file and confirm it matches what was requested.
pub fn check_output(path: &str, s: &ExportSettings, sequence: bool, expect_duration: f64, expect_audio: bool) -> OutputCheck {
    let mut c = OutputCheck::default();
    let Ok(info) = veyra_media::probe::probe(path, None) else {
        c.messages.push("Output could not be read back by the media engine".into());
        return c;
    };
    c.width = info.width;
    c.height = info.height;
    c.pix_fmt = info.pix_fmt.clone();
    c.codec = info.video_codec.clone();
    c.duration = info.duration;
    c.has_alpha = info.has_alpha;
    c.has_audio = info.has_audio;
    c.ok = info.has_video;
    if s.alpha && !info.has_alpha {
        c.ok = false;
        c.messages.push(format!("Alpha was requested but the output pixel format is {}", info.pix_fmt));
    }
    if !sequence && expect_duration > 0.0 && (info.duration - expect_duration).abs() > 0.25 + 2.0 / s.fps {
        c.ok = false;
        c.messages.push(format!("Duration {:.2}s differs from expected {:.2}s", info.duration, expect_duration));
    }
    if expect_audio && !info.has_audio {
        c.ok = false;
        c.messages.push("Audio was expected but the output has no audio stream".into());
    }
    if c.ok {
        c.messages.push("Output verified".into());
    }
    c
}

/// Render the composition's audio mix to a WAV file (preview playback and sequences).
pub fn render_audio(project: &Project, comp_id: &str, start: f64, end: f64, sr: u32, channels: u32, out: &Path) -> Result<(), String> {
    let comp = project.comp(comp_id).ok_or("composition not found")?;
    let mut clips = Vec::new();
    audio::collect(project, comp, start, end, 0.0, 0.0, 0, &mut clips);
    let (inputs, graph) = audio::build_mix(&clips, end - start, sr, channels, 0);
    if let Some(d) = out.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = out.with_extension("part.wav");
    let mut c = ffmpeg::ffmpeg().map_err(|e| e.to_string())?;
    c.arg("-y");
    c.args(&inputs);
    c.args(["-filter_complex", &graph, "-map", "[aout]", "-c:a", "pcm_s16le"]);
    c.arg(&tmp);
    ffmpeg::run(c).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Batch media conversion: transcode a source file with the given settings (no compositing).
pub fn convert_media(src: &str, s: &ExportSettings, hw: &[String]) -> Result<(), String> {
    let mut c = ffmpeg::ffmpeg().map_err(|e| e.to_string())?;
    c.arg("-y").arg("-i").arg(src);
    c.args(["-vf", &format!("scale={}:{}:flags=lanczos", s.width & !1, s.height & !1)]);
    c.args(formats::video_args(s, hw));
    if s.audio {
        c.args(["-c:a", if s.container == "webm" { "libopus" } else { &s.audio_codec }]);
    } else {
        c.arg("-an");
    }
    c.arg(&s.path);
    ffmpeg::run(c).map(|_| ()).map_err(|e| e.to_string())
}
