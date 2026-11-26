//! The VEYRA project document. This is the single source of truth that is serialised to
//! `.veyra` files and mirrored 1:1 by `ui/src/types/project.ts`.

use crate::anim::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Id = String;

pub fn new_id() -> Id {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    pub compositions: Vec<Composition>,
    pub active_comp: Id,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub parent: Option<Id>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    ImageSequence,
    Svg,
    Model3d,
    Lut,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub has_alpha: bool,
    #[serde(default)]
    pub video_codec: String,
    #[serde(default)]
    pub pix_fmt: String,
    #[serde(default)]
    pub audio_codec: String,
    #[serde(default)]
    pub sample_rate: u32,
    #[serde(default)]
    pub channels: u32,
    #[serde(default)]
    pub frame_count: u64,
    #[serde(default)]
    pub variable_frame_rate: bool,
    #[serde(default)]
    pub rotation: i32,
    #[serde(default)]
    pub color_space: String,
    #[serde(default)]
    pub bit_rate: u64,
    #[serde(default)]
    pub file_size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: Id,
    pub name: String,
    pub kind: AssetKind,
    /// Absolute path at last save.
    pub path: String,
    /// Path relative to the project file, used first when reopening.
    #[serde(default)]
    pub relative_path: Option<String>,
    pub info: MediaInfo,
    #[serde(default)]
    pub folder: Option<Id>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    /// Proxy file, if one was generated.
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default = "yes")]
    pub use_proxy: bool,
    /// Image sequence frame pattern (ffmpeg style, e.g. `C:/seq/frame_%04d.png`).
    #[serde(default)]
    pub sequence_pattern: Option<String>,
    #[serde(default)]
    pub sequence_start: u32,
    /// Runtime flag, recomputed on load.
    #[serde(default)]
    pub missing: bool,
    /// Content hash (size + head/tail) for duplicate detection.
    #[serde(default)]
    pub fingerprint: String,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: Id,
    pub t: f64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Composition {
    pub id: Id,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub background: Color,
    /// When true the background is not drawn and exports keep alpha.
    pub transparent: bool,
    #[serde(default = "one")]
    pub pixel_aspect: f64,
    #[serde(default = "default_sr")]
    pub sample_rate: u32,
    #[serde(default = "two")]
    pub channels: u32,
    #[serde(default)]
    pub color_space: ColorSpace,
    /// Layers, index 0 = topmost (rendered last).
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub work_area: Option<[f64; 2]>,
    #[serde(default)]
    pub motion_blur: MotionBlurSettings,
}

