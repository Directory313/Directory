//! CPU vector rasterisation (premultiplied RGBA8) for text, shapes, masks, particles and SVG.
//! Results are uploaded to the GPU and composited there.

use parking_lot::Mutex;
use resvg::tiny_skia as sk;
use std::sync::OnceLock;
use veyra_core::anim::*;
use veyra_core::eval::EvalCtx;
use veyra_core::expr::noise1;
use veyra_core::model::*;

pub fn color(c: Color, alpha_mul: f64) -> sk::Color {
    sk::Color::from_rgba(c[0].clamp(0.0, 1.0) as f32, c[1].clamp(0.0, 1.0) as f32, c[2].clamp(0.0, 1.0) as f32, (c[3] * alpha_mul).clamp(0.0, 1.0) as f32)
        .unwrap_or(sk::Color::TRANSPARENT)
}

pub fn bez_to_skia(p: &BezPath, s: f64) -> Option<sk::Path> {
    let v = &p.vertices;
    if v.len() < 2 {
        return None;
    }
    let mut b = sk::PathBuilder::new();
    let pt = |x: [f64; 2]| ((x[0] * s) as f32, (x[1] * s) as f32);
    let (x0, y0) = pt(v[0].p);
    b.move_to(x0, y0);
    let n = v.len();
    let segs = if p.closed { n } else { n - 1 };
    for i in 0..segs {
        let a = &v[i];
        let c = &v[(i + 1) % n];
        let (c1x, c1y) = pt([a.p[0] + a.o[0], a.p[1] + a.o[1]]);
        let (c2x, c2y) = pt([c.p[0] + c.i[0], c.p[1] + c.i[1]]);
        let (ex, ey) = pt(c.p);
        if a.o == [0.0, 0.0] && c.i == [0.0, 0.0] {
            b.line_to(ex, ey);
        } else {
            b.cubic_to(c1x, c1y, c2x, c2y, ex, ey);
        }
    }
    if p.closed {
        b.close();
    }
    b.finish()
}

/// Approximate path length by flattening (used for trim paths).
fn path_length(p: &sk::Path) -> f32 {
    let mut len = 0.0f32;
    let mut cur = sk::Point::zero();
    let mut start = cur;
    for seg in p.segments() {
        match seg {
            sk::PathSegment::MoveTo(q) => {
                cur = q;
                start = q;
            }
            sk::PathSegment::LineTo(q) => {
                len += cur.distance(q);
                cur = q;
            }
            sk::PathSegment::QuadTo(c, q) => {
                let mut prev = cur;
                for i in 1..=16 {
                    let t = i as f32 / 16.0;
                    let mt = 1.0 - t;
                    let x = mt * mt * cur.x + 2.0 * mt * t * c.x + t * t * q.x;
                    let y = mt * mt * cur.y + 2.0 * mt * t * c.y + t * t * q.y;
                    let np = sk::Point::from_xy(x, y);
                    len += prev.distance(np);
                    prev = np;
                }
                cur = q;
            }
            sk::PathSegment::CubicTo(c1, c2, q) => {
                let mut prev = cur;
                for i in 1..=24 {
                    let t = i as f32 / 24.0;
                    let mt = 1.0 - t;
                    let x = mt * mt * mt * cur.x + 3.0 * mt * mt * t * c1.x + 3.0 * mt * t * t * c2.x + t * t * t * q.x;
                    let y = mt * mt * mt * cur.y + 3.0 * mt * mt * t * c1.y + 3.0 * mt * t * t * c2.y + t * t * t * q.y;
                    let np = sk::Point::from_xy(x, y);
                    len += prev.distance(np);
                    prev = np;
                }
                cur = q;
            }
            sk::PathSegment::Close => {
                len += cur.distance(start);
                cur = start;
            }
        }
    }
    len
}

fn gradient_shader(g: &Gradient, alpha: f64, s: f64, origin: (f32, f32)) -> Option<sk::Shader<'static>> {
    let stops: Vec<sk::GradientStop> = g.stops.iter().map(|st| sk::GradientStop::new(st.pos.clamp(0.0, 1.0) as f32, color(st.color, alpha))).collect();
    if stops.len() < 2 {
        return None;
    }
    let p0 = sk::Point::from_xy(origin.0 + (g.start[0] * s) as f32, origin.1 + (g.start[1] * s) as f32);
    let p1 = sk::Point::from_xy(origin.0 + (g.end[0] * s) as f32, origin.1 + (g.end[1] * s) as f32);
    if g.radial {
        sk::RadialGradient::new(p0, p0, p0.distance(p1).max(0.5), stops, sk::SpreadMode::Pad, sk::Transform::identity())
    } else {
        sk::LinearGradient::new(p0, p1, stops, sk::SpreadMode::Pad, sk::Transform::identity())
    }
}

fn paint_for(c: Color, gradient: Option<&Gradient>, alpha: f64, s: f64, origin: (f32, f32)) -> sk::Paint<'static> {
    let mut p = sk::Paint { anti_alias: true, ..Default::default() };
    match gradient.and_then(|g| gradient_shader(g, alpha, s, origin)) {
        Some(sh) => p.shader = sh,
        None => p.set_color(color(c, alpha)),
    }
    p
}

// ------------------------------------------------------------------ shapes

fn polygon_path(points: f64, outer: f64, inner: f64, star: bool, roundness: f64) -> BezPath {
    let n = points.round().max(3.0) as usize;
    let count = if star { n * 2 } else { n };
    let mut vertices = Vec::with_capacity(count);
    for i in 0..count {
        let a = -std::f64::consts::FRAC_PI_2 + i as f64 * std::f64::consts::TAU / count as f64;
        let r = if star && i % 2 == 1 { inner } else { outer };
        let p = [a.cos() * r, a.sin() * r];
        // Roundness: tangent handles perpendicular to the radius.
        let k = roundness / 100.0 * r * 0.5;
        let t = [-a.sin() * k, a.cos() * k];
        vertices.push(PathVertex { p, i: [-t[0], -t[1]], o: t });
    }
    BezPath { vertices, closed: true }
}

