//! Effect registry. Each effect declares its parameters once; the UI builds the inspector
//! from this list and every parameter is automatically keyframeable / expression-capable.
//!
//! GPU contract: parameter *i* of a visual effect is uploaded to `params[i]` (a vec4) in the
//! effect shader, in declaration order. Colours fill xyzw, points fill xy, numbers/bools/choices
//! fill x. `curve` and `file` parameters are handled out of band (LUT textures).

use crate::anim::{ParamValue, Prop};
use crate::model::{new_id, Effect};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ParamKind {
    Float { min: f64, max: f64, step: f64, #[serde(skip_serializing_if = "Option::is_none")] unit: Option<&'static str> },
    Angle,
    Color,
    /// A point in layer-source pixels (fractions of size when `relative`).
    Point { relative: bool },
    Bool,
    Choice { options: Vec<&'static str> },
    /// JSON-encoded curve points [[x,y],...] per channel.
    Curve,
    /// File path (e.g. `.cube` LUT).
    File { extensions: Vec<&'static str> },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ParamKind,
    pub default: ParamValue,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub advanced: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectDef {
    pub kind: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    /// Shader program id (`0` = handled specially by the renderer).
    pub shader: u32,
    pub audio: bool,
    pub params: Vec<ParamDef>,
}

fn f(key: &'static str, label: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Float { min, max, step: if max - min > 20.0 { 1.0 } else { 0.01 }, unit: None }, default: ParamValue::Num(default), advanced: false }
}
fn fu(key: &'static str, label: &'static str, default: f64, min: f64, max: f64, unit: &'static str) -> ParamDef {
    let mut p = f(key, label, default, min, max);
    if let ParamKind::Float { unit: u, .. } = &mut p.kind {
        *u = Some(unit);
    }
    p
}
fn ang(key: &'static str, label: &'static str, default: f64) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Angle, default: ParamValue::Num(default), advanced: false }
}
fn col(key: &'static str, label: &'static str, c: [f64; 4]) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Color, default: ParamValue::Vec(c.to_vec()), advanced: false }
}
fn pt(key: &'static str, label: &'static str, x: f64, y: f64) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Point { relative: true }, default: ParamValue::Vec(vec![x, y]), advanced: false }
}
fn b(key: &'static str, label: &'static str, v: bool) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Bool, default: ParamValue::Bool(v), advanced: false }
}
fn ch(key: &'static str, label: &'static str, options: &[&'static str], d: usize) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Choice { options: options.to_vec() }, default: ParamValue::Num(d as f64), advanced: false }
}
fn curve(key: &'static str, label: &'static str) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Curve, default: ParamValue::Str("[[0,0],[1,1]]".into()), advanced: false }
}
/// Curve whose neutral value is a flat line at 0.5 (used for "X vs Y" multiplier curves).
fn curve_flat(key: &'static str, label: &'static str) -> ParamDef {
    ParamDef { key, label, kind: ParamKind::Curve, default: ParamValue::Str("[[0,0.5],[1,0.5]]".into()), advanced: false }
}
fn adv(mut p: ParamDef) -> ParamDef {
    p.advanced = true;
    p
}

macro_rules! fx {
    ($kind:expr, $name:expr, $cat:expr, $shader:expr, $desc:expr, [$($p:expr),* $(,)?]) => {
        EffectDef { kind: $kind, name: $name, category: $cat, description: $desc, shader: $shader, audio: false, params: vec![$($p),*] }
    };
}
macro_rules! afx {
    ($kind:expr, $name:expr, $desc:expr, [$($p:expr),* $(,)?]) => {
        EffectDef { kind: $kind, name: $name, category: "Audio", description: $desc, shader: 0, audio: true, params: vec![$($p),*] }
    };
}

