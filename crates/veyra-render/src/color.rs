//! Colour utilities: curve LUTs, .cube 3D LUT parsing and video scopes.

use serde::Serialize;

/// Monotone cubic (Fritsch–Carlson) interpolation through control points in 0..1.
pub fn eval_curve(points: &[[f64; 2]], x: f64) -> f64 {
    let mut p: Vec<[f64; 2]> = points.iter().copied().filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    p.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap());
    p.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-9);
    match p.len() {
        0 => return x,
        1 => return p[0][1],
        _ => {}
    }
    if x <= p[0][0] {
        return p[0][1];
    }
    if x >= p[p.len() - 1][0] {
        return p[p.len() - 1][1];
    }
    let n = p.len();
    let d: Vec<f64> = (0..n - 1).map(|i| (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0])).collect();
    let mut m = vec![0.0; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                m[i] = t * a * d[i];
                m[i + 1] = t * b * d[i];
            }
        }
    }
    let i = p.windows(2).position(|w| x >= w[0][0] && x <= w[1][0]).unwrap_or(n - 2);
    let h = p[i + 1][0] - p[i][0];
    let t = (x - p[i][0]) / h;
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * p[i][1] + (t3 - 2.0 * t2 + t) * h * m[i] + (-2.0 * t3 + 3.0 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]
}

pub fn parse_points(s: &str) -> Vec<[f64; 2]> {
    serde_json::from_str::<Vec<[f64; 2]>>(s).unwrap_or_default()
}

pub fn curve_row(s: Option<&str>, default_flat: Option<f64>) -> [u8; 256] {
    let pts = s.map(parse_points).filter(|p| !p.is_empty());
    let mut row = [0u8; 256];
    for (i, v) in row.iter_mut().enumerate() {
        let x = i as f64 / 255.0;
        let y = match (&pts, default_flat) {
            (Some(p), _) => eval_curve(p, x),
            (None, Some(f)) => f,
            (None, None) => x,
        };
        *v = (y.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    row
}

/// Rows: 0 master, 1 r, 2 g, 3 b (identity); 4 hue→hue (identity); 5..7 flat 0.5 (no change).
pub fn identity_curve_rows() -> [[u8; 256]; 8] {
    [
        curve_row(None, None),
        curve_row(None, None),
        curve_row(None, None),
        curve_row(None, None),
        curve_row(None, None),
        curve_row(None, Some(0.5)),
        curve_row(None, Some(0.5)),
        curve_row(None, Some(0.5)),
    ]
}

pub fn identity_lut(n: u32) -> Vec<f32> {
    let mut v = Vec::with_capacity((n * n * n * 4) as usize);
    let s = (n - 1).max(1) as f32;
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                v.extend_from_slice(&[r as f32 / s, g as f32 / s, b as f32 / s, 1.0]);
            }
        }
    }
    v
}