fn geometry_path(ctx: &EvalCtx, layer: &Layer, g: &Geometry, s: f64) -> Option<sk::Path> {
    match g {
        Geometry::Rect { size, roundness } => {
            let sz = ctx.prop(layer, size, "rect.size");
            let r = ctx.prop(layer, roundness, "rect.round").max(0.0).min(sz[0].min(sz[1]) / 2.0);
            let (w, h) = ((sz[0] * s) as f32, (sz[1] * s) as f32);
            if w <= 0.0 || h <= 0.0 {
                return None;
            }
            if r <= 0.0 {
                return sk::PathBuilder::from_rect(sk::Rect::from_xywh(-w / 2.0, -h / 2.0, w, h)?).into();
            }
            let p = BezPath {
                vertices: {
                    let (hw, hh, r) = (sz[0] / 2.0, sz[1] / 2.0, r);
                    let k = r * 0.5523;
                    vec![
                        PathVertex { p: [-hw + r, -hh], i: [-k, 0.0], o: [0.0, 0.0] },
                        PathVertex { p: [hw - r, -hh], i: [0.0, 0.0], o: [k, 0.0] },
                        PathVertex { p: [hw, -hh + r], i: [0.0, -k], o: [0.0, 0.0] },
                        PathVertex { p: [hw, hh - r], i: [0.0, 0.0], o: [0.0, k] },
                        PathVertex { p: [hw - r, hh], i: [k, 0.0], o: [0.0, 0.0] },
                        PathVertex { p: [-hw + r, hh], i: [0.0, 0.0], o: [-k, 0.0] },
                        PathVertex { p: [-hw, hh - r], i: [0.0, k], o: [0.0, 0.0] },
                        PathVertex { p: [-hw, -hh + r], i: [0.0, 0.0], o: [0.0, -k] },
                    ]
                },
                closed: true,
            };
            bez_to_skia(&p, s)
        }
        Geometry::Ellipse { size } => {
            let sz = ctx.prop(layer, size, "ellipse.size");
            let (w, h) = ((sz[0] * s) as f32, (sz[1] * s) as f32);
            sk::PathBuilder::from_oval(sk::Rect::from_xywh(-w / 2.0, -h / 2.0, w.max(0.01), h.max(0.01))?)
        }
        Geometry::Polygon { points, outer_radius, inner_radius, star, roundness } => {
            let p = polygon_path(
                ctx.prop(layer, points, "poly.points"),
                ctx.prop(layer, outer_radius, "poly.outer"),
                ctx.prop(layer, inner_radius, "poly.inner"),
                *star,
                ctx.prop(layer, roundness, "poly.round"),
            );
            bez_to_skia(&p, s)
        }
        Geometry::Line { to } => {
            let t = ctx.prop(layer, to, "line.to");
            let mut b = sk::PathBuilder::new();
            b.move_to(0.0, 0.0);
            b.line_to((t[0] * s) as f32, (t[1] * s) as f32);
            b.finish()
        }
        Geometry::Arrow { to, head } => {
            let t = ctx.prop(layer, to, "arrow.to");
            let h = ctx.prop(layer, head, "arrow.head") * s;
            let (ex, ey) = (t[0] * s, t[1] * s);
            let ang = ey.atan2(ex);
            let mut b = sk::PathBuilder::new();
            b.move_to(0.0, 0.0);
            b.line_to(ex as f32, ey as f32);
            for d in [2.6f64, -2.6] {
                b.move_to(ex as f32, ey as f32);
                b.line_to((ex + (ang + d).cos() * h) as f32, (ey + (ang + d).sin() * h) as f32);
            }
            b.finish()
        }
        Geometry::Path { path } => {
            let p = path.at(ctx.time - layer.start);
            bez_to_skia(&p, s)
        }
    }
}

fn draw_item(pm: &mut sk::Pixmap, ctx: &EvalCtx, layer: &Layer, item: &ShapeItem, s: f64, base: sk::Transform, alpha: f64, blend: sk::BlendMode) {
    let Some(path) = geometry_path(ctx, layer, &item.geometry, s) else { return };
    let off = ctx.prop(layer, &item.offset, &format!("{}.offset", item.id));
    let rot = ctx.prop(layer, &item.rotation, &format!("{}.rot", item.id));
    let xf = base.pre_translate((off[0] * s) as f32, (off[1] * s) as f32).pre_rotate(rot as f32);
    let origin = (0.0, 0.0);
    for f in item.fills.iter().filter(|f| f.enabled) {
        let c = ctx.prop(layer, &f.color, &format!("{}.fill", item.id));
        let o = ctx.prop(layer, &f.opacity, &format!("{}.fillop", item.id)) / 100.0;
        let mut paint = paint_for(c, f.gradient.as_ref(), o * alpha, s, origin);
        paint.blend_mode = blend;
        pm.fill_path(&path, &paint, sk::FillRule::Winding, xf, None);
    }
    for st in item.strokes.iter().filter(|st| st.enabled) {
        let w = ctx.prop(layer, &st.width, &format!("{}.sw", item.id)) * s;
        if w <= 0.0 {
            continue;
        }
        let c = ctx.prop(layer, &st.color, &format!("{}.sc", item.id));
        let o = ctx.prop(layer, &st.opacity, &format!("{}.sop", item.id)) / 100.0;
        let mut paint = paint_for(c, st.gradient.as_ref(), o * alpha, s, origin);
        paint.blend_mode = blend;
        let mut stroke = sk::Stroke {
            width: (if st.align == StrokeAlign::Center { w } else { w * 2.0 }) as f32,
            line_cap: match st.cap {
                LineCap::Butt => sk::LineCap::Butt,
                LineCap::Round => sk::LineCap::Round,
                LineCap::Square => sk::LineCap::Square,
            },
            line_join: match st.join {
                LineJoin::Miter => sk::LineJoin::Miter,
                LineJoin::Round => sk::LineJoin::Round,
                LineJoin::Bevel => sk::LineJoin::Bevel,
            },
            ..Default::default()
        };
        // Trim paths are implemented as a single dash covering [start, end].
        if let Some(tr) = &item.trim {
            let len = path_length(&path) * xf.sx.abs().max(xf.sy.abs()).max(1e-3);
            let (a, b, o) = (
                ctx.prop(layer, &tr.start, "trim.s") / 100.0,
                ctx.prop(layer, &tr.end, "trim.e") / 100.0,
                ctx.prop(layer, &tr.offset, "trim.o") / 360.0,
            );
            let (a, b) = (a.min(b), a.max(b));
            let on = ((b - a) as f32 * len).max(0.0);
            if on <= 0.01 {
                continue;
            }
            stroke.dash = sk::StrokeDash::new(vec![on, len * 2.0 + 1.0], -((a + o) as f32 * len));
        } else if st.dashes.len() >= 2 {
            let d: Vec<f32> = st.dashes.iter().map(|v| (v * s).max(0.1) as f32).collect();
            let d = if d.len() % 2 == 1 { [d.clone(), d].concat() } else { d };
            stroke.dash = sk::StrokeDash::new(d, (ctx.prop(layer, &st.dash_offset, "dash.off") * s) as f32);
        }
        let mask = match st.align {
            StrokeAlign::Center => None,
            StrokeAlign::Inside | StrokeAlign::Outside => {
                let mut m = sk::Mask::new(pm.width(), pm.height()).unwrap();
                m.fill_path(&path, sk::FillRule::Winding, true, xf);
                if st.align == StrokeAlign::Outside {
                    m.invert();
                }
                Some(m)
            }
        };
        pm.stroke_path(&path, &paint, &stroke, xf, mask.as_ref());
    }
}

