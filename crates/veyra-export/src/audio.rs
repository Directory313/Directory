//! Audio mixdown via an FFmpeg filter graph: every audible clip (including clips inside
//! nested compositions) becomes an input with trim, speed, reverse, volume automation,
//! pan, fades and its audio-effect chain, delayed into place and summed.

use veyra_core::anim::Prop;
use veyra_core::model::*;

#[derive(Clone, Debug)]
pub struct AudioClip {
    pub path: String,
    /// Composition time the clip starts (relative to the mix start).
    pub start: f64,
    pub source_in: f64,
    pub duration: f64,
    pub speed: f64,
    pub reverse: bool,
    pub volume: Prop<f64>,
    /// Seconds to add to clip-local time when evaluating `volume` keyframes.
    pub key_offset: f64,
    pub pan: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub effects: Vec<Effect>,
    pub gain_db: f64,
}

/// Collect audible clips of `comp` within [t0, t1), recursing into nested compositions.
pub fn collect(p: &Project, comp: &Composition, t0: f64, t1: f64, offset: f64, gain_db: f64, depth: u32, out: &mut Vec<AudioClip>) {
    if depth > 16 {
        return;
    }
    let solo = comp.layers.iter().any(|l| l.solo);
    for l in &comp.layers {
        if l.muted || (solo && !l.solo) {
            continue;
        }
        let (a, b) = (l.start.max(t0), l.end().min(t1));
        if b <= a {
            continue;
        }
        match &l.kind {
            LayerKind::Media { asset } | LayerKind::Audio { asset } => {
                let Some(asset) = p.asset(asset) else { continue };
                if !asset.info.has_audio || asset.missing {
                    continue;
                }
                let cut = a - l.start;
                let source_in = if l.reverse { l.source_in + (l.end() - b) * l.speed } else { l.source_in + cut * l.speed };
                out.push(AudioClip {
                    path: asset.path.clone(),
                    start: a - t0 + offset,
                    source_in,
                    duration: b - a,
                    speed: if l.freeze_at.is_some() { 1.0 } else { l.speed },
                    reverse: l.reverse,
                    volume: l.audio.volume.clone(),
                    key_offset: cut,
                    pan: l.audio.pan.value,
                    fade_in: if cut <= 1e-6 { l.audio.fade_in } else { 0.0 },
                    fade_out: if (l.end() - b).abs() <= 1e-6 { l.audio.fade_out } else { 0.0 },
                    effects: l.audio.effects.clone(),
                    gain_db,
                });
            }
            LayerKind::Comp { comp: id, .. } => {
                let Some(nested) = p.comp(id) else { continue };
                // Nested time = source_in + (t - start) * speed (speed changes are not applied to
                // nested audio pitch; clips are re-timed only).
                let n0 = l.source_in + (a - l.start) * l.speed;
                let n1 = l.source_in + (b - l.start) * l.speed;
                collect(p, nested, n0, n1, a - t0 + offset, gain_db + l.audio.volume.value, depth + 1, out);
            }
            _ => {}
        }
    }
}

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Piecewise-linear gain expression of `t` (clip-local seconds) for FFmpeg's volume filter.
pub fn volume_expr(v: &Prop<f64>, key_offset: f64, gain_db: f64) -> String {
    if v.keys.is_empty() {
        return format!("{:.6}", db_to_gain(v.value + gain_db));
    }
    let keys: Vec<(f64, f64)> = v.keys.iter().map(|k| (k.t - key_offset, db_to_gain(k.v + gain_db))).collect();
    let mut expr = format!("{:.6}", keys.last().unwrap().1);
    for w in keys.windows(2).rev() {
        let ((t0, g0), (t1, g1)) = (w[0], w[1]);
        let seg = if (t1 - t0).abs() < 1e-9 { format!("{g1:.6}") } else { format!("{g0:.6}+({:.6})*(t-{t0:.6})/{:.6}", g1 - g0, t1 - t0) };
        expr = format!("if(lt(t,{t1:.6}),{seg},{expr})");
    }
    format!("if(lt(t,{:.6}),{:.6},{expr})", keys[0].0, keys[0].1)
}

