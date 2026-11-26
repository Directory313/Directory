//! Codec / container catalogue, alpha capability rules and presets.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub container: String,
    pub codec: String,
    /// Output file (or first file of a sequence; the frame number is appended).
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Seconds (composition time).
    pub start: f64,
    pub end: f64,
    /// 0..100, higher = better (mapped to CRF/qscale per codec).
    pub quality: f64,
    /// Target bitrate in kbps (0 = quality-based).
    #[serde(default)]
    pub bitrate: u32,
    pub alpha: bool,
    #[serde(default)]
    pub hardware: bool,
    #[serde(default = "d8")]
    pub bit_depth: u32,
    pub audio: bool,
    #[serde(default = "aac")]
    pub audio_codec: String,
    #[serde(default = "abr")]
    pub audio_bitrate: u32,
    #[serde(default = "sr")]
    pub sample_rate: u32,
    #[serde(default = "ch")]
    pub channels: u32,
    #[serde(default)]
    pub color_space: String,
    /// Premultiplied alpha output (straight by default).
    #[serde(default)]
    pub premultiplied: bool,
}
fn d8() -> u32 {
    8
}
fn aac() -> String {
    "aac".into()
}
fn abr() -> u32 {
    192
}
fn sr() -> u32 {
    48000
}
fn ch() -> u32 {
    2
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub encoder: &'static str,
    pub containers: &'static [&'static str],
    pub alpha: bool,
    pub sequence: bool,
    pub hw: &'static [&'static str],
    pub ten_bit: bool,
}

pub const CODECS: &[CodecInfo] = &[
    CodecInfo { id: "h264", name: "H.264", encoder: "libx264", containers: &["mp4", "mov", "mkv", "avi"], alpha: false, sequence: false, hw: &["h264_nvenc", "h264_qsv", "h264_amf"], ten_bit: false },
    CodecInfo { id: "hevc", name: "H.265 / HEVC", encoder: "libx265", containers: &["mp4", "mov", "mkv"], alpha: false, sequence: false, hw: &["hevc_nvenc", "hevc_qsv", "hevc_amf"], ten_bit: true },
    CodecInfo { id: "av1", name: "AV1", encoder: "libsvtav1", containers: &["mp4", "mkv", "webm"], alpha: false, sequence: false, hw: &["av1_nvenc", "av1_qsv", "av1_amf"], ten_bit: true },
    CodecInfo { id: "vp9", name: "VP9", encoder: "libvpx-vp9", containers: &["webm", "mkv"], alpha: true, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "prores422hq", name: "ProRes 422 HQ", encoder: "prores_ks", containers: &["mov"], alpha: false, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "prores422", name: "ProRes 422", encoder: "prores_ks", containers: &["mov"], alpha: false, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "prores4444", name: "ProRes 4444", encoder: "prores_ks", containers: &["mov"], alpha: true, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "prores4444xq", name: "ProRes 4444 XQ", encoder: "prores_ks", containers: &["mov"], alpha: true, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "dnxhr_hq", name: "DNxHR HQ", encoder: "dnxhd", containers: &["mov", "mxf"], alpha: false, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "dnxhr_hqx", name: "DNxHR HQX (10-bit)", encoder: "dnxhd", containers: &["mov", "mxf"], alpha: false, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "dnxhr_444", name: "DNxHR 444", encoder: "dnxhd", containers: &["mov", "mxf"], alpha: false, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "dnxhd", name: "DNxHD (1080p, 1920×1080 only)", encoder: "dnxhd", containers: &["mov", "mxf"], alpha: false, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "ffv1", name: "FFV1 (lossless)", encoder: "ffv1", containers: &["mkv", "avi"], alpha: true, sequence: false, hw: &[], ten_bit: true },
    CodecInfo { id: "qtrle", name: "QuickTime Animation (RLE)", encoder: "qtrle", containers: &["mov"], alpha: true, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "png_mov", name: "PNG in MOV", encoder: "png", containers: &["mov"], alpha: true, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "mpeg2", name: "MPEG-2", encoder: "mpeg2video", containers: &["mpg", "mpeg", "mxf", "ts"], alpha: false, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "mjpeg", name: "Motion JPEG", encoder: "mjpeg", containers: &["avi", "mov"], alpha: false, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "rawvideo", name: "Uncompressed RGBA", encoder: "rawvideo", containers: &["mov", "avi", "mkv"], alpha: true, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "gif", name: "Animated GIF", encoder: "gif", containers: &["gif"], alpha: false, sequence: false, hw: &[], ten_bit: false },
    CodecInfo { id: "png_seq", name: "PNG sequence", encoder: "png", containers: &["png"], alpha: true, sequence: true, hw: &[], ten_bit: false },
    CodecInfo { id: "jpeg_seq", name: "JPEG sequence", encoder: "mjpeg", containers: &["jpg"], alpha: false, sequence: true, hw: &[], ten_bit: false },
    CodecInfo { id: "tiff_seq", name: "TIFF sequence", encoder: "tiff", containers: &["tif"], alpha: true, sequence: true, hw: &[], ten_bit: false },
    CodecInfo { id: "exr_seq", name: "OpenEXR sequence (half float)", encoder: "exr", containers: &["exr"], alpha: true, sequence: true, hw: &[], ten_bit: true },
];