/// Filled outlines of a shape layer in canvas px (scale 1), for 3D extrusion.
pub fn shape_paths(ctx: &EvalCtx, layer: &Layer, sp: &ShapeProps, w: u32, h: u32) -> Vec<sk::Path> {
    let center = sk::Transform::from_translate(w as f32 / 2.0, h as f32 / 2.0);
    sp.items
        .iter()
        .filter_map(|item| {
            let path = geometry_path(ctx, layer, &item.geometry, 1.0)?;
            let off = ctx.prop(layer, &item.offset, &format!("{}.offset", item.id));
            let rot = ctx.prop(layer, &item.rotation, &format!("{}.rot", item.id));
            path.transform(center.pre_translate(off[0] as f32, off[1] as f32).pre_rotate(rot as f32))
        })
        .collect()
}

/// Render a shape layer into a canvas of `w`×`h` (layer source px × scale).
pub fn shape_layer(ctx: &EvalCtx, layer: &Layer, sp: &ShapeProps, w: u32, h: u32, s: f64) -> Option<sk::Pixmap> {
    let mut pm = sk::Pixmap::new(w.max(1), h.max(1))?;
    let center = sk::Transform::from_translate(w as f32 / 2.0, h as f32 / 2.0);
    for (idx, item) in sp.items.iter().enumerate().rev() {
        let blend = if idx == sp.items.len() - 1 {
            sk::BlendMode::SourceOver
        } else {
            match sp.combine {
                BooleanOp::None | BooleanOp::Union => sk::BlendMode::SourceOver,
                BooleanOp::Subtract => sk::BlendMode::DestinationOut,
                BooleanOp::Intersect => sk::BlendMode::DestinationIn,
                BooleanOp::Exclude => sk::BlendMode::Xor,
            }
        };
        match &item.repeater {
            Some(r) => {
                let copies = ctx.prop(layer, &r.copies, "rep.copies").round().clamp(1.0, 1000.0) as usize;
                let off = ctx.prop(layer, &r.offset, "rep.offset");
                let rot = ctx.prop(layer, &r.rotation, "rep.rot");
                let sc = ctx.prop(layer, &r.scale, "rep.scale") / 100.0;
                let op_end = ctx.prop(layer, &r.opacity_end, "rep.opend") / 100.0;
                let radius = ctx.prop(layer, &r.radius, "rep.radius");
                for i in 0..copies {
                    let f = if copies > 1 { i as f64 / (copies - 1) as f64 } else { 0.0 };
                    let alpha = 1.0 + (op_end - 1.0) * f;
                    let xf = if r.radial {
                        let a = i as f64 / copies as f64 * 360.0 + rot * i as f64;
                        center.pre_rotate(a as f32).pre_translate(0.0, (-radius * s) as f32)
                    } else {
                        let k = sc.powi(i as i32) as f32;
                        center.pre_translate((off[0] * s * i as f64) as f32, (off[1] * s * i as f64) as f32).pre_rotate((rot * i as f64) as f32).pre_scale(k, k)
                    };
                    draw_item(&mut pm, ctx, layer, item, s, xf, alpha, blend);
                }
            }
            None => draw_item(&mut pm, ctx, layer, item, s, center, 1.0, blend),
        }
    }
    Some(pm)
}

// ------------------------------------------------------------------ masks

fn box_blur_alpha(data: &mut [u8], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    let mut tmp = vec![0u8; data.len()];
    for _ in 0..3 {
        // horizontal
        for y in 0..h {
            let row = &data[y * w..(y + 1) * w];
            let mut acc: u32 = 0;
            for x in 0..=r.min(w - 1) {
                acc += row[x] as u32;
            }
            acc += row[0] as u32 * r as u32;
            for x in 0..w {
                tmp[y * w + x] = (acc / (2 * r as u32 + 1)) as u8;
                let add = row[(x + r + 1).min(w - 1)] as u32;
                let sub = row[x.saturating_sub(r)] as u32;
                acc = acc + add - sub;
            }
        }
        // vertical
        for x in 0..w {
            let mut acc: u32 = 0;
            for y in 0..=r.min(h - 1) {
                acc += tmp[y * w + x] as u32;
            }
            acc += tmp[x] as u32 * r as u32;
            for y in 0..h {
                data[y * w + x] = (acc / (2 * r as u32 + 1)) as u8;
                let add = tmp[(y + r + 1).min(h - 1) * w + x] as u32;
                let sub = tmp[y.saturating_sub(r) * w + x] as u32;
                acc = acc + add - sub;
            }
        }
    }
}