fn atempo_chain(speed: f64) -> Vec<String> {
    let mut s = speed.clamp(0.01, 100.0);
    let mut out = vec![];
    while s >= 2.0 - 1e-9 {
        out.push("atempo=2.0".into());
        s /= 2.0;
    }
    while s <= 0.5 + 1e-9 {
        out.push("atempo=0.5".into());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-6 {
        out.push(format!("atempo={s:.6}"));
    }
    out
}

fn effect_filters(e: &Effect, sr: u32) -> Vec<String> {
    let n = |k: &str| e.params.get(k).map(|p| p.value.num()).unwrap_or(0.0);
    match e.kind.as_str() {
        "aEqualizer" => vec![
            format!("equalizer=f=100:t=q:w=1:g={}", n("low")),
            format!("equalizer=f=1000:t=q:w=1:g={}", n("mid")),
            format!("equalizer=f=8000:t=q:w=1:g={}", n("high")),
        ],
        "aCompressor" => vec![format!(
            "acompressor=threshold={}dB:ratio={}:attack={}:release={}:makeup={}",
            n("threshold"),
            n("ratio").max(1.0),
            n("attack").max(0.01),
            n("release").max(0.01),
            db_to_gain(n("makeup")).clamp(1.0, 64.0)
        )],
        "aLimiter" => vec![format!("alimiter=limit={}:release={}:level=false", db_to_gain(n("ceiling")).clamp(0.0625, 1.0), n("release").max(1.0))],
        "aReverb" => {
            let r = n("room").clamp(0.0, 1.0);
            let wet = n("mix").clamp(0.0, 1.0);
            vec![format!(
                "aecho=in_gain=1:out_gain={:.3}:delays={}|{}|{}:decays={:.3}|{:.3}|{:.3}",
                1.0 - wet * 0.4,
                (30.0 + 60.0 * r) as u32,
                (55.0 + 90.0 * r) as u32,
                (80.0 + 130.0 * r) as u32,
                0.3 * wet + 0.2 * r,
                0.25 * wet + 0.15 * r,
                0.2 * wet + 0.1 * r
            )]
        }
        "aDelay" => vec![format!("aecho=in_gain=1:out_gain={:.3}:delays={}:decays={:.3}", 1.0 - n("mix") * 0.3, n("delay").max(1.0), n("feedback").clamp(0.0, 0.95) * n("mix").clamp(0.0, 1.0))],
        "aDistortion" => vec![format!("acrusher=bits={}:mix={:.3}:mode=log", (16.0 - n("drive") * 12.0).max(2.0), n("drive").clamp(0.0, 1.0))],
        "aNoiseReduction" => vec![format!("afftdn=nr={}:nf={}", n("amount").clamp(0.01, 97.0), n("floor").clamp(-80.0, -20.0))],
        "aNoiseGate" => vec![format!("agate=threshold={}:ratio={}:attack={}:release={}", db_to_gain(n("threshold")).clamp(0.0, 1.0), n("ratio").max(1.0), n("attack").max(0.01), n("release").max(0.01))],
        "aStereoWiden" => vec![format!("stereowiden=delay=20:feedback={:.3}:crossfeed=0.3:drymix=0.8", n("width").clamp(0.0, 0.9))],
        "aPitch" => {
            let ratio = 2f64.powf(n("semitones") / 12.0);
            vec![format!("rubberband=pitch={ratio:.6}")]
        }
        "aTimeStretch" => atempo_chain(n("tempo")),
        "aHighPass" => vec![format!("highpass=f={}", n("freq").max(10.0))],
        "aLowPass" => vec![format!("lowpass=f={}", n("freq").clamp(20.0, sr as f64 / 2.0 - 1.0))],
        _ => vec![],
    }
}

/// Build FFmpeg input args and a filter graph producing `[aout]` of length `total`.
/// `first_input` is the index of the first audio input (after the video pipe).
pub fn build_mix(clips: &[AudioClip], total: f64, sr: u32, channels: u32, first_input: usize) -> (Vec<String>, String) {
    let mut inputs = Vec::new();
    let mut graph = Vec::new();
    let layout = if channels == 1 { "mono" } else { "stereo" };
    for (i, c) in clips.iter().enumerate() {
        let span = c.duration * c.speed.max(0.01);
        inputs.extend(["-ss".to_string(), format!("{:.6}", c.source_in.max(0.0)), "-t".into(), format!("{span:.6}"), "-i".into(), c.path.clone()]);
        let mut f = vec![format!("aformat=sample_fmts=fltp:sample_rates={sr}:channel_layouts={layout}"), "asetpts=PTS-STARTPTS".to_string()];
        if c.reverse {
            f.push("areverse".into());
        }
        f.extend(atempo_chain(c.speed));
        // Clip-local t = 0 corresponds to layer-local time `key_offset`.
        f.push(format!("volume='{}':eval=frame", volume_expr(&c.volume, c.key_offset, c.gain_db)));
        if channels >= 2 && c.pan.abs() > 1e-4 {
            let (l, r) = ((1.0 - c.pan).clamp(0.0, 1.0), (1.0 + c.pan).clamp(0.0, 1.0));
            f.push(format!("pan=stereo|c0={l:.4}*c0|c1={r:.4}*c1"));
        }
        if c.fade_in > 0.0 {
            f.push(format!("afade=t=in:st=0:d={:.4}", c.fade_in));
        }
        if c.fade_out > 0.0 {
            f.push(format!("afade=t=out:st={:.4}:d={:.4}", (c.duration - c.fade_out).max(0.0), c.fade_out));
        }
        for e in c.effects.iter().filter(|e| e.enabled) {
            f.extend(effect_filters(e, sr));
        }
        f.push(format!("atrim=0:{:.6}", c.duration));
        let ms = (c.start * 1000.0).round().max(0.0) as u64;
        f.push(format!("adelay={ms}:all=1"));
        graph.push(format!("[{}:a]{}[a{i}]", first_input + i, f.join(",")));
    }
    let n = clips.len();
    let mix = if n == 0 {
        format!("anullsrc=r={sr}:cl={layout},atrim=0:{total:.6}[aout]")
    } else {
        let ins: String = (0..n).map(|i| format!("[a{i}]")).collect();
        format!("{ins}amix=inputs={n}:normalize=0:duration=longest,apad,atrim=0:{total:.6},aformat=sample_rates={sr}:channel_layouts={layout}[aout]")
    };
    graph.push(mix);
    (inputs, graph.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_expression_is_piecewise() {
        let mut v = Prop::new(0.0);
        v.set_key(0.0, 0.0);
        v.set_key(1.0, -6.0);
        let e = volume_expr(&v, 0.0, 0.0);
        assert!(e.starts_with("if(lt(t,0.000000),1.000000"));
        assert!(e.contains("if(lt(t,1.000000)"));
        assert_eq!(volume_expr(&Prop::new(-6.0), 0.0, 0.0), format!("{:.6}", db_to_gain(-6.0)));
    }

    #[test]
    fn atempo_ranges() {
        assert_eq!(atempo_chain(4.0), vec!["atempo=2.0", "atempo=2.0"]);
        assert_eq!(atempo_chain(0.25), vec!["atempo=0.5", "atempo=0.5"]);
        assert!(atempo_chain(1.0).is_empty());
    }
}