/// Shader ids (must match `effects.wgsl`).
pub mod sh {
    pub const COPY: u32 = 1;
    pub const BLUR_H: u32 = 2; // internal separable passes
    pub const BLUR_V: u32 = 3;
    pub const DIRECTIONAL_BLUR: u32 = 4;
    pub const RADIAL_BLUR: u32 = 5;
    pub const ZOOM_BLUR: u32 = 6;
    pub const SHARPEN: u32 = 7;
    pub const UNSHARP: u32 = 8;
    pub const LENS_BLUR: u32 = 9;
    pub const GLOW: u32 = 10;
    pub const LIGHT_RAYS: u32 = 11;
    pub const VIGNETTE: u32 = 12;
    pub const DROP_SHADOW: u32 = 13;
    pub const INNER_SHADOW: u32 = 14;
    pub const EXPOSURE: u32 = 15;
    pub const HIGHLIGHTS_SHADOWS: u32 = 16;
    pub const FILM_GRAIN: u32 = 17;
    pub const NOISE: u32 = 18;
    pub const CHROMATIC: u32 = 19;
    pub const LENS_DISTORT: u32 = 20;
    pub const TURBULENT: u32 = 21;
    pub const HEAT: u32 = 22;
    pub const PIXELATE: u32 = 23;
    pub const POSTERIZE: u32 = 24;
    pub const LENS_FLARE: u32 = 25;
    pub const CARTOON: u32 = 26;
    pub const STROKE: u32 = 27;
    pub const EDGE: u32 = 28;
    pub const SKETCH: u32 = 29;
    pub const HALFTONE: u32 = 30;
    pub const THRESHOLD: u32 = 31;
    pub const DUOTONE: u32 = 32;
    pub const TRITONE: u32 = 33;
    pub const VHS: u32 = 34;
    pub const GLITCH: u32 = 35;
    pub const RGB_SPLIT: u32 = 36;
    pub const SCANLINES: u32 = 37;
    pub const FILM: u32 = 38;
    pub const PIXEL_ART: u32 = 39;
    pub const BULGE: u32 = 40;
    pub const WAVE: u32 = 41;
    pub const CORNER_PIN: u32 = 42;
    pub const TRANSFORM: u32 = 43;
    pub const MIRROR: u32 = 44;
    pub const KALEIDO: u32 = 45;
    pub const TWIRL: u32 = 46;
    pub const RIPPLE: u32 = 47;
    pub const COLOR_BALANCE: u32 = 48;
    pub const HUE_SAT: u32 = 49;
    pub const CURVES: u32 = 50;
    pub const LEVELS: u32 = 51;
    pub const TEMP_TINT: u32 = 52;
    pub const VIBRANCE: u32 = 53;
    pub const BLACK_WHITE: u32 = 54;
    pub const COLOR_REPLACE: u32 = 55;
    pub const LUT: u32 = 56;
    pub const COLOR_GRADE: u32 = 57;
    pub const BRIGHT_CONTRAST: u32 = 58;
    pub const INVERT: u32 = 59;
    pub const FILL: u32 = 60;
    pub const CHROMA_KEY: u32 = 61;
    pub const LUMA_KEY: u32 = 62;
    pub const SPILL: u32 = 63;
    pub const MATTE_CHOKE: u32 = 64;
    pub const GRADIENT_RAMP: u32 = 65;
    pub const SELECTIVE_COLOR: u32 = 66;
    pub const GLOW_COMBINE: u32 = 67; // internal
    pub const SHADOW_COMBINE: u32 = 68; // internal
    pub const UNSHARP_COMBINE: u32 = 69; // internal
    pub const MOSAIC: u32 = 70;
    pub const OPACITY_MUL: u32 = 71; // internal: multiply by mask texture
    pub const MESH_WARP: u32 = 72;
    pub const LIQUIFY: u32 = 73;
}

pub fn effects() -> &'static [EffectDef] {
    static R: std::sync::OnceLock<Vec<EffectDef>> = std::sync::OnceLock::new();
    R.get_or_init(build)
}

pub fn effect_def(kind: &str) -> Option<&'static EffectDef> {
    effects().iter().find(|e| e.kind == kind)
}

