//! The compositing engine: evaluates a composition at a time and renders it on the GPU.

use crate::gpu::*;
use crate::mesh;
use crate::raster;
use glam::{DMat4, DVec3, DVec4};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use veyra_core::anim::ParamValue;
use veyra_core::eval::{self, CameraEval, EvalCtx};
use veyra_core::model::*;
use veyra_core::registry::{self, sh};
use veyra_media::{DecoderPool, Source};

pub mod k {
    pub const IMPORT: u32 = 86;
    pub const SOLID: u32 = 87;
    pub const OUTPUT: u32 = 88;
    pub const OPACITY: u32 = 89;
    pub const INNER_COMBINE: u32 = 74;
    pub const GEN_BASE: u32 = 80;
}

#[derive(Clone, Copy, Debug)]
pub struct RenderOptions {
    /// Resolution scale (1 = full, 0.5 = half ...).
    pub scale: f64,
    pub use_proxies: bool,
    /// Draft mode skips motion blur and depth of field for responsiveness.
    pub draft: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self { scale: 1.0, use_proxies: false, draft: false }
    }
}

/// Straight-alpha RGBA8 image.
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub struct Renderer {
    pub gpu: Arc<Gpu>,
    pub decoders: Arc<DecoderPool>,
    meshes: Mutex<HashMap<u64, Arc<GpuMesh>>>,
    luts: Mutex<HashMap<String, Arc<Tex>>>,
    material_tex: Mutex<HashMap<(String, u32), Arc<Tex>>>,
    svgs: Mutex<HashMap<(String, u32, u32), Arc<Vec<u8>>>>,
    /// Human-readable problems from the last render (missing media, bad LUT ...).
    pub warnings: Mutex<Vec<String>>,
}

struct Frame<'a> {
    gpu: &'a Gpu,
    enc: wgpu::CommandEncoder,
    held: Vec<TexRef>,
    project: &'a Project,
    opts: RenderOptions,
}

impl<'a> Frame<'a> {
    fn tex(&mut self, w: u32, h: u32) -> TexRef {
        self.tex_fmt(w, h, WORK)
    }
    fn tex_fmt(&mut self, w: u32, h: u32, f: wgpu::TextureFormat) -> TexRef {
        let t = Arc::new(self.gpu.acquire(w, h, f));
        self.held.push(t.clone());
        t
    }
    fn upload(&mut self, w: u32, h: u32, data: &[u8], f: wgpu::TextureFormat) -> TexRef {
        let t = self.tex_fmt(w, h, f);
        self.gpu.write_rgba8(&t, data);
        t
    }
    /// Submit pending work and recycle textures no longer referenced outside the frame.
    fn flush(&mut self) {
        let enc = std::mem::replace(&mut self.enc, self.gpu.encoder());
        self.gpu.submit(enc);
        let mut keep = Vec::new();
        for t in self.held.drain(..) {
            match Arc::try_unwrap(t) {
                Ok(tex) => self.gpu.release(tex),
                Err(t) => keep.push(t),
            }
        }
        self.held = keep;
    }
}

/// Geometry of a processed layer texture (all values in unscaled layer pixels).
#[derive(Clone, Copy)]
struct Geom {
    w: f64,
    h: f64,
    pad: f64,
}

struct TransFx {
    opacity: f64,
    extra: DMat4,
    wipe_kind: u32,
    wipe: f32,
    blur: f64,
    dip: Option<([f64; 4], f64)>,
}

fn smooth(p: f64) -> f64 {
    p * p * (3.0 - 2.0 * p)
}

fn to_f32m(m: DMat4) -> [[f32; 4]; 4] {
    m.as_mat4().to_cols_array_2d()
}