/// Combine all masks of a layer into a single 8-bit coverage map (layer source px × scale).
/// Returns None when the layer has no active masks.
pub fn mask_coverage(ctx: &EvalCtx, layer: &Layer, w: u32, h: u32, s: f64) -> Option<Vec<u8>> {
    let masks: Vec<&Mask> = layer.masks.iter().filter(|m| m.enabled && m.mode != MaskMode::None).collect();
    if masks.is_empty() {
        return None;
    }
    let (wu, hu) = (w as usize, h as usize);
    let mut acc: Vec<u8> = vec![0; wu * hu];
    for (i, m) in masks.iter().enumerate() {
        let t = ctx.time - layer.start;
        let path = m.path.at(t);
        let feather = ctx.prop(layer, &m.feather, &format!("{}.feather", m.id)).max(0.0) * s;
        let exp = ctx.prop(layer, &m.expansion, &format!("{}.exp", m.id)) * s;
        let op = (ctx.prop(layer, &m.opacity, &format!("{}.op", m.id)) / 100.0).clamp(0.0, 1.0);
        let mut pm = sk::Pixmap::new(w.max(1), h.max(1))?;
        if let Some(p) = bez_to_skia(&path, s) {
            let mut paint = sk::Paint { anti_alias: true, ..Default::default() };
            paint.set_color(sk::Color::WHITE);
            pm.fill_path(&p, &paint, sk::FillRule::Winding, sk::Transform::identity(), None);
            if exp.abs() > 0.01 {
                let stroke = sk::Stroke { width: (exp.abs() * 2.0) as f32, line_join: sk::LineJoin::Round, ..Default::default() };
                if exp < 0.0 {
                    paint.blend_mode = sk::BlendMode::Clear;
                }
                pm.stroke_path(&p, &paint, &stroke, sk::Transform::identity(), None);
            }
        }
        let mut cov: Vec<u8> = pm.data().chunks_exact(4).map(|px| px[3]).collect();
        box_blur_alpha(&mut cov, wu, hu, (feather / 2.0).round() as usize);
        if m.inverted {
            cov.iter_mut().for_each(|c| *c = 255 - *c);
        }
        for (a, c) in acc.iter_mut().zip(cov.iter()) {
            let (x, y) = (*a as f64 / 255.0, *c as f64 / 255.0 * op);
            let r = if i == 0 && m.mode != MaskMode::Subtract {
                match m.mode {
                    MaskMode::Intersect => y,
                    _ => y,
                }
            } else {
                match m.mode {
                    MaskMode::Add => x + y - x * y,
                    MaskMode::Subtract => {
                        let base = if i == 0 { 1.0 } else { x };
                        base * (1.0 - y)
                    }
                    MaskMode::Intersect => x * y,
                    MaskMode::Difference => (x - y).abs(),
                    MaskMode::Lighten => x.max(y),
                    MaskMode::Darken => x.min(y),
                    MaskMode::None => x,
                }
            };
            *a = (r.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    Some(acc)
}

// ------------------------------------------------------------------ text

pub struct Fonts {
    pub system: cosmic_text::FontSystem,
    pub scale: swash::scale::ScaleContext,
}

pub fn fonts() -> &'static Mutex<Fonts> {
    static F: OnceLock<Mutex<Fonts>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Fonts { system: cosmic_text::FontSystem::new(), scale: swash::scale::ScaleContext::new() }))
}

/// Load additional font files (Font import).
pub fn load_font_file(path: &str) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    fonts().lock().system.db_mut().load_font_data(data);
    Ok(())
}

pub fn font_families() -> Vec<String> {
    let f = fonts().lock();
    let mut v: Vec<String> = f.system.db().faces().filter_map(|face| face.families.first().map(|(n, _)| n.clone())).collect();
    v.sort();
    v.dedup();
    v
}

struct Glyph {
    path: sk::Path,
    /// Pen position of the glyph origin (baseline-left), canvas px.
    x: f32,
    y: f32,
    advance: f32,
    char_index: usize,
    word_index: usize,
    line_index: usize,
}

fn outline_to_path(outline: &swash::scale::outline::Outline) -> Option<sk::Path> {
    use swash::zeno::{Command, PathData};
    let mut b = sk::PathBuilder::new();
    for cmd in outline.path().commands() {
        match cmd {
            Command::MoveTo(p) => b.move_to(p.x, -p.y),
            Command::LineTo(p) => b.line_to(p.x, -p.y),
            Command::QuadTo(c, p) => b.quad_to(c.x, -c.y, p.x, -p.y),
            Command::CurveTo(c1, c2, p) => b.cubic_to(c1.x, -c1.y, c2.x, -c2.y, p.x, -p.y),
            Command::Close => b.close(),
        }
    }
    b.finish()
}

fn coverage(index: usize, count: usize, start: f64, end: f64, offset: f64, smooth: f64) -> f64 {
    if count == 0 {
        return 0.0;
    }
    let (s, e) = ((start + offset) / 100.0, (end + offset) / 100.0);
    let (s, e) = (s.min(e), s.max(e));
    let (u0, u1) = (index as f64 / count as f64, (index + 1) as f64 / count as f64);
    let overlap = ((u1.min(e) - u0.max(s)) / (u1 - u0)).clamp(0.0, 1.0);
    if smooth <= 0.0 {
        return overlap;
    }
    let k = smooth / 100.0;
    let x = overlap;
    let sm = x * x * (3.0 - 2.0 * x);
    x + (sm - x) * k
}