fn build() -> Vec<EffectDef> {
    use sh::*;
    let blend3 = ["Normal", "Screen", "Add"];
    vec![
        // ---------------------------------------------------------------- Blur & Sharpen
        fx!("gaussianBlur", "Gaussian Blur", "Blur & Sharpen", BLUR_H, "Smooth, high quality blur.", [
            f("radius", "Blurriness", 10.0, 0.0, 500.0), ch("dimensions", "Dimensions", &["Horizontal & Vertical", "Horizontal", "Vertical"], 0), b("repeatEdges", "Repeat Edge Pixels", false)]),
        fx!("boxBlur", "Box Blur", "Blur & Sharpen", BLUR_H, "Fast box blur.", [f("radius", "Radius", 8.0, 0.0, 300.0), ch("dimensions", "Dimensions", &["Horizontal & Vertical", "Horizontal", "Vertical"], 0), b("repeatEdges", "Repeat Edge Pixels", false)]),
        fx!("directionalBlur", "Directional Blur", "Blur & Sharpen", DIRECTIONAL_BLUR, "Blur along an angle.", [ang("angle", "Direction", 0.0), f("length", "Blur Length", 20.0, 0.0, 500.0)]),
        fx!("radialBlur", "Radial Blur", "Blur & Sharpen", RADIAL_BLUR, "Spin blur around a centre.", [pt("center", "Center", 0.5, 0.5), f("amount", "Amount", 10.0, 0.0, 180.0)]),
        fx!("zoomBlur", "Zoom Blur", "Blur & Sharpen", ZOOM_BLUR, "Blur outward from a centre.", [pt("center", "Center", 0.5, 0.5), f("amount", "Amount", 20.0, 0.0, 100.0)]),
        fx!("motionBlurFx", "Motion Blur (Directional)", "Blur & Sharpen", DIRECTIONAL_BLUR, "Simulated camera motion blur.", [ang("angle", "Direction", 90.0), f("length", "Length", 30.0, 0.0, 500.0)]),
        fx!("lensBlur", "Lens Blur", "Blur & Sharpen", LENS_BLUR, "Bokeh-style disc blur.", [f("radius", "Iris Radius", 8.0, 0.0, 100.0), f("brightness", "Specular Brightness", 0.0, 0.0, 2.0)]),
        fx!("sharpen", "Sharpen", "Blur & Sharpen", SHARPEN, "Increase edge contrast.", [f("amount", "Sharpen Amount", 30.0, 0.0, 500.0)]),
        fx!("unsharpMask", "Unsharp Mask", "Blur & Sharpen", UNSHARP, "Classic unsharp mask sharpening.", [f("amount", "Amount", 80.0, 0.0, 500.0), f("radius", "Radius", 2.0, 0.0, 50.0), f("threshold", "Threshold", 0.0, 0.0, 1.0)]),
        // ---------------------------------------------------------------- Light
        fx!("glow", "Glow", "Light", GLOW, "Glow from bright areas.", [
            f("threshold", "Threshold", 0.6, 0.0, 1.0), f("radius", "Radius", 25.0, 0.0, 400.0), f("intensity", "Intensity", 1.0, 0.0, 10.0), col("color", "Tint", [1.0, 1.0, 1.0, 1.0]), ch("blend", "Composite", &blend3, 2)]),
        fx!("bloom", "Bloom", "Light", GLOW, "Soft cinematic bloom.", [
            f("threshold", "Threshold", 0.75, 0.0, 1.0), f("radius", "Radius", 60.0, 0.0, 400.0), f("intensity", "Intensity", 0.6, 0.0, 10.0), col("color", "Tint", [1.0, 0.95, 0.95, 1.0]), ch("blend", "Composite", &blend3, 1)]),
        fx!("lightRays", "Light Rays", "Light", LIGHT_RAYS, "Volumetric rays from a source.", [pt("center", "Source", 0.5, 0.3), f("length", "Ray Length", 0.5, 0.0, 1.0), f("intensity", "Intensity", 1.0, 0.0, 5.0), f("threshold", "Threshold", 0.5, 0.0, 1.0)]),
        fx!("lensFlare", "Lens Flare", "Light", LENS_FLARE, "Procedural lens flare.", [pt("center", "Flare Center", 0.3, 0.3), f("intensity", "Brightness", 1.0, 0.0, 5.0), col("color", "Color", [1.0, 0.85, 0.7, 1.0]), f("size", "Size", 1.0, 0.1, 4.0)]),
        fx!("vignette", "Vignette", "Light", VIGNETTE, "Darken or lighten the edges.", [f("amount", "Amount", 0.5, -1.0, 1.0), f("size", "Size", 0.6, 0.0, 1.5), f("roundness", "Roundness", 0.5, 0.0, 1.0), f("feather", "Feather", 0.5, 0.01, 1.0), col("color", "Color", [0.0, 0.0, 0.0, 1.0])]),
        fx!("dropShadow", "Drop Shadow", "Light", DROP_SHADOW, "Shadow behind the layer's alpha.", [col("color", "Shadow Color", [0.0, 0.0, 0.0, 1.0]), f("opacity", "Opacity", 0.6, 0.0, 1.0), ang("angle", "Direction", 135.0), f("distance", "Distance", 15.0, 0.0, 1000.0), f("softness", "Softness", 20.0, 0.0, 250.0), b("shadowOnly", "Shadow Only", false)]),
        fx!("innerShadow", "Inner Shadow", "Light", INNER_SHADOW, "Shadow inside the layer's alpha.", [col("color", "Shadow Color", [0.0, 0.0, 0.0, 1.0]), f("opacity", "Opacity", 0.6, 0.0, 1.0), ang("angle", "Direction", 135.0), f("distance", "Distance", 8.0, 0.0, 300.0), f("softness", "Softness", 10.0, 0.0, 250.0)]),
        fx!("lightWrap", "Light Wrap", "Light", GLOW, "Brighten edges with surrounding light.", [f("threshold", "Threshold", 0.0, 0.0, 1.0), f("radius", "Width", 12.0, 0.0, 200.0), f("intensity", "Intensity", 0.5, 0.0, 5.0), col("color", "Tint", [1.0, 1.0, 1.0, 1.0]), ch("blend", "Composite", &blend3, 1)]),
        fx!("exposure", "Exposure", "Light", EXPOSURE, "Photographic exposure.", [fu("exposure", "Exposure", 0.0, -5.0, 5.0, "stops"), f("offset", "Offset", 0.0, -0.5, 0.5), f("gamma", "Gamma Correction", 1.0, 0.1, 4.0)]),
        fx!("highlightsShadows", "Highlights & Shadows", "Light", HIGHLIGHTS_SHADOWS, "Recover highlights and lift shadows.", [f("highlights", "Highlights", 0.0, -1.0, 1.0), f("shadows", "Shadows", 0.0, -1.0, 1.0), f("whites", "Whites", 0.0, -1.0, 1.0), f("blacks", "Blacks", 0.0, -1.0, 1.0)]),
        fx!("filmGrain", "Film Grain", "Light", FILM_GRAIN, "Animated photographic grain.", [f("amount", "Intensity", 0.15, 0.0, 1.0), f("size", "Grain Size", 1.5, 0.5, 8.0), b("animated", "Animate", true), b("color", "Color Grain", false)]),
        fx!("noise", "Noise", "Light", NOISE, "Random pixel noise.", [f("amount", "Amount", 0.2, 0.0, 1.0), b("mono", "Monochrome", true), b("animated", "Animate", true)]),
        fx!("chromaticAberration", "Chromatic Aberration", "Light", CHROMATIC, "Lens colour fringing.", [f("amount", "Amount", 6.0, 0.0, 100.0), pt("center", "Center", 0.5, 0.5)]),
        fx!("lensDistortion", "Lens Distortion", "Light", LENS_DISTORT, "Barrel/pincushion distortion.", [f("amount", "Curvature", 0.2, -1.0, 1.0), f("zoom", "Zoom", 1.0, 0.5, 2.0)]),
        fx!("heatDistortion", "Heat Distortion", "Light", HEAT, "Rising heat-haze shimmer.", [f("amount", "Strength", 6.0, 0.0, 50.0), f("scale", "Scale", 40.0, 2.0, 400.0), f("speed", "Speed", 1.0, 0.0, 10.0)]),
        fx!("pixelate", "Pixelate", "Stylize", PIXELATE, "Large square pixels.", [f("size", "Cell Size", 12.0, 1.0, 400.0)]),
        fx!("posterize", "Posterize", "Stylize", POSTERIZE, "Reduce colour levels.", [f("levels", "Levels", 6.0, 2.0, 64.0)]),
        // ---------------------------------------------------------------- Stylize
        fx!("cartoon", "Cartoon", "Stylize", CARTOON, "Flat colour with ink edges.", [f("levels", "Shading Steps", 5.0, 2.0, 16.0), f("edge", "Edge Strength", 1.0, 0.0, 4.0), f("edgeWidth", "Edge Width", 1.0, 0.5, 5.0)]),
        fx!("stroke", "Outline", "Stylize", STROKE, "Outline the layer's alpha.", [col("color", "Color", [0.95, 0.55, 0.59, 1.0]), f("width", "Width", 4.0, 0.0, 40.0), b("outlineOnly", "Outline Only", false)]),
        fx!("edgeDetect", "Find Edges", "Stylize", EDGE, "Sobel edge detection.", [f("amount", "Strength", 1.0, 0.0, 5.0), b("invert", "Invert", false), f("blend", "Blend With Original", 0.0, 0.0, 1.0)]),
        fx!("sketch", "Sketch", "Stylize", SKETCH, "Pencil sketch look.", [f("amount", "Strength", 1.5, 0.0, 5.0), col("paper", "Paper", [0.96, 0.95, 0.92, 1.0]), col("ink", "Ink", [0.1, 0.1, 0.1, 1.0])]),
        fx!("halftone", "Halftone", "Stylize", HALFTONE, "Print-style dot screen.", [f("size", "Dot Size", 8.0, 2.0, 100.0), ang("angle", "Angle", 45.0), b("color", "CMY Color", false)]),
        fx!("threshold", "Threshold", "Stylize", THRESHOLD, "Black/white threshold.", [f("level", "Level", 0.5, 0.0, 1.0), f("softness", "Softness", 0.0, 0.0, 0.5)]),
        fx!("duotone", "Duotone", "Stylize", DUOTONE, "Map luminance to two colours.", [col("dark", "Shadows", [0.12, 0.05, 0.15, 1.0]), col("light", "Highlights", [0.95, 0.55, 0.59, 1.0]), f("mix", "Mix", 1.0, 0.0, 1.0)]),
        fx!("tritone", "Tritone", "Stylize", TRITONE, "Map luminance to three colours.", [col("shadows", "Shadows", [0.05, 0.05, 0.1, 1.0]), col("midtones", "Midtones", [0.6, 0.35, 0.4, 1.0]), col("highlights", "Highlights", [1.0, 0.95, 0.85, 1.0]), f("mix", "Mix", 1.0, 0.0, 1.0)]),
        fx!("mosaic", "Mosaic", "Stylize", MOSAIC, "Rectangular mosaic tiles.", [f("cols", "Horizontal Blocks", 40.0, 1.0, 400.0), f("rows", "Vertical Blocks", 22.0, 1.0, 400.0), b("sharp", "Sharp Colors", true)]),
        fx!("vhs", "VHS", "Stylize", VHS, "Analog tape artefacts.", [f("amount", "Amount", 0.6, 0.0, 1.0), f("noise", "Tape Noise", 0.3, 0.0, 1.0), f("bleed", "Color Bleed", 3.0, 0.0, 20.0)]),
        fx!("glitch", "Glitch", "Stylize", GLITCH, "Digital block glitch.", [f("amount", "Amount", 0.5, 0.0, 1.0), f("blockSize", "Block Size", 24.0, 2.0, 200.0), f("speed", "Speed", 8.0, 0.0, 60.0), f("rgb", "RGB Shift", 8.0, 0.0, 60.0)]),
        fx!("rgbSplit", "RGB Split", "Stylize", RGB_SPLIT, "Offset colour channels.", [f("amount", "Distance", 6.0, 0.0, 100.0), ang("angle", "Angle", 0.0)]),
        fx!("scanlines", "Scanlines", "Stylize", SCANLINES, "CRT scanlines.", [f("density", "Line Spacing", 4.0, 1.0, 40.0), f("intensity", "Intensity", 0.35, 0.0, 1.0), f("roll", "Roll Speed", 0.0, -50.0, 50.0)]),
        fx!("filmEmulation", "Film Emulation", "Stylize", FILM, "Filmic tone, halation and fade.", [f("strength", "Strength", 0.7, 0.0, 1.0), f("warmth", "Warmth", 0.2, -1.0, 1.0), f("fade", "Fade", 0.1, 0.0, 1.0), f("halation", "Halation", 0.2, 0.0, 1.0)]),
        fx!("retro", "Retro", "Stylize", FILM, "Faded vintage print.", [f("strength", "Strength", 1.0, 0.0, 1.0), f("warmth", "Warmth", 0.5, -1.0, 1.0), f("fade", "Fade", 0.35, 0.0, 1.0), f("halation", "Halation", 0.0, 0.0, 1.0)]),
        fx!("pixelArt", "Pixel Art", "Stylize", PIXEL_ART, "Low-res, limited palette.", [f("size", "Pixel Size", 6.0, 1.0, 64.0), f("levels", "Color Levels", 5.0, 2.0, 32.0), b("outline", "Dark Outline", false)]),
        // ---------------------------------------------------------------- Distort
        fx!("bulge", "Warp (Bulge)", "Distort", BULGE, "Bulge or pinch an area.", [pt("center", "Center", 0.5, 0.5), f("radius", "Radius", 0.3, 0.0, 2.0), f("amount", "Amount", 0.5, -1.0, 1.0)]),
        fx!("meshWarp", "Mesh Warp", "Distort", MESH_WARP, "Bend with a 3x3 grid of offsets.", [
            pt("p00", "Top Left", 0.0, 0.0), pt("p10", "Top", 0.0, 0.0), pt("p20", "Top Right", 0.0, 0.0),
            pt("p01", "Left", 0.0, 0.0), pt("p11", "Middle", 0.0, 0.0), pt("p21", "Right", 0.0, 0.0),
            pt("p02", "Bottom Left", 0.0, 0.0), pt("p12", "Bottom", 0.0, 0.0), pt("p22", "Bottom Right", 0.0, 0.0)]),
        fx!("liquify", "Liquify (Push)", "Distort", LIQUIFY, "Push pixels from one point toward another.", [pt("from", "From", 0.45, 0.5), pt("to", "To", 0.55, 0.5), f("radius", "Brush Size", 0.2, 0.01, 1.0), f("strength", "Pressure", 1.0, 0.0, 2.0)]),
        fx!("turbulentDisplace", "Turbulent Displace", "Distort", TURBULENT, "Organic noise displacement.", [f("amount", "Amount", 30.0, 0.0, 400.0), f("size", "Size", 80.0, 2.0, 1000.0), f("evolution", "Evolution", 0.0, -1000.0, 1000.0), f("complexity", "Complexity", 3.0, 1.0, 6.0)]),
        fx!("displacement", "Displacement", "Distort", TURBULENT, "Displace pixels by a noise map.", [f("amount", "Max Displacement", 15.0, 0.0, 400.0), f("size", "Map Scale", 200.0, 2.0, 2000.0), f("evolution", "Evolution", 0.0, -1000.0, 1000.0), f("complexity", "Complexity", 1.0, 1.0, 6.0)]),
        fx!("wave", "Wave Warp", "Distort", WAVE, "Sine-wave distortion.", [f("amplitude", "Height", 10.0, 0.0, 400.0), f("wavelength", "Width", 60.0, 1.0, 2000.0), f("speed", "Speed", 1.0, -20.0, 20.0), ang("angle", "Direction", 90.0)]),
        fx!("cornerPin", "Corner Pin", "Distort", CORNER_PIN, "Pin corners (perspective).", [pt("tl", "Upper Left", 0.0, 0.0), pt("tr", "Upper Right", 1.0, 0.0), pt("bl", "Lower Left", 0.0, 1.0), pt("br", "Lower Right", 1.0, 1.0)]),
        fx!("perspective", "Perspective", "Distort", CORNER_PIN, "Perspective skew via corner pin.", [pt("tl", "Upper Left", 0.1, 0.0), pt("tr", "Upper Right", 0.9, 0.0), pt("bl", "Lower Left", 0.0, 1.0), pt("br", "Lower Right", 1.0, 1.0)]),
        fx!("transformFx", "Transform", "Distort", TRANSFORM, "Transform inside the effect stack.", [pt("position", "Position", 0.5, 0.5), f("scale", "Scale", 100.0, 0.0, 1000.0), ang("rotation", "Rotation", 0.0), f("opacity", "Opacity", 100.0, 0.0, 100.0), f("skew", "Skew", 0.0, -80.0, 80.0)]),
        fx!("mirror", "Mirror", "Distort", MIRROR, "Mirror across a line.", [pt("center", "Reflection Center", 0.5, 0.5), ang("angle", "Reflection Angle", 0.0)]),
        fx!("kaleidoscope", "Kaleidoscope", "Distort", KALEIDO, "Radial mirrored segments.", [pt("center", "Center", 0.5, 0.5), f("segments", "Segments", 6.0, 2.0, 32.0), ang("angle", "Rotation", 0.0)]),
        fx!("twirl", "Twirl", "Distort", TWIRL, "Swirl around a centre.", [pt("center", "Center", 0.5, 0.5), ang("angle", "Angle", 180.0), f("radius", "Radius", 0.4, 0.0, 2.0)]),
        fx!("ripple", "Ripple", "Distort", RIPPLE, "Concentric ripples.", [pt("center", "Center", 0.5, 0.5), f("amplitude", "Amplitude", 6.0, 0.0, 100.0), f("wavelength", "Wavelength", 30.0, 2.0, 500.0), f("speed", "Speed", 2.0, -20.0, 20.0)]),
        // ---------------------------------------------------------------- Color
        fx!("colorGrade", "Color Grade", "Color", COLOR_GRADE, "Primary grade: lift / gamma / gain wheels and tone.", [
            col("lift", "Lift", [0.0, 0.0, 0.0, 0.0]), col("gamma", "Gamma", [0.0, 0.0, 0.0, 0.0]), col("gain", "Gain", [0.0, 0.0, 0.0, 0.0]), col("offset", "Offset", [0.0, 0.0, 0.0, 0.0]),
            fu("exposure", "Exposure", 0.0, -5.0, 5.0, "stops"), f("contrast", "Contrast", 1.0, 0.0, 3.0), f("pivot", "Pivot", 0.435, 0.0, 1.0), f("saturation", "Saturation", 1.0, 0.0, 3.0),
            f("temperature", "Temperature", 0.0, -1.0, 1.0), f("tint", "Tint", 0.0, -1.0, 1.0), f("highlights", "Highlights", 0.0, -1.0, 1.0), f("shadows", "Shadows", 0.0, -1.0, 1.0),
            f("whites", "Whites", 0.0, -1.0, 1.0), f("blacks", "Blacks", 0.0, -1.0, 1.0), f("vibrance", "Vibrance", 0.0, -1.0, 1.0), b("logWheels", "Log Wheels", false),
            adv(curve("hueVsHue", "Hue vs Hue")), adv(curve_flat("hueVsSat", "Hue vs Sat")), adv(curve_flat("hueVsLum", "Hue vs Lum")), adv(curve_flat("lumVsSat", "Lum vs Sat"))]),
        fx!("curves", "Curves", "Color", CURVES, "RGB tone curves.", [curve("master", "Master"), curve("red", "Red"), curve("green", "Green"), curve("blue", "Blue")]),
        fx!("levels", "Levels", "Color", LEVELS, "Input/output levels and gamma.", [f("inBlack", "Input Black", 0.0, 0.0, 1.0), f("inWhite", "Input White", 1.0, 0.0, 1.0), f("gamma", "Gamma", 1.0, 0.1, 5.0), f("outBlack", "Output Black", 0.0, 0.0, 1.0), f("outWhite", "Output White", 1.0, 0.0, 1.0)]),
        fx!("colorBalance", "Color Balance", "Color", COLOR_BALANCE, "Shift shadows, midtones and highlights.", [col("shadows", "Shadows", [0.0, 0.0, 0.0, 0.0]), col("midtones", "Midtones", [0.0, 0.0, 0.0, 0.0]), col("highlights", "Highlights", [0.0, 0.0, 0.0, 0.0]), b("preserveLum", "Preserve Luminosity", true)]),
        fx!("hueSaturation", "Hue / Saturation", "Color", HUE_SAT, "Hue rotation and saturation.", [ang("hue", "Master Hue", 0.0), f("saturation", "Saturation", 0.0, -1.0, 1.0), f("lightness", "Lightness", 0.0, -1.0, 1.0), b("colorize", "Colorize", false)]),
        fx!("temperatureTint", "Temperature / Tint", "Color", TEMP_TINT, "White balance.", [f("temperature", "Temperature", 0.0, -1.0, 1.0), f("tint", "Tint", 0.0, -1.0, 1.0)]),
        fx!("vibrance", "Vibrance", "Color", VIBRANCE, "Smart saturation.", [f("vibrance", "Vibrance", 0.3, -1.0, 1.0), f("saturation", "Saturation", 0.0, -1.0, 1.0)]),
        fx!("blackWhite", "Black & White", "Color", BLACK_WHITE, "Monochrome with channel weights.", [f("amount", "Amount", 1.0, 0.0, 1.0), f("red", "Reds", 0.3, -2.0, 3.0), f("green", "Greens", 0.59, -2.0, 3.0), f("blue", "Blues", 0.11, -2.0, 3.0)]),
        fx!("colorReplace", "Change to Color", "Color", COLOR_REPLACE, "Replace one hue with another.", [col("from", "From", [1.0, 0.0, 0.0, 1.0]), col("to", "To", [0.0, 0.4, 1.0, 1.0]), f("tolerance", "Tolerance", 0.15, 0.0, 1.0), f("softness", "Softness", 0.1, 0.0, 1.0)]),
        fx!("selectiveColor", "Selective Color", "Color", SELECTIVE_COLOR, "Adjust a hue range.", [ang("hue", "Hue Center", 0.0), f("range", "Range", 30.0, 1.0, 180.0), ang("hueShift", "Hue Shift", 0.0), f("saturation", "Saturation", 0.0, -1.0, 1.0), f("lightness", "Lightness", 0.0, -1.0, 1.0)]),
        fx!("lut", "Apply LUT", "Color", LUT, "Apply a .cube 3D LUT.", [ParamDef { key: "file", label: "LUT File", kind: ParamKind::File { extensions: vec!["cube"] }, default: ParamValue::Str(String::new()), advanced: false }, f("intensity", "Intensity", 1.0, 0.0, 1.0)]),
        fx!("brightnessContrast", "Brightness & Contrast", "Color", BRIGHT_CONTRAST, "Simple brightness/contrast.", [f("brightness", "Brightness", 0.0, -1.0, 1.0), f("contrast", "Contrast", 0.0, -1.0, 1.0)]),
        fx!("invert", "Invert", "Color", INVERT, "Invert colours.", [f("amount", "Blend", 1.0, 0.0, 1.0)]),
        fx!("fill", "Fill", "Color", FILL, "Fill with a solid colour.", [col("color", "Color", [0.95, 0.55, 0.59, 1.0]), f("opacity", "Opacity", 1.0, 0.0, 1.0)]),
        fx!("gradientRamp", "Gradient Ramp", "Generate", GRADIENT_RAMP, "Linear or radial gradient.", [pt("start", "Start", 0.5, 0.0), col("startColor", "Start Color", [0.06, 0.06, 0.06, 1.0]), pt("end", "End", 0.5, 1.0), col("endColor", "End Color", [0.95, 0.55, 0.59, 1.0]), ch("shape", "Shape", &["Linear", "Radial"], 0), f("blend", "Blend With Original", 0.0, 0.0, 1.0)]),
        // ---------------------------------------------------------------- Keying
        fx!("chromaKey", "Chroma Key", "Keying", CHROMA_KEY, "Key out green/blue screens.", [col("keyColor", "Key Color", [0.1, 0.8, 0.2, 1.0]), f("tolerance", "Tolerance", 0.25, 0.0, 1.0), f("softness", "Edge Softness", 0.1, 0.0, 1.0), f("spill", "Spill Suppression", 0.6, 0.0, 1.0), f("choke", "Choke", 0.0, -1.0, 1.0)]),
        fx!("lumaKey", "Luma Key", "Keying", LUMA_KEY, "Key by brightness.", [f("threshold", "Threshold", 0.1, 0.0, 1.0), f("softness", "Softness", 0.1, 0.0, 1.0), b("invert", "Key Out Brighter", false)]),
        fx!("spillSuppressor", "Spill Suppressor", "Keying", SPILL, "Remove colour spill.", [col("keyColor", "Color to Suppress", [0.1, 0.8, 0.2, 1.0]), f("amount", "Suppression", 1.0, 0.0, 1.0)]),
        fx!("matteChoker", "Matte Choker", "Keying", MATTE_CHOKE, "Refine matte edges.", [f("choke", "Choke", 0.0, -1.0, 1.0), f("softness", "Edge Softness", 1.0, 0.0, 20.0), f("gamma", "Gray Level Softness", 1.0, 0.1, 4.0)]),
        // ---------------------------------------------------------------- Audio (processed by the mixer)
        afx!("aEqualizer", "Equalizer", "3-band parametric EQ.", [f("low", "Low (100 Hz) dB", 0.0, -24.0, 24.0), f("mid", "Mid (1 kHz) dB", 0.0, -24.0, 24.0), f("high", "High (8 kHz) dB", 0.0, -24.0, 24.0)]),
        afx!("aCompressor", "Compressor", "Dynamic range compression.", [f("threshold", "Threshold dB", -18.0, -60.0, 0.0), f("ratio", "Ratio", 4.0, 1.0, 20.0), f("attack", "Attack ms", 20.0, 0.01, 2000.0), f("release", "Release ms", 250.0, 0.01, 9000.0), f("makeup", "Makeup dB", 0.0, 0.0, 24.0)]),
        afx!("aLimiter", "Limiter", "Brick-wall limiter.", [f("ceiling", "Ceiling dB", -1.0, -30.0, 0.0), f("release", "Release ms", 50.0, 1.0, 8000.0)]),
        afx!("aReverb", "Reverb", "Room reverb.", [f("room", "Room Size", 0.5, 0.0, 1.0), f("mix", "Wet", 0.3, 0.0, 1.0)]),
        afx!("aDelay", "Delay / Echo", "Echo delay.", [f("delay", "Delay ms", 300.0, 1.0, 5000.0), f("feedback", "Decay", 0.4, 0.0, 0.95), f("mix", "Wet", 0.4, 0.0, 1.0)]),
        afx!("aDistortion", "Distortion", "Bit-crush / overdrive.", [f("drive", "Drive", 0.5, 0.0, 1.0)]),
        afx!("aNoiseReduction", "Noise Reduction", "FFT denoiser.", [f("amount", "Reduction dB", 12.0, 0.01, 97.0), f("floor", "Noise Floor dB", -50.0, -80.0, -20.0)]),
        afx!("aNoiseGate", "Noise Gate", "Silence quiet passages.", [f("threshold", "Threshold dB", -40.0, -80.0, 0.0), f("ratio", "Ratio", 10.0, 1.0, 9000.0), f("attack", "Attack ms", 10.0, 0.01, 9000.0), f("release", "Release ms", 250.0, 0.01, 9000.0)]),
        afx!("aStereoWiden", "Stereo Widening", "Widen the stereo image.", [f("width", "Width", 0.4, 0.0, 1.0)]),
        afx!("aPitch", "Pitch Shift", "Shift pitch without changing speed.", [f("semitones", "Semitones", 0.0, -24.0, 24.0)]),
        afx!("aTimeStretch", "Time Stretch", "Change tempo, keep pitch (affects mixer only).", [f("tempo", "Tempo", 1.0, 0.5, 2.0)]),
        afx!("aHighPass", "High Pass", "Remove low rumble.", [f("freq", "Frequency Hz", 80.0, 10.0, 2000.0)]),
        afx!("aLowPass", "Low Pass", "Remove high frequencies.", [f("freq", "Frequency Hz", 12000.0, 200.0, 20000.0)]),
    ]
}

/// Create a fresh effect instance with default parameter values.
pub fn instantiate(kind: &str) -> Option<Effect> {
    let def = effect_def(kind)?;
    let mut params = BTreeMap::new();
    for p in &def.params {
        params.insert(p.key.to_string(), Prop::new(p.default.clone()));
    }
    Some(Effect { id: new_id(), kind: kind.to_string(), enabled: true, name: None, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for e in effects() {
            assert!(seen.insert(e.kind), "duplicate effect {}", e.kind);
            assert!(e.params.len() <= 24, "{} has too many params for the GPU block", e.kind);
            assert!(e.audio || e.shader != 0, "{} has no shader", e.kind);
            let mut keys = std::collections::HashSet::new();
            for p in &e.params {
                assert!(keys.insert(p.key), "duplicate param {}.{}", e.kind, p.key);
            }
        }
        assert!(instantiate("gaussianBlur").unwrap().params.contains_key("radius"));
    }
}