pub fn codec(id: &str) -> Option<&'static CodecInfo> {
    CODECS.iter().find(|c| c.id == id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Validate settings. Alpha is never silently dropped: requesting alpha with a codec that
/// cannot store it is an error, and a transparent composition exported without alpha warns.
pub fn validate(s: &ExportSettings, comp_transparent: bool, available_encoders: &[String]) -> Validation {
    let mut v = Validation { ok: true, errors: vec![], warnings: vec![] };
    let Some(c) = codec(&s.codec) else {
        v.errors.push(format!("Unknown codec '{}'", s.codec));
        v.ok = false;
        return v;
    };
    if !c.containers.contains(&s.container.as_str()) {
        v.errors.push(format!("{} cannot be stored in .{} (use {})", c.name, s.container, c.containers.join(", ")));
    }
    if s.alpha && !c.alpha {
        v.errors.push(format!("{} does not support an alpha channel. Use ProRes 4444, VP9 WebM, PNG/TIFF/EXR sequence, FFV1, QuickTime Animation or PNG-in-MOV.", c.name));
    }
    if comp_transparent && !s.alpha {
        v.warnings.push("The composition has a transparent background but this export has no alpha channel; transparent areas will be rendered black.".into());
    }
    if !available_encoders.is_empty() && !available_encoders.iter().any(|e| e == c.encoder) {
        v.errors.push(format!("Encoder '{}' is not available in the bundled media engine", c.encoder));
    }
    if s.width < 2 || s.height < 2 || s.width > 16384 || s.height > 16384 {
        v.errors.push("Resolution must be between 2 and 16384 pixels".into());
    }
    if matches!(c.encoder, "libx264" | "libx265" | "libsvtav1" | "libvpx-vp9" | "mpeg2video" | "dnxhd" | "prores_ks") && (s.width % 2 == 1 || s.height % 2 == 1) {
        v.warnings.push("Width and height will be rounded down to even numbers for this codec".into());
    }
    if s.codec == "dnxhd" && (s.width != 1920 || s.height != 1080) {
        v.errors.push("Classic DNxHD only supports 1920×1080; choose a DNxHR profile for other sizes".into());
    }
    if !(s.fps > 0.0 && s.fps <= 240.0) {
        v.errors.push("Frame rate must be between 0 and 240".into());
    }
    if s.end <= s.start {
        v.errors.push("Render range is empty".into());
    }
    if s.path.trim().is_empty() {
        v.errors.push("Choose an output file".into());
    }
    if s.audio && c.sequence {
        v.warnings.push("Image sequences cannot contain audio; a separate .wav will be written next to the frames".into());
    }
    if s.hardware && c.hw.iter().all(|h| !available_encoders.iter().any(|e| e == h)) {
        v.warnings.push("No hardware encoder is available for this codec; software encoding will be used".into());
    }
    v.ok = v.errors.is_empty();
    v
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub container: &'static str,
    pub codec: &'static str,
    /// 0 = use composition size.
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: f64,
    pub bitrate: u32,
    pub alpha: bool,
    pub audio_codec: &'static str,
    pub audio_bitrate: u32,
}

macro_rules! p {
    ($id:expr, $name:expr, $g:expr, $c:expr, $v:expr, $w:expr, $h:expr, $fps:expr, $q:expr, $br:expr, $a:expr, $ac:expr, $ab:expr) => {
        Preset { id: $id, name: $name, group: $g, container: $c, codec: $v, width: $w, height: $h, fps: $fps, quality: $q, bitrate: $br, alpha: $a, audio_codec: $ac, audio_bitrate: $ab }
    };
}

pub const PRESETS: &[Preset] = &[
    p!("youtube", "YouTube 1080p", "Social", "mp4", "h264", 1920, 1080, 0.0, 80.0, 0, false, "aac", 320),
    p!("youtube4k", "YouTube 4K", "Social", "mp4", "h264", 3840, 2160, 0.0, 82.0, 0, false, "aac", 320),
    p!("shorts", "YouTube Shorts", "Social", "mp4", "h264", 1080, 1920, 0.0, 80.0, 0, false, "aac", 256),
    p!("tiktok", "TikTok", "Social", "mp4", "h264", 1080, 1920, 30.0, 78.0, 0, false, "aac", 192),
    p!("reels", "Instagram Reels", "Social", "mp4", "h264", 1080, 1920, 30.0, 78.0, 0, false, "aac", 192),
    p!("igpost", "Instagram Post (4:5)", "Social", "mp4", "h264", 1080, 1350, 30.0, 78.0, 0, false, "aac", 192),
    p!("igsquare", "Instagram Square", "Social", "mp4", "h264", 1080, 1080, 30.0, 78.0, 0, false, "aac", 192),
    p!("stories", "Instagram Stories", "Social", "mp4", "h264", 1080, 1920, 30.0, 76.0, 0, false, "aac", 192),
    p!("facebook", "Facebook 1080p", "Social", "mp4", "h264", 1920, 1080, 30.0, 76.0, 0, false, "aac", 192),
    p!("master", "Professional Master (ProRes 422 HQ)", "Professional", "mov", "prores422hq", 0, 0, 0.0, 95.0, 0, false, "pcm_s24le", 0),
    p!("highquality", "High Quality H.265", "Professional", "mp4", "hevc", 0, 0, 0.0, 90.0, 0, false, "aac", 320),
    p!("dnxhr", "DNxHR HQ (MXF)", "Professional", "mxf", "dnxhr_hq", 0, 0, 0.0, 95.0, 0, false, "pcm_s16le", 0),
    p!("web", "Web Optimised", "Web", "mp4", "h264", 1280, 720, 30.0, 70.0, 0, false, "aac", 128),
    p!("webm", "WebM VP9", "Web", "webm", "vp9", 0, 0, 0.0, 75.0, 0, false, "libopus", 160),
    p!("alpha_prores", "Transparent — ProRes 4444", "Transparent Motion Graphics", "mov", "prores4444", 0, 0, 0.0, 95.0, 0, true, "pcm_s16le", 0),
    p!("alpha_webm", "Transparent — WebM VP9 alpha", "Transparent Motion Graphics", "webm", "vp9", 0, 0, 0.0, 80.0, 0, true, "libopus", 160),
    p!("alpha_png", "Transparent — PNG sequence", "Transparent Motion Graphics", "png", "png_seq", 0, 0, 0.0, 100.0, 0, true, "aac", 192),
    p!("uhd", "4K Master H.264", "Resolution", "mp4", "h264", 3840, 2160, 0.0, 85.0, 0, false, "aac", 320),
    p!("hd", "1080p H.264", "Resolution", "mp4", "h264", 1920, 1080, 0.0, 80.0, 0, false, "aac", 256),
    p!("custom", "Custom", "Custom", "mp4", "h264", 0, 0, 0.0, 80.0, 0, false, "aac", 192),
];

/// Codec-specific encoder arguments (video only).
pub fn video_args(s: &ExportSettings, hw_available: &[String]) -> Vec<String> {
    let c = codec(&s.codec).expect("validated");
    let q = s.quality.clamp(0.0, 100.0);
    let crf = |lo: f64, hi: f64| format!("{}", (hi - (hi - lo) * q / 100.0).round());
    let mut a: Vec<String> = Vec::new();
    let mut push = |xs: &[&str]| a.extend(xs.iter().map(|x| x.to_string()));
    let hw = if s.hardware { c.hw.iter().find(|h| hw_available.iter().any(|e| e == *h)).copied() } else { None };
    let ten = s.bit_depth >= 10 && c.ten_bit;
    match (s.codec.as_str(), hw) {
        ("h264" | "hevc" | "av1", Some(enc)) => {
            push(&["-c:v", enc]);
            let qv = crf(18.0, 40.0);
            if enc.contains("nvenc") {
                push(&["-rc", "vbr", "-cq", &qv, "-preset", "p5"]);
            } else if enc.contains("qsv") {
                push(&["-global_quality", &qv, "-preset", "medium"]);
            } else {
                push(&["-rc", "cqp", "-qp_i", &qv, "-qp_p", &qv]);
            }
            push(&["-pix_fmt", if enc.contains("qsv") { "nv12" } else { "yuv420p" }]);
        }
        ("h264", None) => push(&["-c:v", "libx264", "-preset", "medium", "-crf", &crf(14.0, 38.0), "-pix_fmt", "yuv420p", "-profile:v", "high"]),
        ("hevc", None) => {
            push(&["-c:v", "libx265", "-preset", "medium", "-crf", &crf(16.0, 38.0), "-pix_fmt", if ten { "yuv420p10le" } else { "yuv420p" }]);
            if s.container == "mp4" || s.container == "mov" {
                push(&["-tag:v", "hvc1"]);
            }
        }
        ("av1", None) => push(&["-c:v", "libsvtav1", "-preset", "8", "-crf", &crf(20.0, 50.0), "-pix_fmt", if ten { "yuv420p10le" } else { "yuv420p" }]),
        ("vp9", _) => {
            push(&["-c:v", "libvpx-vp9", "-crf", &crf(15.0, 45.0), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"]);
            if s.alpha {
                push(&["-pix_fmt", "yuva420p", "-auto-alt-ref", "0"]);
            } else {
                push(&["-pix_fmt", "yuv420p"]);
            }
        }
        ("prores422hq", _) => push(&["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"]),
        ("prores422", _) => push(&["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"]),
        ("prores4444", _) => push(&["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", if s.alpha { "yuva444p10le" } else { "yuv444p10le" }, "-alpha_bits", "16", "-vendor", "apl0"]),
        ("prores4444xq", _) => push(&["-c:v", "prores_ks", "-profile:v", "5", "-pix_fmt", if s.alpha { "yuva444p10le" } else { "yuv444p10le" }, "-alpha_bits", "16", "-vendor", "apl0"]),
        ("dnxhr_hq", _) => push(&["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"]),
        ("dnxhr_hqx", _) => push(&["-c:v", "dnxhd", "-profile:v", "dnxhr_hqx", "-pix_fmt", "yuv422p10le"]),
        ("dnxhr_444", _) => push(&["-c:v", "dnxhd", "-profile:v", "dnxhr_444", "-pix_fmt", "yuv444p10le"]),
        ("dnxhd", _) => push(&["-c:v", "dnxhd", "-b:v", "185M", "-pix_fmt", "yuv422p"]),
        ("ffv1", _) => push(&["-c:v", "ffv1", "-level", "3", "-pix_fmt", if s.alpha { "bgra" } else { "yuv444p" }]),
        ("qtrle", _) => push(&["-c:v", "qtrle", "-pix_fmt", if s.alpha { "argb" } else { "rgb24" }]),
        ("png_mov", _) => push(&["-c:v", "png", "-pix_fmt", if s.alpha { "rgba" } else { "rgb24" }]),
        ("mpeg2", _) => push(&["-c:v", "mpeg2video", "-q:v", &crf(2.0, 20.0), "-pix_fmt", "yuv420p"]),
        ("mjpeg", _) => push(&["-c:v", "mjpeg", "-q:v", &crf(2.0, 20.0), "-pix_fmt", "yuvj420p"]),
        ("rawvideo", _) => push(&["-c:v", "rawvideo", "-pix_fmt", if s.alpha { "rgba" } else { "rgb24" }]),
        ("gif", _) => push(&["-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a"]),
        ("png_seq", _) => push(&["-c:v", "png", "-pix_fmt", if s.alpha { "rgba" } else { "rgb24" }]),
        ("jpeg_seq", _) => push(&["-c:v", "mjpeg", "-q:v", &crf(2.0, 20.0), "-pix_fmt", "yuvj444p"]),
        ("tiff_seq", _) => push(&["-c:v", "tiff", "-pix_fmt", if s.alpha { "rgba" } else { "rgb24" }, "-compression_algo", "lzw"]),
        ("exr_seq", _) => push(&["-c:v", "exr", "-pix_fmt", if s.alpha { "gbrapf32le" } else { "gbrpf32le" }, "-format", "1", "-compression", "3"]),
        _ => {}
    }
    if s.bitrate > 0 && matches!(s.codec.as_str(), "h264" | "hevc" | "av1" | "vp9" | "mpeg2") {
        a.retain(|x| x != "-crf");
        a.extend(["-b:v".to_string(), format!("{}k", s.bitrate), "-maxrate".into(), format!("{}k", s.bitrate * 3 / 2), "-bufsize".into(), format!("{}k", s.bitrate * 2)]);
    }
    a
}

pub fn color_args(s: &ExportSettings) -> Vec<String> {
    let c = codec(&s.codec).expect("validated");
    if c.sequence || matches!(s.codec.as_str(), "qtrle" | "png_mov" | "rawvideo" | "gif") {
        return vec![];
    }
    let (m, p, t) = match s.color_space.as_str() {
        "rec2020" => ("bt2020nc", "bt2020", "bt709"),
        "srgb" => ("bt709", "bt709", "iec61966-2-1"),
        _ => ("bt709", "bt709", "bt709"),
    };
    ["-colorspace", m, "-color_primaries", p, "-color_trc", t, "-color_range", "tv"].iter().map(|x| x.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(codec: &str, container: &str, alpha: bool) -> ExportSettings {
        ExportSettings {
            container: container.into(),
            codec: codec.into(),
            path: "out".into(),
            width: 1920,
            height: 1080,
            fps: 30.0,
            start: 0.0,
            end: 1.0,
            quality: 80.0,
            bitrate: 0,
            alpha,
            hardware: false,
            bit_depth: 8,
            audio: true,
            audio_codec: "aac".into(),
            audio_bitrate: 192,
            sample_rate: 48000,
            channels: 2,
            color_space: String::new(),
            premultiplied: false,
        }
    }

    #[test]
    fn alpha_rules() {
        assert!(!validate(&base("h264", "mp4", true), true, &[]).ok, "H.264 cannot carry alpha");
        assert!(validate(&base("prores4444", "mov", true), true, &[]).ok);
        assert!(validate(&base("vp9", "webm", true), true, &[]).ok);
        assert!(validate(&base("png_seq", "png", true), true, &[]).ok);
        let w = validate(&base("h264", "mp4", false), true, &[]);
        assert!(w.ok && !w.warnings.is_empty(), "transparent comp without alpha must warn");
        assert!(!validate(&base("prores4444", "mp4", true), false, &[]).ok, "container check");
    }

    #[test]
    fn args_contain_alpha_pix_fmt() {
        assert!(video_args(&base("prores4444", "mov", true), &[]).contains(&"yuva444p10le".to_string()));
        assert!(video_args(&base("vp9", "webm", true), &[]).contains(&"yuva420p".to_string()));
        assert!(video_args(&base("h264", "mp4", false), &[]).contains(&"libx264".to_string()));
    }
}