/// Glyph-level layout + rendering for text layers with animators, gradients, background
/// boxes and text-on-path. Canvas size = comp size × scale.
pub fn text_layer(ctx: &EvalCtx, layer: &Layer, tp: &TextProps, w: u32, h: u32, s: f64) -> Option<sk::Pixmap> {
    let text = ctx.plain(layer, &tp.text);
    let size = (ctx.prop(layer, &tp.font_size, "font.size") * s).max(1.0) as f32;
    let line_h = (ctx.prop(layer, &tp.line_height, "font.lh") as f32).max(0.1) * size;
    let tracking_base = (ctx.prop(layer, &tp.tracking, "font.track") * s) as f32 / 1000.0 * size;
    let mut pm = sk::Pixmap::new(w.max(1), h.max(1))?;
    if text.trim().is_empty() {
        return Some(pm);
    }
    let mut guard = fonts().lock();
    let Fonts { system, scale } = &mut *guard;
    let metrics = cosmic_text::Metrics::new(size, line_h);
    let mut buffer = cosmic_text::Buffer::new(system, metrics);
    let wrap = (tp.box_width > 0.0).then(|| (tp.box_width * s) as f32);
    buffer.set_size(system, wrap, None);
    let mut attrs = cosmic_text::Attrs::new().family(cosmic_text::Family::Name(&tp.font_family)).weight(cosmic_text::Weight(tp.font_weight));
    if tp.italic {
        attrs = attrs.style(cosmic_text::Style::Italic);
    }
    buffer.set_text(system, &text, &attrs, cosmic_text::Shaping::Advanced);
    buffer.shape_until_scroll(system, false);

    // Collect glyph outlines with logical indices.
    let word_starts: Vec<usize> = {
        let mut v = vec![];
        let mut prev_ws = true;
        for (i, ch) in text.char_indices() {
            if !ch.is_whitespace() && prev_ws {
                v.push(i);
            }
            prev_ws = ch.is_whitespace();
        }
        v
    };
    let mut glyphs: Vec<Glyph> = vec![];
    let mut line_widths = vec![];
    let mut line_tops = vec![];
    for (li, run) in buffer.layout_runs().enumerate() {
        line_widths.push(run.line_w);
        line_tops.push(run.line_y);
        let mut extra = 0.0f32;
        for g in run.glyphs.iter() {
            let Some(font) = system.get_font(g.font_id) else { continue };
            let mut scaler = scale.builder(font.as_swash()).size(g.font_size).hint(false).build();
            let ci = text[..g.start.min(text.len())].chars().count();
            let wi = word_starts.iter().rposition(|ws| *ws <= g.start).unwrap_or(0);
            if let Some(outline) = scaler.scale_outline(g.glyph_id) {
                if let Some(path) = outline_to_path(&outline) {
                    glyphs.push(Glyph { path, x: g.x + g.x_offset + extra, y: run.line_y + g.y_offset, advance: g.w, char_index: ci, word_index: wi, line_index: li });
                }
            }
            extra += tracking_base;
        }
    }
    drop(guard);
    if glyphs.is_empty() {
        return Some(pm);
    }
    let block_w = line_widths.iter().cloned().fold(0.0f32, f32::max) + tracking_base * 4.0;
    let block_h = line_tops.len() as f32 * line_h;
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let left = match tp.align {
        Align::Left => cx,
        Align::Center => cx - block_w / 2.0,
        Align::Right => cx - block_w,
    };
    let top = match tp.valign {
        VAlign::Top => cy,
        VAlign::Middle => cy - block_h / 2.0 - line_h * 0.15,
        VAlign::Bottom => cy - block_h,
    };
    let line_shift = |li: usize| -> f32 {
        let lw = line_widths.get(li).copied().unwrap_or(0.0);
        match tp.align {
            Align::Left => 0.0,
            Align::Center => (block_w - lw) / 2.0,
            Align::Right => block_w - lw,
        }
    };

    // Background box.
    if let Some(bg) = &tp.background {
        let c = ctx.prop(layer, &bg.color, "text.bg");
        let pad = (bg.padding * s) as f32;
        if let Some(rect) = sk::Rect::from_xywh(left - pad, top - pad + line_h * 0.15, block_w + pad * 2.0, block_h + pad * 2.0) {
            let r = (bg.radius * s) as f32;
            let path = if r > 0.0 {
                let bp = veyra_core::factory::rect_path(0.0, 0.0, 1.0, 1.0);
                let _ = bp;
                rounded_rect(rect, r)
            } else {
                Some(sk::PathBuilder::from_rect(rect))
            };
            if let Some(p) = path {
                let mut paint = sk::Paint { anti_alias: true, ..Default::default() };
                paint.set_color(color(c, 1.0));
                pm.fill_path(&p, &paint, sk::FillRule::Winding, sk::Transform::identity(), None);
            }
        }
    }

    let fill = ctx.prop(layer, &tp.fill, "text.fill");
    let stroke_c = ctx.prop(layer, &tp.stroke, "text.stroke");
    let stroke_w = (ctx.prop(layer, &tp.stroke_width, "text.sw") * s) as f32;
    let counts = (
        glyphs.iter().map(|g| g.char_index).max().unwrap_or(0) + 1,
        glyphs.iter().map(|g| g.word_index).max().unwrap_or(0) + 1,
        line_tops.len().max(1),
    );
    // Text on path: precompute a flattened polyline of the path (canvas px).
    let path_pts: Option<Vec<(f32, f32)>> = tp.on_path.as_ref().and_then(|bp| {
        let p = bez_to_skia(bp, s)?;
        let mut pts = vec![];
        for seg in p.segments() {
            match seg {
                sk::PathSegment::MoveTo(q) | sk::PathSegment::LineTo(q) => pts.push((q.x, q.y)),
                sk::PathSegment::CubicTo(c1, c2, q) => {
                    let p0 = *pts.last().unwrap_or(&(q.x, q.y));
                    for i in 1..=24 {
                        let t = i as f32 / 24.0;
                        let mt = 1.0 - t;
                        pts.push((
                            mt * mt * mt * p0.0 + 3.0 * mt * mt * t * c1.x + 3.0 * mt * t * t * c2.x + t * t * t * q.x,
                            mt * mt * mt * p0.1 + 3.0 * mt * mt * t * c1.y + 3.0 * mt * t * t * c2.y + t * t * t * q.y,
                        ));
                    }
                }
                sk::PathSegment::QuadTo(_, q) => pts.push((q.x, q.y)),
                sk::PathSegment::Close => {}
            }
        }
        (pts.len() >= 2).then_some(pts)
    });
    let mut tracking_acc = vec![0.0f32; counts.2];
    for g in &glyphs {
        let mut opacity = 1.0f64;
        let mut offset = [0.0f64, 0.0];
        let mut sc = 1.0f64;
        let mut rot = 0.0f64;
        let mut gfill = fill;
        for a in &tp.animators {
            let (idx, n) = match a.unit {
                TextUnit::Characters => (g.char_index, counts.0),
                TextUnit::Words => (g.word_index, counts.1),
                TextUnit::Lines => (g.line_index, counts.2),
            };
            let cov = coverage(
                idx,
                n,
                ctx.prop(layer, &a.start, &format!("{}.s", a.id)),
                ctx.prop(layer, &a.end, &format!("{}.e", a.id)),
                ctx.prop(layer, &a.offset, &format!("{}.o", a.id)),
                a.smoothness,
            );
            if cov <= 0.0 {
                continue;
            }
            let ao = ctx.prop(layer, &a.opacity, &format!("{}.op", a.id)) / 100.0;
            opacity *= 1.0 + (ao - 1.0) * cov;
            let p = ctx.prop(layer, &a.position, &format!("{}.pos", a.id));
            offset[0] += p[0] * cov * s;
            offset[1] += p[1] * cov * s;
            sc *= 1.0 + (ctx.prop(layer, &a.scale, &format!("{}.sc", a.id)) / 100.0 - 1.0) * cov;
            rot += ctx.prop(layer, &a.rotation, &format!("{}.rot", a.id)) * cov;
            tracking_acc[g.line_index] += (ctx.prop(layer, &a.tracking, &format!("{}.tr", a.id)) * s) as f32 * cov as f32 / counts.0.max(1) as f32;
            if let Some(fc) = &a.fill {
                let c = ctx.prop(layer, fc, &format!("{}.fill", a.id));
                gfill = Lerp::lerp(&gfill, &c, cov);
            }
        }
        if opacity <= 0.001 {
            continue;
        }
        let gx = left + line_shift(g.line_index) + g.x + tracking_acc[g.line_index];
        let gy = top + g.y;
        let gc = g.advance / 2.0;
        let xf = if let Some(pts) = &path_pts {
            // Place the glyph centre at arc length gx - left along the path.
            let target = gx - left + gc;
            let (mut acc, mut placed) = (0.0f32, None);
            for wpair in pts.windows(2) {
                let (a, b) = (wpair[0], wpair[1]);
                let seg = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
                if acc + seg >= target && seg > 0.0 {
                    let t = (target - acc) / seg;
                    placed = Some(((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t), (b.1 - a.1).atan2(b.0 - a.0)));
                    break;
                }
                acc += seg;
            }
            let Some(((px, py), ang)) = placed else { continue };
            sk::Transform::from_translate(px, py).pre_rotate(ang.to_degrees() + rot as f32).pre_translate(offset[0] as f32, offset[1] as f32).pre_scale(sc as f32, sc as f32).pre_translate(-gc, 0.0)
        } else {
            sk::Transform::from_translate(gx + gc + offset[0] as f32, gy + offset[1] as f32 - size * 0.35)
                .pre_rotate(rot as f32)
                .pre_scale(sc as f32, sc as f32)
                .pre_translate(-gc, size * 0.35)
        };
        let origin = (left, top);
        let paint = paint_for(gfill, tp.gradient.as_ref(), opacity, s, origin);
        if stroke_w > 0.0 {
            let mut sp = sk::Paint { anti_alias: true, ..Default::default() };
            sp.set_color(color(stroke_c, opacity));
            let st = sk::Stroke { width: stroke_w * 2.0, line_join: sk::LineJoin::Round, ..Default::default() };
            pm.stroke_path(&g.path, &sp, &st, xf, None);
        }
        pm.fill_path(&g.path, &paint, sk::FillRule::Winding, xf, None);
    }
    Some(pm)
}

