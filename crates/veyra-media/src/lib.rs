//! VEYRA media engine: bundled FFmpeg discovery, probing, decoding, thumbnails, waveforms,
//! proxies and hardware capability detection.

pub mod decode;
pub mod ffmpeg;
pub mod probe;
pub mod tools;

pub use decode::{DecoderPool, Frame, Source};
pub use ffmpeg::{MediaError, Result};

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration test against the real FFmpeg: synthesise a clip, probe it, decode frames.
    #[test]
    fn synth_probe_decode() {
        if ffmpeg::ffmpeg_path().is_err() {
            eprintln!("FFmpeg not available; skipping");
            return;
        }
        let dir = std::env::temp_dir().join("veyra-media-test");
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("bars.mp4");
        let mut c = ffmpeg::ffmpeg().unwrap();
        c.args(["-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y"]);
        c.arg(&clip);
        ffmpeg::run(c).unwrap();
        let info = probe::probe(clip.to_str().unwrap(), None).unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        assert!((info.fps - 25.0).abs() < 0.01);
        assert!(info.has_audio && info.has_video && !info.has_alpha);
        assert!((info.duration - 2.0).abs() < 0.15, "{}", info.duration);

        let pool = DecoderPool::default();
        let src = Source { path: clip.to_string_lossy().into(), fps: 25.0, still: false, alpha_codec: None, sequence: None };
        let f0 = pool.frame(&src, 0.0, 160, 120).unwrap().unwrap();
        assert_eq!(f0.data.len(), 160 * 120 * 4);
        let f1 = pool.frame(&src, 0.04, 160, 120).unwrap().unwrap();
        assert_ne!(f0.data, f1.data, "testsrc2 changes every frame");
        // Random access backwards restarts the stream and reproduces frame 0.
        let f0b = pool.frame(&src, 0.0, 160, 120).unwrap().unwrap();
        assert_eq!(f0.data, f0b.data);

        let peaks = tools::waveform(clip.to_str().unwrap(), 50).unwrap();
        assert!(peaks.len() >= 95 && peaks.iter().any(|p| *p > 0.1));
        let jpg = tools::thumbnail(clip.to_str().unwrap(), 1.0, 128, false).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
    }
}