/// Parse an Adobe/Resolve `.cube` 3D LUT. Returns (size, RGBA floats, r fastest).
pub fn parse_cube(src: &str) -> Result<(u32, Vec<f32>), String> {
    let mut size = 0u32;
    let (mut dmin, mut dmax) = ([0.0f32; 3], [1.0f32; 3]);
    let mut data = Vec::new();
    for line in src.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with("TITLE") {
            continue;
        }
        let mut it = l.split_whitespace();
        match it.next() {
            Some("LUT_3D_SIZE") => size = it.next().and_then(|v| v.parse().ok()).ok_or("bad LUT_3D_SIZE")?,
            Some("LUT_1D_SIZE") => return Err("1D LUTs are not supported; use a 3D .cube".into()),
            Some("DOMAIN_MIN") => {
                for v in dmin.iter_mut() {
                    *v = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
                }
            }
            Some("DOMAIN_MAX") => {
                for v in dmax.iter_mut() {
                    *v = it.next().and_then(|x| x.parse().ok()).unwrap_or(1.0);
                }
            }
            Some(first) => {
                if let (Ok(r), Some(g), Some(b)) = (first.parse::<f32>(), it.next().and_then(|x| x.parse::<f32>().ok()), it.next().and_then(|x| x.parse::<f32>().ok())) {
                    data.extend_from_slice(&[(r - dmin[0]) / (dmax[0] - dmin[0]), (g - dmin[1]) / (dmax[1] - dmin[1]), (b - dmin[2]) / (dmax[2] - dmin[2]), 1.0]);
                }
            }
            None => {}
        }
    }
    if size < 2 || size > 128 {
        return Err("missing or invalid LUT_3D_SIZE".into());
    }
    if data.len() != (size * size * size * 4) as usize {
        return Err(format!("expected {} entries, found {}", size * size * size, data.len() / 4));
    }
    Ok((size, data))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scopes {
    /// 256 bins each for r, g, b, luma.
    pub histogram: [Vec<u32>; 4],
    /// Waveform: `cols` columns × 64 luma bins (counts).
    pub waveform: Vec<u16>,
    /// RGB parade: 3 × cols × 64.
    pub parade: Vec<u16>,
    /// Vectorscope: 64×64 Cb/Cr density.
    pub vectorscope: Vec<u16>,
    pub cols: u32,
}

/// Compute scopes from a straight-alpha RGBA8 frame.
pub fn scopes(data: &[u8], w: u32, h: u32) -> Scopes {
    let cols = w.min(256);
    let mut s = Scopes { histogram: [vec![0; 256], vec![0; 256], vec![0; 256], vec![0; 256]], waveform: vec![0; (cols * 64) as usize], parade: vec![0; (3 * cols * 64) as usize], vectorscope: vec![0; 64 * 64], cols };
    let step = ((w * h) as usize / 400_000).max(1);
    for (i, px) in data.chunks_exact(4).enumerate().step_by(step) {
        if px[3] == 0 {
            continue;
        }
        let (r, g, b) = (px[0] as f32, px[1] as f32, px[2] as f32);
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        s.histogram[0][px[0] as usize] += 1;
        s.histogram[1][px[1] as usize] += 1;
        s.histogram[2][px[2] as usize] += 1;
        s.histogram[3][(y as usize).min(255)] += 1;
        let x = ((i as u32 % w) * cols / w) as usize;
        let bin = |v: f32| (63 - ((v / 255.0) * 63.0) as usize).min(63);
        let c = cols as usize;
        s.waveform[bin(y) * c + x] = s.waveform[bin(y) * c + x].saturating_add(1);
        for (k, v) in [r, g, b].iter().enumerate() {
            let idx = k * c * 64 + bin(*v) * c + x;
            s.parade[idx] = s.parade[idx].saturating_add(1);
        }
        let cb = (-0.1146 * r - 0.3854 * g + 0.5 * b) / 255.0;
        let cr = (0.5 * r - 0.4542 * g - 0.0458 * b) / 255.0;
        let vx = ((cb + 0.5) * 63.0).clamp(0.0, 63.0) as usize;
        let vy = ((0.5 - cr) * 63.0).clamp(0.0, 63.0) as usize;
        s.vectorscope[vy * 64 + vx] = s.vectorscope[vy * 64 + vx].saturating_add(1);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_identity_and_monotone() {
        let id = [[0.0, 0.0], [1.0, 1.0]];
        assert!((eval_curve(&id, 0.3) - 0.3).abs() < 1e-9);
        let s = [[0.0, 0.0], [0.25, 0.15], [0.75, 0.85], [1.0, 1.0]];
        let mut last = -1.0;
        for i in 0..=100 {
            let v = eval_curve(&s, i as f64 / 100.0);
            assert!(v >= last - 1e-9);
            last = v;
        }
    }

    #[test]
    fn cube_parse() {
        let mut src = String::from("TITLE \"t\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    src.push_str(&format!("{r} {g} {b}\n"));
                }
            }
        }
        let (n, d) = parse_cube(&src).unwrap();
        assert_eq!(n, 2);
        assert_eq!(d, identity_lut(2));
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err());
    }
}