/// Text layout as filled paths (canvas px), used to build extruded 3D text.
pub fn text_paths(ctx: &EvalCtx, layer: &Layer, tp: &TextProps, w: u32, h: u32) -> Vec<sk::Path> {
    // Reuse the renderer at scale 1 by capturing glyph paths without animators.
    let text = ctx.plain(layer, &tp.text);
    let size = ctx.prop(layer, &tp.font_size, "font.size").max(1.0) as f32;
    let mut guard = fonts().lock();
    let Fonts { system, scale } = &mut *guard;
    let mut buffer = cosmic_text::Buffer::new(system, cosmic_text::Metrics::new(size, size * 1.2));
    buffer.set_size(system, (tp.box_width > 0.0).then_some(tp.box_width as f32), None);
    let attrs = cosmic_text::Attrs::new().family(cosmic_text::Family::Name(&tp.font_family)).weight(cosmic_text::Weight(tp.font_weight));
    buffer.set_text(system, &text, &attrs, cosmic_text::Shaping::Advanced);
    buffer.shape_until_scroll(system, false);
    let mut out = vec![];
    let runs: Vec<_> = buffer.layout_runs().map(|r| (r.line_y, r.line_w, r.glyphs.to_vec())).collect();
    let block_w = runs.iter().map(|r| r.1).fold(0.0f32, f32::max);
    let block_h = runs.len() as f32 * size * 1.2;
    for (ly, lw, gl) in runs {
        let shift = match tp.align {
            Align::Left => 0.0,
            Align::Center => (block_w - lw) / 2.0,
            Align::Right => block_w - lw,
        };
        for g in gl {
            let Some(font) = system.get_font(g.font_id) else { continue };
            let mut scaler = scale.builder(font.as_swash()).size(g.font_size).build();
            if let Some(p) = scaler.scale_outline(g.glyph_id).and_then(|o| outline_to_path(&o)) {
                let tx = w as f32 / 2.0 - block_w / 2.0 + shift + g.x;
                let ty = h as f32 / 2.0 - block_h / 2.0 + ly;
                if let Some(p) = p.transform(sk::Transform::from_translate(tx, ty)) {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn rounded_rect(r: sk::Rect, rad: f32) -> Option<sk::Path> {
    let rad = rad.min(r.width() / 2.0).min(r.height() / 2.0);
    let k = rad * 0.5523;
    let (l, t, rr, b) = (r.left(), r.top(), r.right(), r.bottom());
    let mut p = sk::PathBuilder::new();
    p.move_to(l + rad, t);
    p.line_to(rr - rad, t);
    p.cubic_to(rr - rad + k, t, rr, t + rad - k, rr, t + rad);
    p.line_to(rr, b - rad);
    p.cubic_to(rr, b - rad + k, rr - rad + k, b, rr - rad, b);
    p.line_to(l + rad, b);
    p.cubic_to(l + rad - k, b, l, b - rad + k, l, b - rad);
    p.line_to(l, t + rad);
    p.cubic_to(l, t + rad - k, l + rad - k, t, l + rad, t);
    p.close();
    p.finish()
}

// ------------------------------------------------------------------ particles

fn rnd(seed: u32, i: u64, k: u64) -> f64 {
    let mut x = (seed as u64) ^ i.wrapping_mul(0x9E3779B97F4A7C15) ^ k.wrapping_mul(0xC2B2AE3D27D4EB4F);
    x ^= x >> 31;
    x = x.wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 29;
    (x & 0xFFFFFF) as f64 / 0xFFFFFF as f64
}

/// Deterministic, random-access particle simulation: each particle's state is a closed-form
/// function of its birth time, so any frame can be rendered without simulating from zero.
pub fn particles(ctx: &EvalCtx, layer: &Layer, p: &ParticleProps, w: u32, h: u32, s: f64) -> Option<sk::Pixmap> {
    let mut pm = sk::Pixmap::new(w.max(1), h.max(1))?;
    let t = ctx.time - layer.start;
    if t < 0.0 {
        return Some(pm);
    }
    // Integrate the (possibly animated) emission rate to get birth times.
    let step = 1.0 / 60.0;
    let mut births: Vec<f64> = Vec::new();
    let (mut acc, mut tt) = (0.0f64, 0.0f64);
    let max_life = p.lifetime.at(t) * (1.0 + p.lifetime_random) + 0.1;
    while tt <= t && births.len() < 200_000 {
        let rate = ctx.prop_at(layer, &p.rate, "p.rate", tt + layer.start).max(0.0);
        acc += rate * step;
        while acc >= 1.0 {
            births.push(tt);
            acc -= 1.0;
        }
        tt += step;
    }
    let first = births.partition_point(|b| *b < t - max_life);
    let alive = &births[first..];
    let start = alive.len().saturating_sub(p.max_particles as usize);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let gravity = ctx.prop(layer, &p.gravity, "p.grav");
    let turb = ctx.prop(layer, &p.turbulence, "p.turb");
    let esize = ctx.prop(layer, &p.emitter_size, "p.esize");
    let base_color = ctx.prop(layer, &p.color, "p.color");
    let opacity = ctx.prop(layer, &p.opacity, "p.op") / 100.0;
    for (k, &b) in alive[start..].iter().enumerate() {
        let i = (first + start + k) as u64;
        let age = t - b;
        let life = ctx.prop_at(layer, &p.lifetime, "p.life", b + layer.start) * (1.0 + (rnd(p.seed, i, 1) * 2.0 - 1.0) * p.lifetime_random);
        if age > life || life <= 0.0 {
            continue;
        }
        let f = age / life;
        let speed = ctx.prop_at(layer, &p.speed, "p.speed", b + layer.start) * (1.0 + (rnd(p.seed, i, 2) * 2.0 - 1.0) * p.speed_random);
        let dir = ctx.prop_at(layer, &p.direction, "p.dir", b + layer.start) + (rnd(p.seed, i, 3) * 2.0 - 1.0) * ctx.prop_at(layer, &p.spread, "p.spread", b + layer.start) / 2.0;
        let a = (dir - 90.0).to_radians();
        let (vx, vy) = (a.cos() * speed, a.sin() * speed);
        let (ox, oy) = match p.emitter {
            EmitterShape::Point => (0.0, 0.0),
            EmitterShape::Line => ((rnd(p.seed, i, 4) - 0.5) * esize[0], 0.0),
            EmitterShape::Box => ((rnd(p.seed, i, 4) - 0.5) * esize[0], (rnd(p.seed, i, 5) - 0.5) * esize[1]),
            EmitterShape::Circle => {
                let (r, th) = (rnd(p.seed, i, 4).sqrt() * esize[0] / 2.0, rnd(p.seed, i, 5) * std::f64::consts::TAU);
                (r * th.cos(), r * th.sin())
            }
        };
        let pos = |age: f64| -> (f64, f64) {
            let dk = if p.drag > 0.0 { (1.0 - (-p.drag * age).exp()) / p.drag } else { age };
            let mut x = ox + vx * dk + 0.5 * gravity[0] * age * age;
            let mut y = oy + vy * dk + 0.5 * gravity[1] * age * age;
            if turb > 0.0 {
                let sc = p.turbulence_scale.max(1.0);
                x += noise1(age * 2.0 + y / sc, i * 2 + p.seed as u64) * turb;
                y += noise1(age * 2.0 + x / sc, i * 2 + 1 + p.seed as u64) * turb;
            }
            if let Some(floor) = p.floor {
                if y > floor {
                    y = floor - (y - floor) * p.bounce;
                }
            }
            (x, y)
        };
        let size = ctx.prop_at(layer, &p.size, "p.size", b + layer.start) * (1.0 + (rnd(p.seed, i, 6) * 2.0 - 1.0) * p.size_random) * (1.0 + (p.size_end - 1.0) * f);
        let col = Lerp::lerp(&base_color, &p.color_end, f);
        let alpha = opacity * if p.fade_out { 1.0 - f } else { 1.0 };
        let trail = p.trail.min(16);
        for tr in (0..=trail).rev() {
            let ta = (age - tr as f64 * 0.02).max(0.0);
            let (x, y) = pos(ta);
            let ta_alpha = alpha * (1.0 - tr as f64 / (trail as f64 + 1.0));
            let mut paint = sk::Paint { anti_alias: true, ..Default::default() };
            paint.set_color(color(col, ta_alpha));
            let (px, py, r) = ((cx + x * s) as f32, (cy + y * s) as f32, (size * s / 2.0).max(0.3) as f32);
            let rotation = (p.rotation_speed * age + rnd(p.seed, i, 7) * 360.0) as f32;
            let path = match p.shape {
                ParticleShape::Circle => sk::PathBuilder::from_circle(px, py, r),
                ParticleShape::Square => sk::Rect::from_xywh(-r, -r, r * 2.0, r * 2.0).map(sk::PathBuilder::from_rect).and_then(|p| p.transform(sk::Transform::from_translate(px, py).pre_rotate(rotation))),
                ParticleShape::Star => bez_to_skia(&polygon_path(5.0, r as f64, r as f64 * 0.45, true, 0.0), 1.0).and_then(|p| p.transform(sk::Transform::from_translate(px, py).pre_rotate(rotation))),
                ParticleShape::Spark => {
                    let (x2, y2) = pos((ta - 0.04).max(0.0));
                    let mut b = sk::PathBuilder::new();
                    b.move_to(px, py);
                    b.line_to((cx + x2 * s) as f32, (cy + y2 * s) as f32);
                    let st = sk::Stroke { width: r, line_cap: sk::LineCap::Round, ..Default::default() };
                    if let Some(path) = b.finish() {
                        pm.stroke_path(&path, &paint, &st, sk::Transform::identity(), None);
                    }
                    None
                }
            };
            if let Some(path) = path {
                pm.fill_path(&path, &paint, sk::FillRule::Winding, sk::Transform::identity(), None);
            }
        }
    }
    Some(pm)
}

// ------------------------------------------------------------------ SVG

pub fn svg(path: &str, w: u32, h: u32) -> Option<sk::Pixmap> {
    let data = std::fs::read(path).ok()?;
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_data(&data, &opt).ok()?;
    let sz = tree.size();
    let mut pm = sk::Pixmap::new(w.max(1), h.max(1))?;
    let xf = sk::Transform::from_scale(w as f32 / sz.width(), h as f32 / sz.height());
    resvg::render(&tree, xf, &mut pm.as_mut());
    Some(pm)
}

pub fn svg_size(path: &str) -> Option<(u32, u32)> {
    let data = std::fs::read(path).ok()?;
    let tree = resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).ok()?;
    Some((tree.size().width().ceil() as u32, tree.size().height().ceil() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_animator_coverage() {
        // range 0..50% over 4 units: first two fully covered, rest not.
        assert_eq!(coverage(0, 4, 0.0, 50.0, 0.0, 0.0), 1.0);
        assert_eq!(coverage(1, 4, 0.0, 50.0, 0.0, 0.0), 1.0);
        assert_eq!(coverage(2, 4, 0.0, 50.0, 0.0, 0.0), 0.0);
        assert_eq!(coverage(1, 4, 0.0, 37.5, 0.0, 0.0), 0.5);
    }

    #[test]
    fn mask_feather_and_modes() {
        let p = Project::new("m");
        let comp = &p.compositions[0];
        let mut l = veyra_core::factory::solid_layer(comp, [1.0; 4], 0.0);
        l.masks.push(veyra_core::factory::mask("rect", 100.0, 100.0));
        let ctx = EvalCtx::new(&p, comp, 0.0);
        let cov = mask_coverage(&ctx, &l, 100, 100, 1.0).unwrap();
        assert_eq!(cov[50 * 100 + 50], 255);
        assert_eq!(cov[5 * 100 + 5], 0);
        l.masks[0].inverted = true;
        let inv = mask_coverage(&ctx, &l, 100, 100, 1.0).unwrap();
        assert_eq!(inv[50 * 100 + 50], 0);
        l.masks[0].inverted = false;
        l.masks[0].feather.value = 20.0;
        let fe = mask_coverage(&ctx, &l, 100, 100, 1.0).unwrap();
        let edge = fe[50 * 100 + 20];
        assert!(edge > 30 && edge < 230, "feathered edge should be partial, got {edge}");
    }

    #[test]
    fn particles_are_deterministic() {
        let p = Project::new("p");
        let comp = &p.compositions[0];
        let l = veyra_core::factory::particle_layer(comp, 0.0);
        let LayerKind::Particles(pp) = &l.kind else { panic!() };
        let ctx = EvalCtx::new(&p, comp, 1.5);
        let a = particles(&ctx, &l, pp, 320, 180, 1.0 / 6.0).unwrap();
        let b = particles(&ctx, &l, pp, 320, 180, 1.0 / 6.0).unwrap();
        assert_eq!(a.data(), b.data());
        assert!(a.data().chunks_exact(4).any(|px| px[3] > 0), "particles were drawn");
    }

    #[test]
    fn shapes_render() {
        let p = Project::new("s");
        let comp = &p.compositions[0];
        for kind in ["rect", "ellipse", "star", "polygon", "roundedRect", "arrow", "line"] {
            let l = veyra_core::factory::shape_layer(comp, kind, 0.0);
            let LayerKind::Shape(sp) = &l.kind else { panic!() };
            let ctx = EvalCtx::new(&p, comp, 0.0);
            let pm = shape_layer(&ctx, &l, sp, 480, 270, 0.25).unwrap();
            assert!(pm.data().chunks_exact(4).filter(|px| px[3] > 0).count() > 50, "{kind} drew nothing");
        }
    }
}