fn one() -> f64 {
    1.0
}
fn two() -> u32 {
    2
}
fn default_sr() -> u32 {
    48000
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColorSpace {
    #[default]
    Rec709,
    Srgb,
    Rec2020,
    DisplayP3,
    Linear,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionBlurSettings {
    pub shutter_angle: f64,
    pub shutter_phase: f64,
    pub samples: u32,
}
impl Default for MotionBlurSettings {
    fn default() -> Self {
        Self { shutter_angle: 180.0, shutter_phase: -90.0, samples: 8 }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    HardLight,
    Darken,
    Lighten,
    Difference,
    Exclusion,
    Add,
    Subtract,
    Color,
    Hue,
    Saturation,
    Luminosity,
}

impl BlendMode {
    pub fn index(self) -> u32 {
        self as u32
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatteMode {
    Alpha,
    AlphaInverted,
    Luma,
    LumaInverted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMatte {
    pub layer: Id,
    pub mode: MatteMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub anchor: Prop<Vec3>,
    pub position: Prop<Vec3>,
    /// Percent, 100 = 1:1.
    pub scale: Prop<Vec3>,
    /// Degrees around X, Y, Z. 2D layers only use Z.
    pub rotation: Prop<Vec3>,
    /// 0..100.
    pub opacity: Prop<f64>,
}

impl Transform {
    pub fn centered(w: f64, h: f64, cx: f64, cy: f64) -> Self {
        Self {
            anchor: Prop::new([w / 2.0, h / 2.0, 0.0]),
            position: Prop::new([cx, cy, 0.0]),
            scale: Prop::new([100.0, 100.0, 100.0]),
            rotation: Prop::new([0.0, 0.0, 0.0]),
            opacity: Prop::new(100.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    Add,
    Subtract,
    Intersect,
    Difference,
    Lighten,
    Darken,
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub id: Id,
    pub name: String,
    pub mode: MaskMode,
    pub inverted: bool,
    /// Path in layer-source pixel space.
    pub path: Prop<BezPath>,
    pub feather: Prop<f64>,
    pub expansion: Prop<f64>,
    /// 0..100.
    pub opacity: Prop<f64>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: Id,
    /// Registry key, e.g. `gaussianBlur`.
    pub kind: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub name: Option<String>,
    pub params: BTreeMap<String, Prop<ParamValue>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    CrossDissolve,
    DipToBlack,
    DipToWhite,
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    SlideLeft,
    SlideRight,
    ZoomIn,
    ZoomOut,
    Blur,
    Spin,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub kind: TransitionKind,
    pub duration: f64,
    #[serde(default = "default_ease")]
    pub ease: bool,
}
fn default_ease() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProps {
    /// dB, 0 = unity.
    pub volume: Prop<f64>,
    /// -1 left .. 1 right.
    pub pan: Prop<f64>,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// Audio effect chain, processed by the export/preview mixer.
    #[serde(default)]
    pub effects: Vec<Effect>,
}

impl Default for AudioProps {
    fn default() -> Self {
        Self { volume: Prop::new(0.0), pan: Prop::new(0.0), fade_in: 0.0, fade_out: 0.0, effects: vec![] }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: Id,
    pub name: String,
    pub kind: LayerKind,
    /// Composition time where the layer's visible range begins.
    pub start: f64,
    /// Visible duration on the timeline (seconds).
    pub duration: f64,
    /// Offset into the source in source seconds (trim in).
    #[serde(default)]
    pub source_in: f64,
    /// Playback speed multiplier (2 = twice as fast).
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default)]
    pub reverse: bool,
    /// Freeze on this source time if set.
    #[serde(default)]
    pub freeze_at: Option<f64>,
    /// Time remap curve: layer-local time -> source seconds. Overrides speed.
    #[serde(default)]
    pub time_remap: Option<Prop<f64>>,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub solo: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub shy: bool,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub group: Option<Id>,
    #[serde(default)]
    pub parent: Option<Id>,
    #[serde(default)]
    pub is_3d: bool,
    #[serde(default)]
    pub blend: BlendMode,
    pub transform: Transform,
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub masks: Vec<Mask>,
    #[serde(default)]
    pub track_matte: Option<TrackMatte>,
    #[serde(default)]
    pub audio: AudioProps,
    #[serde(default)]
    pub motion_blur: bool,
    #[serde(default)]
    pub transition_in: Option<Transition>,
    #[serde(default)]
    pub transition_out: Option<Transition>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    /// Material used when the layer is 3D (planes, meshes, extruded text/shapes).
    #[serde(default)]
    pub material: Material,
}

impl Layer {
    pub fn end(&self) -> f64 {
        self.start + self.duration
    }
    pub fn is_active_at(&self, t: f64) -> bool {
        t >= self.start - 1e-9 && t < self.end() - 1e-9
    }
    /// Layer-local time (seconds since the layer started).
    pub fn local_time(&self, comp_t: f64) -> f64 {
        comp_t - self.start
    }
    /// Map composition time to source media seconds, honouring speed, reverse, freeze and remap.
    pub fn source_time(&self, comp_t: f64) -> f64 {
        let local = self.local_time(comp_t);
        if let Some(f) = self.freeze_at {
            return f;
        }
        if let Some(r) = &self.time_remap {
            return r.at(local).max(0.0);
        }
        if self.reverse {
            let span = self.duration * self.speed;
            return (self.source_in + span - local * self.speed).max(self.source_in);
        }
        self.source_in + local * self.speed
    }
    pub fn is_renderable(&self) -> bool {
        !matches!(self.kind, LayerKind::Null | LayerKind::Camera(_) | LayerKind::Light(_) | LayerKind::Audio { .. })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LayerKind {
    Media { asset: Id },
    Audio { asset: Id },
    Solid { color: Prop<Color>, width: u32, height: u32 },
    Text(Box<TextProps>),
    Shape(Box<ShapeProps>),
    Null,
    Adjustment,
    /// A nested composition (also used for compound clips).
    Comp { comp: Id, #[serde(default)] compound: bool },
    Camera(Box<CameraProps>),
    Light(Box<LightProps>),
    Mesh(Box<MeshProps>),
    Particles(Box<ParticleProps>),
    Generator(Box<GeneratorProps>),
}

impl LayerKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            LayerKind::Media { .. } => "media",
            LayerKind::Audio { .. } => "audio",
            LayerKind::Solid { .. } => "solid",
            LayerKind::Text(_) => "text",
            LayerKind::Shape(_) => "shape",
            LayerKind::Null => "null",
            LayerKind::Adjustment => "adjustment",
            LayerKind::Comp { .. } => "comp",
            LayerKind::Camera(_) => "camera",
            LayerKind::Light(_) => "light",
            LayerKind::Mesh(_) => "mesh",
            LayerKind::Particles(_) => "particles",
            LayerKind::Generator(_) => "generator",
        }
    }
}

// ---------------------------------------------------------------- Text

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VAlign {
    Top,
    #[default]
    Middle,
    Bottom,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextProps {
    pub text: Prop<String>,
    pub font_family: String,
    pub font_weight: u16,
    #[serde(default)]
    pub italic: bool,
    pub font_size: Prop<f64>,
    pub tracking: Prop<f64>,
    pub line_height: Prop<f64>,
    pub fill: Prop<Color>,
    #[serde(default)]
    pub gradient: Option<Gradient>,
    pub stroke: Prop<Color>,
    pub stroke_width: Prop<f64>,
    pub align: Align,
    #[serde(default)]
    pub valign: VAlign,
    /// Wrap width in px; 0 = no wrapping (point text).
    #[serde(default)]
    pub box_width: f64,
    #[serde(default)]
    pub background: Option<TextBackground>,
    #[serde(default)]
    pub animators: Vec<TextAnimator>,
    /// Optional path the baseline follows (layer space).
    #[serde(default)]
    pub on_path: Option<BezPath>,
    /// Extrusion depth for 3D text (0 = flat).
    #[serde(default)]
    pub extrude: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextBackground {
    pub color: Prop<Color>,
    pub padding: f64,
    pub radius: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextUnit {
    Characters,
    Words,
    Lines,
}

/// After-Effects-style range animator: properties are applied to each unit in proportion to
/// how much the unit is covered by the [start, end] (+offset) selection.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextAnimator {
    pub id: Id,
    pub name: String,
    pub unit: TextUnit,
    /// 0..100 %.
    pub start: Prop<f64>,
    pub end: Prop<f64>,
    pub offset: Prop<f64>,
    /// 0 = hard edge, 100 = fully smooth ramp.
    #[serde(default)]
    pub smoothness: f64,
    pub opacity: Prop<f64>,
    pub position: Prop<Vec2>,
    pub scale: Prop<f64>,
    pub rotation: Prop<f64>,
    pub tracking: Prop<f64>,
    #[serde(default)]
    pub fill: Option<Prop<Color>>,
}

// ---------------------------------------------------------------- Shapes

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Geometry {
    Rect { size: Prop<Vec2>, roundness: Prop<f64> },
    Ellipse { size: Prop<Vec2> },
    Polygon { points: Prop<f64>, outer_radius: Prop<f64>, inner_radius: Prop<f64>, star: bool, roundness: Prop<f64> },
    Line { to: Prop<Vec2> },
    Arrow { to: Prop<Vec2>, head: Prop<f64> },
    Path { path: Prop<BezPath> },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    pub pos: f64,
    pub color: Color,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gradient {
    pub radial: bool,
    pub start: Vec2,
    pub end: Vec2,
    pub stops: Vec<GradientStop>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub color: Prop<Color>,
    #[serde(default)]
    pub gradient: Option<Gradient>,
    pub opacity: Prop<f64>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LineCap {
    #[default]
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LineJoin {
    #[default]
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrokeAlign {
    #[default]
    Center,
    Inside,
    Outside,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub color: Prop<Color>,
    #[serde(default)]
    pub gradient: Option<Gradient>,
    pub width: Prop<f64>,
    pub opacity: Prop<f64>,
    #[serde(default)]
    pub cap: LineCap,
    #[serde(default)]
    pub join: LineJoin,
    #[serde(default)]
    pub align: StrokeAlign,
    #[serde(default)]
    pub dashes: Vec<f64>,
    #[serde(default)]
    pub dash_offset: Prop<f64>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repeater {
    pub copies: Prop<f64>,
    pub offset: Prop<Vec2>,
    pub rotation: Prop<f64>,
    pub scale: Prop<f64>,
    pub opacity_end: Prop<f64>,
    /// Radial repeater: copies arranged around a circle of this radius.
    #[serde(default)]
    pub radial: bool,
    #[serde(default)]
    pub radius: Prop<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrimPaths {
    pub start: Prop<f64>,
    pub end: Prop<f64>,
    pub offset: Prop<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapeItem {
    pub id: Id,
    pub name: String,
    pub geometry: Geometry,
    /// Offset of the shape centre from the layer centre.
    pub offset: Prop<Vec2>,
    pub rotation: Prop<f64>,
    pub fills: Vec<Fill>,
    pub strokes: Vec<Stroke>,
    #[serde(default)]
    pub repeater: Option<Repeater>,
    #[serde(default)]
    pub trim: Option<TrimPaths>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BooleanOp {
    #[default]
    None,
    Union,
    Subtract,
    Intersect,
    Exclude,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapeProps {
    pub items: Vec<ShapeItem>,
    /// Pixel combine mode between items (applied to coverage).
    #[serde(default)]
    pub combine: BooleanOp,
    /// Extrusion depth in px when the layer is 3D (0 = flat card).
    #[serde(default)]
    pub extrude: f64,
}

// ---------------------------------------------------------------- 3D

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Projection {
    #[default]
    Perspective,
    Orthographic,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraProps {
    pub projection: Projection,
    /// Distance in px from the camera at which a 3D layer at 100% scale appears 1:1.
    pub zoom: Prop<f64>,
    pub point_of_interest: Prop<Vec3>,
    pub use_point_of_interest: bool,
    pub depth_of_field: bool,
    pub focus_distance: Prop<f64>,
    /// Aperture in px; larger = more blur.
    pub aperture: Prop<f64>,
    pub near: f64,
    pub far: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LightKind {
    Point,
    Directional,
    Spot,
    Area,
    Ambient,
    Environment,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LightProps {
    pub light: LightKind,
    pub color: Prop<Color>,
    /// Percent, 100 = 1.0.
    pub intensity: Prop<f64>,
    pub range: Prop<f64>,
    pub cone_angle: Prop<f64>,
    pub cone_feather: Prop<f64>,
    pub falloff: Prop<f64>,
    pub casts_shadows: bool,
    pub shadow_darkness: Prop<f64>,
    #[serde(default = "default_shadow_res")]
    pub shadow_resolution: u32,
    /// Area light size in px.
    #[serde(default)]
    pub size: Prop<f64>,
}
fn default_shadow_res() -> u32 {
    1024
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub base_color: Prop<Color>,
    pub metallic: Prop<f64>,
    pub roughness: Prop<f64>,
    pub specular: Prop<f64>,
    pub emission: Prop<Color>,
    pub emission_strength: Prop<f64>,
    /// Accept lights (otherwise unlit, like an AE 2D-in-3D layer).
    pub lit: bool,
    #[serde(default)]
    pub base_texture: Option<Id>,
    #[serde(default)]
    pub normal_texture: Option<Id>,
    #[serde(default)]
    pub roughness_texture: Option<Id>,
    #[serde(default)]
    pub metallic_texture: Option<Id>,
    #[serde(default = "default_tiling")]
    pub uv_tiling: Vec2,
    #[serde(default)]
    pub uv_offset: Vec2,
    #[serde(default)]
    pub double_sided: bool,
}
fn default_tiling() -> Vec2 {
    [1.0, 1.0]
}

impl Default for Material {
    fn default() -> Self {
        Self {
            base_color: Prop::new([0.85, 0.85, 0.85, 1.0]),
            metallic: Prop::new(0.0),
            roughness: Prop::new(0.5),
            specular: Prop::new(0.5),
            emission: Prop::new([0.0, 0.0, 0.0, 1.0]),
            emission_strength: Prop::new(0.0),
            lit: false,
            base_texture: None,
            normal_texture: None,
            roughness_texture: None,
            metallic_texture: None,
            uv_tiling: [1.0, 1.0],
            uv_offset: [0.0, 0.0],
            double_sided: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MeshPrimitive {
    Cube { size: f64 },
    Sphere { radius: f64, segments: u32, rings: u32 },
    Cylinder { radius: f64, height: f64, segments: u32 },
    Cone { radius: f64, height: f64, segments: u32 },
    Torus { radius: f64, tube: f64, segments: u32, sides: u32 },
    Plane { width: f64, height: f64, subdivisions: u32 },
    Pyramid { size: f64, height: f64 },
    Circle { radius: f64, segments: u32 },
    Grid { width: f64, height: f64, cells: u32 },
    /// Mesh loaded from a glTF/GLB/OBJ asset (node index, or all nodes if None).
    Imported { asset: Id, #[serde(default)] node: Option<usize> },
    /// Inline editable polygon mesh (positions, triangle indices).
    Custom { positions: Vec<Vec3>, indices: Vec<u32> },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshProps {
    pub primitive: MeshPrimitive,
    #[serde(default)]
    pub wireframe: bool,
    #[serde(default)]
    pub smooth: bool,
}

// ---------------------------------------------------------------- Particles / generators

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EmitterShape {
    Point,
    Line,
    Box,
    Circle,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticleProps {
    pub emitter: EmitterShape,
    pub emitter_size: Prop<Vec2>,
    /// Particles per second.
    pub rate: Prop<f64>,
    pub max_particles: u32,
    pub lifetime: Prop<f64>,
    pub lifetime_random: f64,
    pub speed: Prop<f64>,
    pub speed_random: f64,
    /// Emission direction in degrees (0 = up), plus spread.
    pub direction: Prop<f64>,
    pub spread: Prop<f64>,
    pub gravity: Prop<Vec2>,
    pub drag: f64,
    pub turbulence: Prop<f64>,
    pub turbulence_scale: f64,
    pub size: Prop<f64>,
    pub size_random: f64,
    pub size_end: f64,
    pub rotation_speed: f64,
    pub color: Prop<Color>,
    pub color_end: Color,
    pub opacity: Prop<f64>,
    pub fade_out: bool,
    /// Floor y (layer space) particles bounce on, if set.
    #[serde(default)]
    pub floor: Option<f64>,
    pub bounce: f64,
    pub trail: u32,
    pub seed: u32,
    #[serde(default)]
    pub shape: ParticleShape,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ParticleShape {
    #[default]
    Circle,
    Square,
    Star,
    Spark,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GeneratorKind {
    Grid,
    Noise,
    Wave,
    Gradient,
    Checkerboard,
    AnimatedBackground,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorProps {
    pub generator: GeneratorKind,
    pub params: BTreeMap<String, Prop<ParamValue>>,
}

// ---------------------------------------------------------------- helpers

impl Project {
    pub fn comp(&self, id: &str) -> Option<&Composition> {
        self.compositions.iter().find(|c| c.id == id)
    }
    pub fn comp_mut(&mut self, id: &str) -> Option<&mut Composition> {
        self.compositions.iter_mut().find(|c| c.id == id)
    }
    pub fn asset(&self, id: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.id == id)
    }

    /// Returns an error if any composition (transitively) contains itself.
    pub fn check_nesting(&self) -> Result<(), String> {
        fn visit<'a>(p: &'a Project, id: &'a str, stack: &mut Vec<&'a str>) -> Result<(), String> {
            if stack.contains(&id) {
                return Err(format!("Composition cycle detected involving '{id}'"));
            }
            stack.push(id);
            if let Some(c) = p.comp(id) {
                for l in &c.layers {
                    if let LayerKind::Comp { comp, .. } = &l.kind {
                        visit(p, comp, stack)?;
                    }
                }
            }
            stack.pop();
            Ok(())
        }
        for c in &self.compositions {
            visit(self, &c.id, &mut Vec::new())?;
        }
        Ok(())
    }
}

impl Composition {
    pub fn new(name: &str, width: u32, height: u32, fps: f64, duration: f64) -> Self {
        Self {
            id: new_id(),
            name: name.to_string(),
            width,
            height,
            fps,
            duration,
            background: [0.0, 0.0, 0.0, 1.0],
            transparent: false,
            pixel_aspect: 1.0,
            sample_rate: 48000,
            channels: 2,
            color_space: ColorSpace::Rec709,
            layers: vec![],
            markers: vec![],
            work_area: None,
            motion_blur: MotionBlurSettings::default(),
        }
    }
    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == id)
    }
    pub fn frame_count(&self) -> u64 {
        (self.duration * self.fps).round().max(1.0) as u64
    }
    pub fn frame_time(&self, frame: u64) -> f64 {
        frame as f64 / self.fps
    }
    pub fn time_to_frame(&self, t: f64) -> u64 {
        // Small epsilon guards against 0.1 * 30 = 2.9999999 style truncation.
        ((t * self.fps) + 1e-6).floor().max(0.0) as u64
    }
    /// The active camera: topmost visible camera layer active at `t`.
    pub fn active_camera(&self, t: f64) -> Option<&Layer> {
        self.layers.iter().find(|l| l.visible && l.is_active_at(t) && matches!(l.kind, LayerKind::Camera(_)))
    }
}

impl Project {
    pub fn new(name: &str) -> Self {
        let comp = Composition::new("Main", 1920, 1080, 30.0, 10.0);
        Self {
            schema_version: SCHEMA_VERSION,
            id: new_id(),
            name: name.to_string(),
            assets: vec![],
            folders: vec![],
            active_comp: comp.id.clone(),
            compositions: vec![comp],
            meta: BTreeMap::new(),
        }
    }
}