fn hash_str(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn pv_to_slot(v: &ParamValue) -> [f32; 4] {
    match v {
        ParamValue::Num(n) => [*n as f32, 0.0, 0.0, 0.0],
        ParamValue::Bool(b) => [if *b { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0],
        ParamValue::Vec(v) => {
            let mut o = [0.0f32; 4];
            for (i, x) in v.iter().take(4).enumerate() {
                o[i] = *x as f32;
            }
            o
        }
        ParamValue::Str(_) => [0.0; 4],
    }
}

impl Renderer {
    pub fn new(gpu: Arc<Gpu>, decoders: Arc<DecoderPool>) -> Self {
        Self {
            gpu,
            decoders,
            meshes: Mutex::new(HashMap::new()),
            luts: Mutex::new(HashMap::new()),
            material_tex: Mutex::new(HashMap::new()),
            svgs: Mutex::new(HashMap::new()),
            warnings: Mutex::new(Vec::new()),
        }
    }

    fn warn(&self, msg: String) {
        let mut w = self.warnings.lock();
        if !w.contains(&msg) && w.len() < 32 {
            log::warn!("{msg}");
            w.push(msg);
        }
    }

    pub fn clear_caches(&self) {
        self.meshes.lock().clear();
        self.luts.lock().clear();
        self.material_tex.lock().clear();
        self.svgs.lock().clear();
        self.gpu.trim_pool();
    }

    /// Render a composition frame to straight-alpha RGBA8.
    pub fn render(&self, project: &Project, comp_id: &str, t: f64, opts: RenderOptions) -> Result<Image, String> {
        let comp = project.comp(comp_id).ok_or("composition not found")?;
        let mut fr = Frame { gpu: &self.gpu, enc: self.gpu.encoder(), held: Vec::new(), project, opts };
        let acc = self.render_comp(&mut fr, comp, t, 0);
        let out = fr.tex_fmt(acc.w, acc.h, OUT);
        let u = EffU { kind: k::OUTPUT, size: [acc.w as f32, acc.h as f32], content: [acc.w as f32, acc.h as f32], ..Default::default() };
        self.gpu.effect(&mut fr.enc, &out, &acc, None, &u, None, None);
        drop(acc);
        fr.flush();
        let data = self.gpu.readback(&out);
        let (w, h) = (out.w, out.h);
        drop(out);
        fr.flush();
        Ok(Image { width: w, height: h, data })
    }

    fn comp_px(&self, comp: &Composition, s: f64) -> (u32, u32) {
        (((comp.width as f64 * s).round() as u32).max(1), ((comp.height as f64 * s).round() as u32).max(1))
    }

    fn render_comp(&self, fr: &mut Frame, comp: &Composition, t: f64, depth: u32) -> TexRef {
        let s = fr.opts.scale;
        let (cw, ch) = self.comp_px(comp, s);
        let acc0 = fr.tex(cw, ch);
        let bg = if comp.transparent || depth > 0 { [0.0; 4] } else { comp.background };
        self.gpu.clear(&mut fr.enc, &acc0, bg);
        let mut acc = acc0;
        if depth > 16 {
            return acc;
        }
        let project = fr.project;
        let ctx = EvalCtx::new(project, comp, t);
        let cam = eval::eval_camera(&ctx);
        let lights = self.eval_lights(&ctx);
        let solo = comp.layers.iter().any(|l| l.solo && l.visible);
        let mattes: HashSet<&str> = comp.layers.iter().filter_map(|l| l.track_matte.as_ref().map(|m| m.layer.as_str())).collect();

        let mut order: Vec<&Layer> = comp
            .layers
            .iter()
            .rev()
            .filter(|l| l.visible && l.is_active_at(t) && l.is_renderable() && (!solo || l.solo) && !mattes.contains(l.id.as_str()))
            .collect();
        // Depth-sort runs of consecutive 3D layers (painter's algorithm, far first).
        let depth_of = |l: &Layer| -> f64 {
            let w = eval::world_matrix(&ctx, l, t);
            let a = DVec3::from_array(l.transform.anchor.at(t - l.start));
            let p = cam.view.transform_point3(w.transform_point3(a));
            p.z
        };
        let mut i = 0;
        while i < order.len() {
            if order[i].is_3d {
                let mut j = i;
                while j < order.len() && order[j].is_3d {
                    j += 1;
                }
                let mut run: Vec<(f64, &Layer)> = order[i..j].iter().map(|l| (depth_of(l), *l)).collect();
                run.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                for (k2, (_, l)) in run.into_iter().enumerate() {
                    order[i + k2] = l;
                }
                i = j;
            } else {
                i += 1;
            }
        }

        for layer in order {
            if let LayerKind::Adjustment = layer.kind {
                if let Some(out) = self.adjustment(fr, &ctx, layer, &acc, cw, ch) {
                    acc = out;
                }
                fr.flush();
                continue;
            }
            let Some(placed) = self.place(fr, &ctx, layer, &cam, &lights, depth) else { continue };
            let (matte, mode) = match layer.track_matte.as_ref().and_then(|m| comp.layer(&m.layer).map(|ml| (ml, m.mode))) {
                Some((ml, mode)) => (self.place(fr, &ctx, ml, &cam, &lights, depth), mode),
                None => (None, MatteMode::Alpha),
            };
            let matte_code = match (&matte, mode) {
                (None, _) => {
                    if layer.track_matte.is_some() {
                        // Matte layer exists but is inactive at this time -> nothing shows.
                        continue;
                    }
                    0
                }
                (Some(_), MatteMode::Alpha) => 1,
                (Some(_), MatteMode::AlphaInverted) => 2,
                (Some(_), MatteMode::Luma) => 3,
                (Some(_), MatteMode::LumaInverted) => 4,
            };
            let out = fr.tex(cw, ch);
            self.gpu.blend(&mut fr.enc, &out, &acc, &placed, matte.as_deref(), &BlendU { mode: layer.blend.index(), matte: matte_code, adjust: 0, opacity: 1.0 });
            acc = out;
            drop(placed);
            drop(matte);
            fr.flush();
        }
        acc
    }

    fn adjustment(&self, fr: &mut Frame, ctx: &EvalCtx, layer: &Layer, acc: &TexRef, cw: u32, ch: u32) -> Option<TexRef> {
        let s = fr.opts.scale;
        let geom = Geom { w: ctx.comp.width as f64, h: ctx.comp.height as f64, pad: 0.0 };
        let mut cur = acc.clone();
        for e in layer.effects.iter().filter(|e| e.enabled) {
            cur = self.apply_effect(fr, ctx, layer, e, cur, geom);
        }
        let cov = match raster::mask_coverage(ctx, layer, cw, ch, s) {
            Some(c) => fr.upload(cw, ch, &c, wgpu::TextureFormat::R8Unorm),
            None => self.gpu.white.clone(),
        };
        let opacity = eval::eval_transform(ctx, layer, ctx.time).opacity * self.transitions(ctx, layer).opacity;
        let out = fr.tex(cw, ch);
        self.gpu.blend(&mut fr.enc, &out, acc, &cur, Some(&cov), &BlendU { mode: 0, matte: 0, adjust: 1, opacity: opacity as f32 });
        Some(out)
    }

    // ------------------------------------------------------------ placement

    fn place(&self, fr: &mut Frame, ctx: &EvalCtx, layer: &Layer, cam: &CameraEval, lights: &[LightU], depth: u32) -> Option<TexRef> {
        if !layer.is_active_at(ctx.time) {
            return None;
        }
        let extruded = layer.is_3d
            && match &layer.kind {
                LayerKind::Text(tp) => tp.extrude > 0.0,
                LayerKind::Shape(sp) => sp.extrude > 0.0,
                _ => false,
            };
        if matches!(layer.kind, LayerKind::Mesh(_)) || extruded {
            return self.place_mesh(fr, ctx, layer, cam, lights);
        }
        let s = fr.opts.scale;
        let comp = ctx.comp;
        let (cw, ch) = self.comp_px(comp, s);
        let (mut tex, geom) = self.process(fr, ctx, layer, depth)?;
        let tr = self.transitions(ctx, layer);
        if tr.blur > 0.5 {
            tex = self.blur(fr, tex, geom, tr.blur, 0, false, false);
        }
        if let Some((col, amt)) = tr.dip {
            let mut u = self.base_u(ctx, layer, &tex, geom, sh::FILL);
            u.p[0] = [col[0] as f32, col[1] as f32, col[2] as f32, 1.0];
            u.p[1] = [amt as f32, 0.0, 0.0, 0.0];
            tex = self.pass(fr, &tex, None, &u);
        }
        // Depth of field for 3D layers: blur by distance from the focal plane.
        if layer.is_3d && !fr.opts.draft {
            if let Some((focus, aperture)) = cam.dof {
                let w = eval::world_matrix(ctx, layer, ctx.time);
                let a = DVec3::from_array(layer.transform.anchor.at(ctx.time - layer.start));
                let z = cam.view.transform_point3(w.transform_point3(a)).z.max(1.0);
                let blur = aperture * (z - focus).abs() / z;
                if blur > 0.5 {
                    tex = self.blur(fr, tex, geom, blur.min(200.0), 0, false, false);
                }
            }
        }
        let base_opacity = eval::eval_transform(ctx, layer, ctx.time).opacity * tr.opacity;
        if base_opacity <= 0.0005 {
            return None;
        }
        let samples = if layer.motion_blur && !fr.opts.draft { comp.motion_blur.samples.clamp(2, 64) } else { 1 };
        let out = fr.tex(cw, ch);
        let ortho = eval::ortho_2d(comp.width as f64, comp.height as f64);
        for i in 0..samples {
            let ts = if samples == 1 {
                ctx.time
            } else {
                let mb = comp.motion_blur;
                ctx.time + (mb.shutter_phase + mb.shutter_angle * i as f64 / (samples - 1) as f64) / 360.0 / comp.fps
            };
            let world = tr.extra * eval::world_matrix(ctx, layer, ts);
            let mvp = if layer.is_3d { cam.proj * cam.view * world } else { ortho * world };
            let u = LayerU {
                mvp: to_f32m(mvp),
                size: [(geom.w + geom.pad * 2.0) as f32, (geom.h + geom.pad * 2.0) as f32],
                origin: [-geom.pad as f32, -geom.pad as f32],
                opacity: (base_opacity / samples as f64) as f32,
                wipe_kind: tr.wipe_kind,
                wipe: tr.wipe,
                feather: 0.04,
            };
            self.gpu.draw_layer(&mut fr.enc, &out, &tex, &u, i == 0, samples > 1);
        }
        Some(out)
    }

    fn transitions(&self, ctx: &EvalCtx, layer: &Layer) -> TransFx {
        let mut fx = TransFx { opacity: 1.0, extra: DMat4::IDENTITY, wipe_kind: 0, wipe: 1.0, blur: 0.0, dip: None };
        let (w, h) = (ctx.comp.width as f64, ctx.comp.height as f64);
        let c = DVec3::new(w / 2.0, h / 2.0, 0.0);
        let lt = ctx.time - layer.start;
        let rem = layer.end() - ctx.time;
        for (tr, raw, is_in) in [(layer.transition_in.as_ref(), lt, true), (layer.transition_out.as_ref(), rem, false)] {
            let Some(tr) = tr else { continue };
            if tr.duration <= 0.0 || raw >= tr.duration {
                continue;
            }
            let mut p = (raw / tr.duration).clamp(0.0, 1.0);
            if tr.ease {
                p = smooth(p);
            }
            let q = 1.0 - p;
            let dir = if is_in { 1.0 } else { -1.0 };
            match tr.kind {
                TransitionKind::CrossDissolve => fx.opacity *= p,
                TransitionKind::DipToBlack => fx.dip = Some(([0.0, 0.0, 0.0, 1.0], q)),
                TransitionKind::DipToWhite => fx.dip = Some(([1.0, 1.0, 1.0, 1.0], q)),
                TransitionKind::WipeLeft | TransitionKind::WipeRight | TransitionKind::WipeUp | TransitionKind::WipeDown => {
                    fx.wipe_kind = match tr.kind {
                        TransitionKind::WipeLeft => 1,
                        TransitionKind::WipeRight => 2,
                        TransitionKind::WipeUp => 3,
                        _ => 4,
                    };
                    fx.wipe = (p * 1.04) as f32;
                }
                TransitionKind::SlideLeft => fx.extra = DMat4::from_translation(DVec3::new(q * w * dir, 0.0, 0.0)) * fx.extra,
                TransitionKind::SlideRight => fx.extra = DMat4::from_translation(DVec3::new(-q * w * dir, 0.0, 0.0)) * fx.extra,
                TransitionKind::ZoomIn | TransitionKind::ZoomOut => {
                    let grow = matches!(tr.kind, TransitionKind::ZoomIn) == is_in;
                    let sc = if grow { 0.6 + 0.4 * p } else { 1.0 + 0.5 * q };
                    fx.extra = DMat4::from_translation(c) * DMat4::from_scale(DVec3::new(sc, sc, 1.0)) * DMat4::from_translation(-c) * fx.extra;
                    fx.opacity *= p;
                }
                TransitionKind::Blur => {
                    fx.blur = fx.blur.max(q * 60.0);
                    fx.opacity *= p.sqrt();
                }
                TransitionKind::Spin => {
                    fx.extra = DMat4::from_translation(c) * DMat4::from_rotation_z((q * 90.0 * dir).to_radians()) * DMat4::from_translation(-c) * fx.extra;
                    fx.opacity *= p;
                }
            }
        }
        fx
    }

    // ------------------------------------------------------------ layer sources

    fn layer_size(&self, project: &Project, comp: &Composition, layer: &Layer) -> Option<(f64, f64)> {
        Some(match &layer.kind {
            LayerKind::Media { asset } => {
                let a = project.asset(asset)?;
                (a.info.width.max(1) as f64, a.info.height.max(1) as f64)
            }
            LayerKind::Solid { width, height, .. } => (*width as f64, *height as f64),
            LayerKind::Comp { comp: id, .. } => {
                let c = project.comp(id)?;
                (c.width as f64, c.height as f64)
            }
            _ => (comp.width as f64, comp.height as f64),
        })
    }

    fn effect_padding(&self, ctx: &EvalCtx, layer: &Layer) -> f64 {
        let mut pad: f64 = 0.0;
        for e in layer.effects.iter().filter(|e| e.enabled) {
            let n = |key: &str| ctx.param(layer, e, key).map(|v| v.num()).unwrap_or(0.0).abs();
            pad += match e.kind.as_str() {
                "gaussianBlur" | "boxBlur" => {
                    if ctx.param(layer, e, "repeatEdges").map(|v| v.boolean()).unwrap_or(false) { 0.0 } else { n("radius") * 1.2 }
                }
                "glow" | "bloom" | "lightWrap" => n("radius"),
                "dropShadow" => n("distance") + n("softness"),
                "directionalBlur" | "motionBlurFx" => n("length") / 2.0,
                "lensBlur" => n("radius"),
                "stroke" => n("width"),
                "turbulentDisplace" | "displacement" => n("amount"),
                "wave" | "ripple" => n("amplitude"),
                _ => 0.0,
            };
        }
        pad.min(1000.0).ceil()
    }

    /// Produce the layer's processed texture (source + masks + effects) in layer space.
    fn process(&self, fr: &mut Frame, ctx: &EvalCtx, layer: &Layer, depth: u32) -> Option<(TexRef, Geom)> {
        let s = fr.opts.scale;
        let project = fr.project;
        let (lw, lh) = self.layer_size(project, ctx.comp, layer)?;
        let pad = self.effect_padding(ctx, layer);
        let geom = Geom { w: lw, h: lh, pad };
        let (cwp, chp) = (((lw * s).round() as u32).max(1), ((lh * s).round() as u32).max(1));
        let (tw, th) = ((((lw + pad * 2.0) * s).round() as u32).max(1), (((lh + pad * 2.0) * s).round() as u32).max(1));
        let padded = fr.tex(tw, th);
        let mut u = EffU {
            kind: k::IMPORT,
            size: [tw as f32, th as f32],
            content: [cwp as f32, chp as f32],
            pad: [(pad * s) as f32, (pad * s) as f32],
            scale: s as f32,
            time: (ctx.time - layer.start) as f32,
            ..Default::default()
        };
        let lt = ctx.time;
        let src: Option<(TexRef, bool)> = match &layer.kind {
            LayerKind::Media { asset } => {
                let a = project.asset(asset)?;
                if a.missing {
                    self.warn(format!("Media offline: {}", a.name));
                    return None;
                }
                match a.kind {
                    AssetKind::Svg => {
                        let key = (a.path.clone(), cwp, chp);
                        let cached = self.svgs.lock().get(&key).cloned();
                        let data = match cached {
                            Some(d) => d,
                            None => {
                                let pm = raster::svg(&a.path, cwp, chp)?;
                                let d = Arc::new(pm.data().to_vec());
                                self.svgs.lock().insert(key, d.clone());
                                d
                            }
                        };
                        Some((fr.upload(cwp, chp, &data, wgpu::TextureFormat::Rgba8Unorm), true))
                    }
                    AssetKind::Video | AssetKind::Image | AssetKind::ImageSequence => {
                        let src = Source::from_asset(a, fr.opts.use_proxies);
                        match self.decoders.frame(&src, layer.source_time(lt), cwp, chp) {
                            Ok(Some(f)) => Some((fr.upload(f.width, f.height, &f.data, wgpu::TextureFormat::Rgba8Unorm), false)),
                            Ok(None) => None,
                            Err(e) => {
                                self.warn(format!("Could not decode {}: {e}", a.name));
                                None
                            }
                        }
                    }
                    _ => None,
                }
            }
            LayerKind::Solid { color, .. } => {
                let c = ctx.prop(layer, color, "solid.color");
                u.kind = k::SOLID;
                u.p[0] = [c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32];
                self.gpu.effect(&mut fr.enc, &padded, &self.gpu.white, None, &u, None, None);
                None
            }
            LayerKind::Text(tp) => {
                let pm = raster::text_layer(ctx, layer, tp, cwp, chp, s)?;
                Some((fr.upload(cwp, chp, pm.data(), wgpu::TextureFormat::Rgba8Unorm), true))
            }
            LayerKind::Shape(sp) => {
                let pm = raster::shape_layer(ctx, layer, sp, cwp, chp, s)?;
                Some((fr.upload(cwp, chp, pm.data(), wgpu::TextureFormat::Rgba8Unorm), true))
            }
            LayerKind::Particles(pp) => {
                let pm = raster::particles(ctx, layer, pp, cwp, chp, s)?;
                Some((fr.upload(cwp, chp, pm.data(), wgpu::TextureFormat::Rgba8Unorm), true))
            }
            LayerKind::Generator(g) => {
                let keys: &[&str] = match g.generator {
                    GeneratorKind::Grid => &["spacing", "width", "color"],
                    GeneratorKind::Noise => &["scale", "evolution", "octaves", "contrast"],
                    GeneratorKind::Wave => &["amplitude", "wavelength", "speed", "lines", "width", "color"],
                    GeneratorKind::Gradient => &["colorA", "colorB", "angle"],
                    GeneratorKind::Checkerboard => &["size", "colorA", "colorB"],
                    GeneratorKind::AnimatedBackground => &["colorA", "colorB", "speed", "scale"],
                };
                let gt = fr.tex(cwp, chp);
                let mut gu = EffU { kind: k::GEN_BASE + g.generator as u32, size: [cwp as f32, chp as f32], content: [cwp as f32, chp as f32], scale: s as f32, time: u.time, ..Default::default() };
                for (i, key) in keys.iter().enumerate() {
                    if let Some(p) = g.params.get(*key) {
                        gu.p[i] = pv_to_slot(&ctx.prop(layer, p, &format!("gen.{key}")));
                    }
                }
                self.gpu.effect(&mut fr.enc, &gt, &self.gpu.white, None, &gu, None, None);
                Some((gt, true))
            }
            LayerKind::Comp { comp: id, .. } => {
                let nested = project.comp(id)?;
                let nt = layer.source_time(lt);
                let tex = self.render_comp(fr, nested, nt, depth + 1);
                Some((tex, true))
            }
            _ => None,
        };
        if let Some((src, premult)) = src {
            u.flags = if premult { 2 } else { 0 };
            self.gpu.effect(&mut fr.enc, &padded, &src, None, &u, None, None);
        } else if !matches!(layer.kind, LayerKind::Solid { .. }) {
            return None;
        }
        let mut cur = padded;
        if let Some(cov) = raster::mask_coverage(ctx, layer, cwp, chp, s) {
            let mt = fr.upload(cwp, chp, &cov, wgpu::TextureFormat::R8Unorm);
            let mut mu = u;
            mu.kind = sh::OPACITY_MUL;
            cur = self.pass(fr, &cur, Some(&mt), &mu);
        }
        for e in layer.effects.iter().filter(|e| e.enabled) {
            cur = self.apply_effect(fr, ctx, layer, e, cur, geom);
        }
        Some((cur, geom))
    }

    // ------------------------------------------------------------ effects

    fn base_u(&self, ctx: &EvalCtx, layer: &Layer, tex: &Tex, geom: Geom, kind: u32) -> EffU {
        let s = (tex.w as f64 / (geom.w + geom.pad * 2.0)).max(1e-6);
        EffU {
            kind,
            size: [tex.w as f32, tex.h as f32],
            content: [(geom.w * s) as f32, (geom.h * s) as f32],
            pad: [(geom.pad * s) as f32, (geom.pad * s) as f32],
            scale: s as f32,
            time: (ctx.time - layer.start) as f32,
            seed: (hash_str(&layer.id) % 1000) as f32,
            intensity: 1.0,
            ..Default::default()
        }
    }

    fn pass(&self, fr: &mut Frame, a: &TexRef, b: Option<&TexRef>, u: &EffU) -> TexRef {
        let out = fr.tex(a.w, a.h);
        self.gpu.effect(&mut fr.enc, &out, a, b.map(|x| &**x), u, None, None);
        out
    }

    /// Separable gaussian/box blur. `dims`: 0 both, 1 horizontal, 2 vertical.
    #[allow(clippy::too_many_arguments)]
    fn blur(&self, fr: &mut Frame, src: TexRef, geom: Geom, radius: f64, dims: u32, box_: bool, repeat: bool) -> TexRef {
        let s = (src.w as f64 / (geom.w + geom.pad * 2.0)).max(1e-6);
        let mut u = EffU { size: [src.w as f32, src.h as f32], scale: s as f32, flags: repeat as u32, ..Default::default() };
        u.p[0] = [radius as f32, if box_ { 1.0 } else { 0.0 }, 0.0, 0.0];
        let mut cur = src;
        if dims != 2 {
            u.kind = sh::BLUR_H;
            cur = self.pass(fr, &cur, None, &u);
        }
        if dims != 1 {
            u.kind = sh::BLUR_V;
            cur = self.pass(fr, &cur, None, &u);
        }
        cur
    }

    fn curves_for(&self, ctx: &EvalCtx, layer: &Layer, e: &Effect) -> Tex {
        let get = |key: &str| ctx.param(layer, e, key).and_then(|v| if let ParamValue::Str(s) = v { Some(s) } else { None });
        let rows = [
            crate::color::curve_row(get("master").as_deref(), None),
            crate::color::curve_row(get("red").as_deref(), None),
            crate::color::curve_row(get("green").as_deref(), None),
            crate::color::curve_row(get("blue").as_deref(), None),
            crate::color::curve_row(get("hueVsHue").as_deref(), None),
            crate::color::curve_row(get("hueVsSat").as_deref(), Some(0.5)),
            crate::color::curve_row(get("hueVsLum").as_deref(), Some(0.5)),
            crate::color::curve_row(get("lumVsSat").as_deref(), Some(0.5)),
        ];
        self.gpu.curves_texture(&rows)
    }

    fn lut_for(&self, path: &str) -> Option<Arc<Tex>> {
        if path.is_empty() {
            return None;
        }
        if let Some(t) = self.luts.lock().get(path) {
            return Some(t.clone());
        }
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                self.warn(format!("LUT {path}: {e}"));
                return None;
            }
        };
        match crate::color::parse_cube(&src) {
            Ok((n, data)) => {
                let t = Arc::new(self.gpu.lut_texture(n, &data));
                self.luts.lock().insert(path.to_string(), t.clone());
                Some(t)
            }
            Err(e) => {
                self.warn(format!("LUT {path}: {e}"));
                None
            }
        }
    }

    fn apply_effect(&self, fr: &mut Frame, ctx: &EvalCtx, layer: &Layer, e: &Effect, cur: TexRef, geom: Geom) -> TexRef {
        let Some(def) = registry::effect_def(&e.kind) else {
            self.warn(format!("Unknown effect '{}' skipped", e.kind));
            return cur;
        };
        if def.audio {
            return cur;
        }
        let mut u = self.base_u(ctx, layer, &cur, geom, def.shader);
        u.seed = (hash_str(&e.id) % 1000) as f32;
        let mut vals: Vec<ParamValue> = Vec::with_capacity(def.params.len());
        for (i, p) in def.params.iter().enumerate() {
            let v = ctx.param(layer, e, p.key).unwrap_or_else(|| p.default.clone());
            u.p[i] = pv_to_slot(&v);
            vals.push(v);
        }
        let num = |i: usize| vals.get(i).map(|v| v.num()).unwrap_or(0.0);
        match def.shader {
            sh::BLUR_H => {
                let dims = num(1).round() as u32;
                self.blur(fr, cur, geom, num(0), dims, e.kind == "boxBlur", vals.get(2).map(|v| v.boolean()).unwrap_or(false))
            }
            sh::GLOW => {
                let bright = self.pass(fr, &cur, None, &u);
                let blurred = self.blur(fr, bright, geom, num(1), 0, false, false);
                u.kind = sh::GLOW_COMBINE;
                self.pass(fr, &blurred, Some(&cur), &u)
            }
            sh::DROP_SHADOW | sh::INNER_SHADOW => {
                let shadow = self.pass(fr, &cur, None, &u);
                let blurred = self.blur(fr, shadow, geom, num(4), 0, false, false);
                u.kind = if def.shader == sh::DROP_SHADOW { sh::SHADOW_COMBINE } else { k::INNER_COMBINE };
                self.pass(fr, &blurred, Some(&cur), &u)
            }
            sh::UNSHARP => {
                let blurred = self.blur(fr, cur.clone(), geom, num(1), 0, false, true);
                u.kind = sh::UNSHARP_COMBINE;
                self.pass(fr, &blurred, Some(&cur), &u)
            }
            sh::MATTE_CHOKE => {
                let blurred = self.blur(fr, cur.clone(), geom, num(1), 0, false, false);
                self.pass(fr, &blurred, Some(&cur), &u)
            }
            sh::CURVES | sh::COLOR_GRADE => {
                let curves = self.curves_for(ctx, layer, e);
                let out = fr.tex(cur.w, cur.h);
                self.gpu.effect(&mut fr.enc, &out, &cur, None, &u, Some(&curves), None);
                out
            }
            sh::LUT => {
                let path = vals.first().map(|v| v.str().to_string()).unwrap_or_default();
                match self.lut_for(&path) {
                    Some(lut) => {
                        let out = fr.tex(cur.w, cur.h);
                        self.gpu.effect(&mut fr.enc, &out, &cur, None, &u, None, Some(&lut));
                        out
                    }
                    None => cur,
                }
            }
            _ => self.pass(fr, &cur, None, &u),
        }
    }

    // ------------------------------------------------------------ 3D meshes

    fn eval_lights(&self, ctx: &EvalCtx) -> Vec<LightU> {
        let t = ctx.time;
        let mut out = Vec::new();
        for l in ctx.comp.layers.iter().filter(|l| l.visible && l.is_active_at(t)) {
            let LayerKind::Light(lp) = &l.kind else { continue };
            if out.len() >= 8 {
                break;
            }
            let w = eval::world_matrix(ctx, l, t);
            let pos = w.transform_point3(DVec3::ZERO);
            let dir = w.transform_vector3(DVec3::Z).normalize_or_zero();
            let c = ctx.prop(l, &lp.color, "light.color");
            let i = ctx.prop(l, &lp.intensity, "light.intensity") / 100.0;
            let cone = ctx.prop(l, &lp.cone_angle, "light.cone").clamp(1.0, 179.0);
            let feather = ctx.prop(l, &lp.cone_feather, "light.feather").clamp(0.0, 100.0) / 100.0;
            let kind = match lp.light {
                LightKind::Point => 0.0,
                LightKind::Directional => 1.0,
                LightKind::Spot => 2.0,
                LightKind::Area => 3.0,
                LightKind::Ambient => 4.0,
                LightKind::Environment => 5.0,
            };
            out.push(LightU {
                pos: [pos.x as f32, pos.y as f32, pos.z as f32, kind],
                dir: [dir.x as f32, dir.y as f32, dir.z as f32, 0.0],
                color: [(c[0] * i) as f32, (c[1] * i) as f32, (c[2] * i) as f32, 1.0],
                params: [
                    ctx.prop(l, &lp.range, "light.range") as f32,
                    ((cone / 2.0) * (1.0 - feather)).to_radians().cos() as f32,
                    (cone / 2.0).to_radians().cos() as f32,
                    ctx.prop(l, &lp.falloff, "light.falloff") as f32,
                ],
            });
        }
        if out.is_empty() {
            // Default studio lighting so lit meshes are visible without any light layers.
            out.push(LightU { pos: [0.0, 0.0, 0.0, 4.0], color: [0.28, 0.28, 0.3, 1.0], ..Default::default() });
            let d = DVec3::new(0.45, 0.6, 1.0).normalize();
            out.push(LightU { pos: [0.0, 0.0, 0.0, 1.0], dir: [d.x as f32, d.y as f32, d.z as f32, 0.0], color: [0.95, 0.93, 0.9, 1.0], params: [1e6, 1.0, 1.0, 1.0] });
        }
        out
    }

    fn mesh_for(&self, ctx: &EvalCtx, layer: &Layer) -> Option<Arc<GpuMesh>> {
        let project = ctx.project;
        let (key, build): (u64, Box<dyn Fn() -> Option<mesh::MeshData>>) = match &layer.kind {
            LayerKind::Mesh(mp) => {
                let key = hash_str(&format!("{}{}", serde_json::to_string(&mp.primitive).ok()?, mp.smooth));
                let prim = mp.primitive.clone();
                let smooth = mp.smooth;
                let target = ctx.comp.height as f32 / 2.0;
                let path = match &prim {
                    MeshPrimitive::Imported { asset, .. } => project.asset(asset).map(|a| a.path.clone()),
                    _ => None,
                };
                (
                    key,
                    Box::new(move || {
                        let m = match &prim {
                            MeshPrimitive::Imported { node, .. } => {
                                let p = path.clone()?;
                                let r = if p.to_lowercase().ends_with(".obj") { mesh::load_obj(&p, target) } else { mesh::load_gltf(&p, *node, target) };
                                match r {
                                    Ok(m) => m,
                                    Err(e) => {
                                        log::warn!("mesh import failed: {e}");
                                        return None;
                                    }
                                }
                            }
                            other => mesh::primitive(other),
                        };
                        Some(if smooth { m } else { m.flat() })
                    }),
                )
            }
            LayerKind::Text(tp) => {
                let paths = raster::text_paths(ctx, layer, tp, ctx.comp.width, ctx.comp.height);
                let key = hash_str(&format!("text{}{}{}{}{}", ctx.plain(layer, &tp.text), tp.font_family, tp.font_weight, tp.extrude, tp.font_size.at(ctx.time - layer.start)));
                let depth = tp.extrude as f32;
                (key, Box::new(move || Some(mesh::extrude(&paths, depth, [0.0, 0.0]))))
            }
            LayerKind::Shape(sp) => {
                let paths = raster::shape_paths(ctx, layer, sp, ctx.comp.width, ctx.comp.height);
                let key = hash_str(&format!("shape{}{}", serde_json::to_string(&sp.items).ok()?, ctx.time - layer.start));
                let depth = sp.extrude as f32;
                (key, Box::new(move || Some(mesh::extrude(&paths, depth, [0.0, 0.0]))))
            }
            _ => return None,
        };
        if let Some(m) = self.meshes.lock().get(&key) {
            return Some(m.clone());
        }
        let data = build()?;
        if data.indices.is_empty() {
            return None;
        }
        let gm = Arc::new(self.gpu.upload_mesh(&data));
        let mut cache = self.meshes.lock();
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, gm.clone());
        Some(gm)
    }

    fn material_texture(&self, fr: &mut Frame, asset_id: &str) -> Option<Arc<Tex>> {
        let a = fr.project.asset(asset_id)?;
        let size = 1024u32;
        if let Some(t) = self.material_tex.lock().get(&(a.path.clone(), size)) {
            return Some(t.clone());
        }
        let (w, h) = (a.info.width.clamp(1, size), a.info.height.clamp(1, size));
        let f = self.decoders.frame(&Source::from_asset(a, false), 0.0, w, h).ok()??;
        let t = Arc::new(self.gpu.upload_rgba8(f.width, f.height, &f.data, wgpu::TextureFormat::Rgba8Unorm));
        self.material_tex.lock().insert((a.path.clone(), size), t.clone());
        Some(t)
    }

    fn place_mesh(&self, fr: &mut Frame, ctx: &EvalCtx, layer: &Layer, cam: &CameraEval, lights: &[LightU]) -> Option<TexRef> {
        let s = fr.opts.scale;
        let comp = ctx.comp;
        let (cw, ch) = self.comp_px(comp, s);
        let gm = self.mesh_for(ctx, layer)?;
        let t = ctx.time;
        let model = eval::world_matrix(ctx, layer, t);
        let tr = self.transitions(ctx, layer);
        let model = tr.extra * model;
        let opacity = eval::eval_transform(ctx, layer, t).opacity * tr.opacity;
        let mat = &layer.material;
        let mut base = ctx.prop(layer, &mat.base_color, "mat.base");
        // Extruded text/shapes take their colour from the 2D fill.
        match &layer.kind {
            LayerKind::Text(tp) => base = ctx.prop(layer, &tp.fill, "text.fill"),
            LayerKind::Shape(sp) => {
                if let Some(f) = sp.items.first().and_then(|i| i.fills.first()) {
                    base = ctx.prop(layer, &f.color, "shape.fill");
                }
            }
            _ => {}
        }
        let em = ctx.prop(layer, &mat.emission, "mat.em");
        let ems = ctx.prop(layer, &mat.emission_strength, "mat.ems");
        let tex = mat.base_texture.as_deref().and_then(|id| self.material_texture(fr, id));
        let mut lights_arr = [LightU::default(); 8];
        for (i, l) in lights.iter().take(8).enumerate() {
            lights_arr[i] = *l;
        }
        let normal_m = model.inverse().transpose();
        let u = MeshU {
            model: to_f32m(model),
            view_proj: to_f32m(cam.proj * cam.view),
            normal_m: to_f32m(normal_m),
            cam_pos: [cam.position.x as f32, cam.position.y as f32, cam.position.z as f32, 1.0],
            base: [base[0] as f32, base[1] as f32, base[2] as f32, base[3] as f32],
            emission: [(em[0] * ems) as f32, (em[1] * ems) as f32, (em[2] * ems) as f32, 0.0],
            pbr: [
                ctx.prop(layer, &mat.metallic, "mat.metal") as f32,
                ctx.prop(layer, &mat.roughness, "mat.rough") as f32,
                ctx.prop(layer, &mat.specular, "mat.spec") as f32,
                if mat.lit { 1.0 } else { 0.0 },
            ],
            uvt: [mat.uv_tiling[0] as f32, mat.uv_tiling[1] as f32, mat.uv_offset[0] as f32, mat.uv_offset[1] as f32],
            misc: [opacity as f32, lights.len().min(8) as f32, if tex.is_some() { 1.0 } else { 0.0 }, 0.0],
            lights: lights_arr,
        };
        let out = fr.tex(cw, ch);
        let depth = self.gpu.depth_texture(cw, ch);
        let wire = matches!(&layer.kind, LayerKind::Mesh(m) if m.wireframe);
        self.gpu.draw_mesh(&mut fr.enc, &out, &depth, &gm, &u, tex.as_deref(), wire);
        // wgpu keeps resources referenced by recorded commands alive until they complete.
        drop(depth);
        let geom = Geom { w: comp.width as f64, h: comp.height as f64, pad: 0.0 };
        let mut cur = out;
        for e in layer.effects.iter().filter(|e| e.enabled) {
            cur = self.apply_effect(fr, ctx, layer, e, cur, geom);
        }
        Some(cur)
    }
}

impl Gpu {
    pub fn depth_texture(&self, w: u32, h: u32) -> Tex {
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = tex.create_view(&Default::default());
        Tex { tex, view, w, h, format: DEPTH }
    }
}

/// Project a comp-space point through the camera (used by the viewer for 3D gizmos).
pub fn project_point(cam: &CameraEval, p: DVec3, w: f64, h: f64) -> Option<(f64, f64)> {
    let c = cam.proj * cam.view * DVec4::new(p.x, p.y, p.z, 1.0);
    if c.w <= 0.0 {
        return None;
    }
    Some(((c.x / c.w + 1.0) * 0.5 * w, (1.0 - c.y / c.w) * 0.5 * h))
}
