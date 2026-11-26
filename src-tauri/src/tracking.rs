//! Point / multi-point tracking by normalised cross-correlation with sub-pixel refinement.
//! Results feed the animation system (track-to-null, stabilisation, mask tracking).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use veyra_media::{DecoderPool, Source};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRequest {
    pub asset: String,
    /// Source-time range in seconds.
    pub start: f64,
    pub end: f64,
    /// Feature points in source pixels.
    pub points: Vec<[f64; 2]>,
    /// Template half-size and search radius in source pixels.
    pub patch: f64,
    pub search: f64,
    /// Analysis resolution scale (0.25..1).
    pub scale: f64,
    #[serde(default)]
    pub backwards: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackResult {
    /// For each frame: source time and the tracked position of every point (source px).
    pub frames: Vec<(f64, Vec<[f64; 2]>)>,
    /// Per-point confidence (mean correlation, 0..1).
    pub confidence: Vec<f64>,
    pub lost_at: Option<f64>,
}

fn gray(data: &[u8]) -> Vec<f32> {
    data.chunks_exact(4).map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32).collect()
}

/// Best NCC match of template `tpl` (side `ts`) around (cx, cy) within radius `r`.
fn search(img: &[f32], w: usize, h: usize, tpl: &[f32], ts: usize, cx: f64, cy: f64, r: usize) -> Option<(f64, f64, f32)> {
    let half = ts / 2;
    let tm = tpl.iter().sum::<f32>() / tpl.len() as f32;
    let tv: f32 = tpl.iter().map(|v| (v - tm) * (v - tm)).sum::<f32>().sqrt().max(1e-3);
    let (cx, cy) = (cx.round() as i64, cy.round() as i64);
    let ri = r as i64;
    let scores: Vec<(i64, i64, f32)> = (-ri..=ri)
        .into_par_iter()
        .flat_map_iter(|dy| (-ri..=ri).map(move |dx| (dx, dy)))
        .filter_map(|(dx, dy)| {
            let (x0, y0) = (cx + dx - half as i64, cy + dy - half as i64);
            if x0 < 0 || y0 < 0 || x0 as usize + ts >= w || y0 as usize + ts >= h {
                return None;
            }
            let mut sum = 0.0f32;
            for j in 0..ts {
                let row = (y0 as usize + j) * w + x0 as usize;
                for i in 0..ts {
                    sum += img[row + i];
                }
            }
            let m = sum / (ts * ts) as f32;
            let (mut num, mut var) = (0.0f32, 0.0f32);
            for j in 0..ts {
                let row = (y0 as usize + j) * w + x0 as usize;
                for i in 0..ts {
                    let a = img[row + i] - m;
                    num += a * (tpl[j * ts + i] - tm);
                    var += a * a;
                }
            }
            Some((dx, dy, num / (var.sqrt().max(1e-3) * tv)))
        })
        .collect();
    let best = scores.iter().cloned().max_by(|a, b| a.2.partial_cmp(&b.2).unwrap())?;
    // Parabolic sub-pixel refinement.
    let at = |dx: i64, dy: i64| scores.iter().find(|s| s.0 == dx && s.1 == dy).map(|s| s.2);
    let refine = |m: Option<f32>, c: f32, p: Option<f32>| match (m, p) {
        (Some(m), Some(p)) => {
            let d = m - 2.0 * c + p;
            if d.abs() > 1e-6 { (0.5 * (m - p) / d).clamp(-0.5, 0.5) as f64 } else { 0.0 }
        }
        _ => 0.0,
    };
    let sx = refine(at(best.0 - 1, best.1), best.2, at(best.0 + 1, best.1));
    let sy = refine(at(best.0, best.1 - 1), best.2, at(best.0, best.1 + 1));
    Some(((cx + best.0) as f64 + sx, (cy + best.1) as f64 + sy, best.2))
}

