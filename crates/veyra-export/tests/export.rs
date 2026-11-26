//! End-to-end export tests: render real compositions, encode with the bundled FFmpeg and
//! inspect the resulting files (including alpha pixels).

use std::path::PathBuf;
use std::sync::Arc;
use veyra_core::factory::*;
use veyra_core::model::*;
use veyra_export::formats::ExportSettings;
use veyra_export::{job, Control};
use veyra_media::{decode, ffmpeg, probe, DecoderPool};
use veyra_render::{Gpu, Renderer};

fn out_dir() -> PathBuf {
    let d = std::env::temp_dir().join("veyra-export-test");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn setup() -> (Renderer, Project) {
    let r = Renderer::new(Arc::new(Gpu::new().unwrap()), Arc::new(DecoderPool::default()));
    let mut p = Project::new("export");
    let c = &mut p.compositions[0];
    c.width = 320;
    c.height = 180;
    c.fps = 25.0;
    c.duration = 1.0;
    c.transparent = true;
    let comp = c.clone();
    let mut shape = shape_layer(&comp, "ellipse", 0.0);
    shape.transform.position.set_key(0.0, [100.0, 90.0, 0.0]);
    shape.transform.position.set_key(1.0, [220.0, 90.0, 0.0]);
    shape.transform.scale.value = [40.0, 40.0, 100.0];
    // Synthesised audio asset with a volume fade.
    let wav = out_dir().join("tone.wav");
    let mut cmd = ffmpeg::ffmpeg().unwrap();
    cmd.args(["-y", "-f", "lavfi", "-i", "sine=f=330:d=2"]).arg(&wav);
    ffmpeg::run(cmd).unwrap();
    let info = probe::probe(wav.to_str().unwrap(), None).unwrap();
    let asset = Asset {
        id: new_id(),
        name: "tone.wav".into(),
        kind: AssetKind::Audio,
        path: wav.to_string_lossy().into(),
        relative_path: None,
        info,
        folder: None,
        tags: vec![],
        favorite: false,
        proxy: None,
        use_proxy: false,
        sequence_pattern: None,
        sequence_start: 0,
        missing: false,
        fingerprint: String::new(),
    };
    let mut audio = media_layer(&comp, &asset, 0.0);
    audio.audio.volume.set_key(0.0, -20.0);
    audio.audio.volume.set_key(1.0, 0.0);
    p.assets.push(asset);
    p.compositions[0].layers = vec![shape, audio];
    (r, p)
}

fn settings(codec: &str, container: &str, alpha: bool, name: &str) -> ExportSettings {
    ExportSettings {
        container: container.into(),
        codec: codec.into(),
        path: out_dir().join(name).to_string_lossy().into(),
        width: 320,
        height: 180,
        fps: 25.0,
        start: 0.0,
        end: 1.0,
        quality: 80.0,
        bitrate: 0,
        alpha,
        hardware: false,
        bit_depth: 8,
        audio: true,
        audio_codec: "aac".into(),
        audio_bitrate: 128,
        sample_rate: 48000,
        channels: 2,
        color_space: String::new(),
        premultiplied: false,
    }
}

fn alpha_at(path: &str, x: u32, y: u32) -> u8 {
    let f = decode::decode_still(path, 320, 180).unwrap();
    f.data[((y * 320 + x) * 4 + 3) as usize]
}

#[test]
fn exports_are_real_and_validated() {
    let (r, p) = setup();
    let ctl = Control::default();
    let comp = p.active_comp.clone();

    // H.264 + AAC (no alpha): playable file with audio and the right duration.
    let s = settings("h264", "mp4", false, "h264.mp4");
    let rep = job::run(&r, &p, &comp, &s, &[], &ctl, &|_| {}).expect("h264 export");
    assert!(rep.validation.ok, "{:?}", rep.validation.messages);
    assert!(rep.validation.has_audio);
    assert_eq!((rep.validation.width, rep.validation.height), (320, 180));
    assert!(rep.file_size > 1000);

    // ProRes 4444 with alpha: the transparent corner must decode with alpha 0.
    let s = settings("prores4444", "mov", true, "alpha.mov");
    let rep = job::run(&r, &p, &comp, &s, &[], &ctl, &|_| {}).expect("prores export");
    assert!(rep.validation.ok && rep.validation.has_alpha, "{:?} {}", rep.validation.messages, rep.validation.pix_fmt);
    assert_eq!(alpha_at(&s.path, 5, 5), 0, "background must be transparent in ProRes 4444");
    assert!(alpha_at(&s.path, 100, 90) > 240, "shape must be opaque");

    // VP9 WebM with alpha.
    let s = settings("vp9", "webm", true, "alpha.webm");
    let rep = job::run(&r, &p, &comp, &s, &[], &ctl, &|_| {}).expect("vp9 export");
    assert!(rep.validation.ok && rep.validation.has_alpha, "{:?}", rep.validation.messages);

    // PNG sequence: 25 RGBA frames.
    let s = settings("png_seq", "png", true, "seq/frame.png");
    let rep = job::run(&r, &p, &comp, &s, &[], &ctl, &|_| {}).expect("png export");
    let pngs = std::fs::read_dir(out_dir().join("seq")).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "png")).count();
    assert_eq!(pngs, 25);
    assert!(rep.validation.has_alpha);
    let first = out_dir().join("seq").join("frame_00000.png");
    assert_eq!(alpha_at(first.to_str().unwrap(), 5, 5), 0);
    assert!(out_dir().join("seq").join("audio.wav").exists(), "sidecar audio for sequences");

    // Requesting alpha from H.264 is refused rather than silently dropped.
    let bad = settings("h264", "mp4", true, "bad.mp4");
    assert!(job::run(&r, &p, &comp, &bad, &[], &ctl, &|_| {}).is_err());
}