fn template(img: &[f32], w: usize, cx: f64, cy: f64, ts: usize) -> Vec<f32> {
    let half = ts as i64 / 2;
    let (x0, y0) = (cx.round() as i64 - half, cy.round() as i64 - half);
    let mut t = vec![0.0; ts * ts];
    for j in 0..ts {
        for i in 0..ts {
            let (x, y) = ((x0 + i as i64).max(0) as usize, (y0 + j as i64).max(0) as usize);
            t[j * ts + i] = img.get(y * w + x.min(w - 1)).copied().unwrap_or(0.0);
        }
    }
    t
}

pub fn track(pool: &DecoderPool, src: &Source, sw: u32, sh: u32, req: &TrackRequest, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<TrackResult, String> {
    let s = req.scale.clamp(0.1, 1.0);
    let (w, h) = (((sw as f64 * s) as u32).max(16) & !1, ((sh as f64 * s) as u32).max(16) & !1);
    let fps = src.fps.max(1.0);
    let n = ((req.end - req.start).abs() * fps).round() as i64;
    let ts = ((req.patch * 2.0 * s) as usize).clamp(5, 128) | 1;
    let r = ((req.search * s) as usize).clamp(2, 128);
    let frame_at = |i: i64| -> Result<Vec<f32>, String> {
        let t = if req.backwards { req.start - i as f64 / fps } else { req.start + i as f64 / fps };
        let f = pool.frame(src, t.max(0.0), w, h).map_err(|e| e.to_string())?.ok_or("no frame")?;
        Ok(gray(&f.data))
    };
    let mut pts: Vec<(f64, f64)> = req.points.iter().map(|p| (p[0] * s, p[1] * s)).collect();
    let first = frame_at(0)?;
    let mut templates: Vec<Vec<f32>> = pts.iter().map(|(x, y)| template(&first, w as usize, *x, *y, ts)).collect();
    let mut frames = vec![(req.start, req.points.clone())];
    let mut conf_sum = vec![0.0; pts.len()];
    let mut lost_at = None;
    for i in 1..=n {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let img = frame_at(i)?;
        let t = if req.backwards { req.start - i as f64 / fps } else { req.start + i as f64 / fps };
        let mut out = Vec::with_capacity(pts.len());
        for (k, p) in pts.iter_mut().enumerate() {
            match search(&img, w as usize, h as usize, &templates[k], ts, p.0, p.1, r) {
                Some((x, y, c)) => {
                    conf_sum[k] += c.max(0.0) as f64;
                    if c < 0.5 && lost_at.is_none() {
                        lost_at = Some(t);
                    }
                    *p = (x, y);
                    // Adaptive template: blend toward the new appearance when confident.
                    if c > 0.85 {
                        let nt = template(&img, w as usize, x, y, ts);
                        for (a, b) in templates[k].iter_mut().zip(nt) {
                            *a = *a * 0.8 + b * 0.2;
                        }
                    }
                }
                None => {
                    if lost_at.is_none() {
                        lost_at = Some(t);
                    }
                }
            }
            out.push([p.0 / s, p.1 / s]);
        }
        frames.push((t, out));
        progress(i as f64 / n.max(1) as f64);
    }
    Ok(TrackResult { frames, confidence: conf_sum.iter().map(|c| c / n.max(1) as f64).collect(), lost_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_shifted_blob() {
        let (w, h) = (64usize, 64usize);
        let blob = |cx: f64, cy: f64| -> Vec<f32> {
            (0..w * h).map(|i| {
                let (x, y) = ((i % w) as f64, (i / w) as f64);
                (255.0 * (-((x - cx).powi(2) + (y - cy).powi(2)) / 20.0).exp()) as f32
            }).collect()
        };
        let a = blob(30.0, 30.0);
        let b = blob(34.0, 27.0);
        let tpl = template(&a, w, 30.0, 30.0, 11);
        let (x, y, c) = search(&b, w, h, &tpl, 11, 30.0, 30.0, 8).unwrap();
        assert!((x - 34.0).abs() < 0.6 && (y - 27.0).abs() < 0.6, "{x},{y}");
        assert!(c > 0.9);
    }
}
