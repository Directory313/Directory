//! Default constructors for every layer type, so defaults live in one place (the UI asks
//! the backend for new layers rather than duplicating defaults).

use crate::anim::*;
use crate::model::*;
use std::collections::BTreeMap;

pub fn base_layer(name: &str, kind: LayerKind, comp: &Composition, start: f64, duration: f64, w: f64, h: f64) -> Layer {
    Layer {
        id: new_id(),
        name: name.to_string(),
        kind,
        start,
        duration,
        source_in: 0.0,
        speed: 1.0,
        reverse: false,
        freeze_at: None,
        time_remap: None,
        visible: true,
        locked: false,
        solo: false,
        muted: false,
        shy: false,
        label: None,
        group: None,
        parent: None,
        is_3d: false,
        blend: BlendMode::Normal,
        transform: Transform::centered(w, h, comp.width as f64 / 2.0, comp.height as f64 / 2.0),
        effects: vec![],
        masks: vec![],
        track_matte: None,
        audio: AudioProps::default(),
        motion_blur: false,
        transition_in: None,
        transition_out: None,
        markers: vec![],
        material: Material::default(),
    }
}

fn rest(comp: &Composition, start: f64) -> f64 {
    (comp.duration - start).max(1.0 / comp.fps)
}

pub fn media_layer(comp: &Composition, asset: &Asset, start: f64) -> Layer {
    let (w, h) = (asset.info.width.max(1) as f64, asset.info.height.max(1) as f64);
    let still = matches!(asset.kind, AssetKind::Image | AssetKind::Svg);
    let dur = if still || asset.info.duration <= 0.0 { rest(comp, start).min(5.0) } else { asset.info.duration };
    let kind = if asset.kind == AssetKind::Audio || !asset.info.has_video && asset.info.has_audio {
        LayerKind::Audio { asset: asset.id.clone() }
    } else {
        LayerKind::Media { asset: asset.id.clone() }
    };
    let mut l = base_layer(&asset.name, kind, comp, start, dur, w, h);
    // Scale media to fit inside the composition (up or down), like most editors do by default.
    let fit = (comp.width as f64 / w).min(comp.height as f64 / h);
    if (fit - 1.0).abs() > 1e-6 && !matches!(l.kind, LayerKind::Audio { .. }) {
        let s = fit * 100.0;
        l.transform.scale.value = [s, s, 100.0];
    }
    l
}

pub fn solid_layer(comp: &Composition, color: Color, start: f64) -> Layer {
    let (w, h) = (comp.width, comp.height);
    base_layer("Solid", LayerKind::Solid { color: Prop::new(color), width: w, height: h }, comp, start, rest(comp, start), w as f64, h as f64)
}

pub fn text_layer(comp: &Composition, text: &str, start: f64) -> Layer {
    let props = TextProps {
        text: Prop::new(text.to_string()),
        font_family: "Segoe UI".into(),
        font_weight: 600,
        italic: false,
        font_size: Prop::new((comp.height as f64 / 9.0).round()),
        tracking: Prop::new(0.0),
        line_height: Prop::new(1.2),
        fill: Prop::new([0.96, 0.96, 0.96, 1.0]),
        gradient: None,
        stroke: Prop::new([0.0, 0.0, 0.0, 1.0]),
        stroke_width: Prop::new(0.0),
        align: Align::Center,
        valign: VAlign::Middle,
        box_width: 0.0,
        background: None,
        animators: vec![],
        on_path: None,
        extrude: 0.0,
    };
    let (w, h) = (comp.width as f64, comp.height as f64);
    let mut l = base_layer(text, LayerKind::Text(Box::new(props)), comp, start, rest(comp, start).min(5.0), w, h);
    l.name = text.chars().take(24).collect();
    l
}

pub fn shape_item(geometry: Geometry, name: &str, color: Color) -> ShapeItem {
    ShapeItem {
        id: new_id(),
        name: name.into(),
        geometry,
        offset: Prop::new([0.0, 0.0]),
        rotation: Prop::new(0.0),
        fills: vec![Fill { color: Prop::new(color), gradient: None, opacity: Prop::new(100.0), enabled: true }],
        strokes: vec![Stroke {
            color: Prop::new([1.0, 1.0, 1.0, 1.0]),
            gradient: None,
            width: Prop::new(0.0),
            opacity: Prop::new(100.0),
            cap: LineCap::Round,
            join: LineJoin::Round,
            align: StrokeAlign::Center,
            dashes: vec![],
            dash_offset: Prop::new(0.0),
            enabled: true,
        }],
        repeater: None,
        trim: None,
    }
}

pub fn geometry(kind: &str, size: f64) -> Geometry {
    match kind {
        "ellipse" | "circle" => Geometry::Ellipse { size: Prop::new([size, size]) },
        "polygon" => Geometry::Polygon { points: Prop::new(6.0), outer_radius: Prop::new(size / 2.0), inner_radius: Prop::new(size / 4.0), star: false, roundness: Prop::new(0.0) },
        "triangle" => Geometry::Polygon { points: Prop::new(3.0), outer_radius: Prop::new(size / 2.0), inner_radius: Prop::new(size / 4.0), star: false, roundness: Prop::new(0.0) },
        "star" => Geometry::Polygon { points: Prop::new(5.0), outer_radius: Prop::new(size / 2.0), inner_radius: Prop::new(size / 4.5), star: true, roundness: Prop::new(0.0) },
        "line" => Geometry::Line { to: Prop::new([size, 0.0]) },
        "arrow" => Geometry::Arrow { to: Prop::new([size, 0.0]), head: Prop::new(size / 6.0) },
        "roundedRect" => Geometry::Rect { size: Prop::new([size * 1.6, size]), roundness: Prop::new(size / 6.0) },
        "path" => Geometry::Path { path: Prop::new(BezPath { vertices: vec![], closed: false }) },
        _ => Geometry::Rect { size: Prop::new([size * 1.6, size]), roundness: Prop::new(0.0) },
    }
}

pub fn shape_layer(comp: &Composition, kind: &str, start: f64) -> Layer {
    let size = (comp.height as f64 / 3.0).round();
    let mut item = shape_item(geometry(kind, size), kind, [1.0, 1.0, 1.0, 1.0]);
    if matches!(kind, "line" | "arrow" | "path") {
        item.fills[0].enabled = kind == "path";
        item.strokes[0].width.value = 8.0;
        item.strokes[0].color.value = [1.0, 1.0, 1.0, 1.0];
        if kind != "path" {
            item.offset.value = [-size / 2.0, 0.0];
        }
    }
    let props = ShapeProps { items: vec![item], combine: BooleanOp::None, extrude: 0.0 };
    let (w, h) = (comp.width as f64, comp.height as f64);
    let mut l = base_layer("Shape", LayerKind::Shape(Box::new(props)), comp, start, rest(comp, start), w, h);
    l.name = format!("{}{}", kind[..1].to_uppercase(), &kind[1..]);
    l
}

pub fn null_layer(comp: &Composition, start: f64) -> Layer {
    base_layer("Null", LayerKind::Null, comp, start, rest(comp, start), 100.0, 100.0)
}

pub fn adjustment_layer(comp: &Composition, start: f64) -> Layer {
    let (w, h) = (comp.width as f64, comp.height as f64);
    base_layer("Adjustment Layer", LayerKind::Adjustment, comp, start, rest(comp, start), w, h)
}

pub fn comp_layer(parent: &Composition, nested: &Composition, start: f64) -> Layer {
    base_layer(
        &nested.name,
        LayerKind::Comp { comp: nested.id.clone(), compound: false },
        parent,
        start,
        nested.duration,
        nested.width as f64,
        nested.height as f64,
    )
}

pub fn camera_layer(comp: &Composition, start: f64) -> Layer {
    let zoom = crate::eval::default_zoom(comp);
    let (w, h) = (comp.width as f64, comp.height as f64);
    let cam = CameraProps {
        projection: Projection::Perspective,
        zoom: Prop::new(zoom),
        point_of_interest: Prop::new([w / 2.0, h / 2.0, 0.0]),
        use_point_of_interest: true,
        depth_of_field: false,
        focus_distance: Prop::new(zoom),
        aperture: Prop::new(25.0),
        near: 1.0,
        far: 100000.0,
    };
    let mut l = base_layer("Camera", LayerKind::Camera(Box::new(cam)), comp, start, rest(comp, start), 0.0, 0.0);
    l.is_3d = true;
    l.transform.anchor.value = [0.0, 0.0, 0.0];
    l.transform.position.value = [w / 2.0, h / 2.0, -zoom];
    l
}

pub fn light_layer(comp: &Composition, kind: LightKind, start: f64) -> Layer {
    let (w, h) = (comp.width as f64, comp.height as f64);
    let lp = LightProps {
        light: kind,
        color: Prop::new([1.0, 1.0, 1.0, 1.0]),
        intensity: Prop::new(if kind == LightKind::Ambient { 25.0 } else { 100.0 }),
        range: Prop::new(3000.0),
        cone_angle: Prop::new(60.0),
        cone_feather: Prop::new(30.0),
        falloff: Prop::new(1.0),
        casts_shadows: false,
        shadow_darkness: Prop::new(60.0),
        shadow_resolution: 1024,
        size: Prop::new(200.0),
    };
    let name = format!("{kind:?} Light");
    let mut l = base_layer(&name, LayerKind::Light(Box::new(lp)), comp, start, rest(comp, start), 0.0, 0.0);
    l.is_3d = true;
    l.transform.anchor.value = [0.0, 0.0, 0.0];
    l.transform.position.value = [w * 0.3, h * 0.2, -600.0];
    l
}

pub fn mesh_layer(comp: &Composition, primitive: &str, start: f64) -> Layer {
    let s = (comp.height as f64 / 3.0).round();
    let prim = match primitive {
        "sphere" | "uvSphere" => MeshPrimitive::Sphere { radius: s / 2.0, segments: 48, rings: 24 },
        "cylinder" => MeshPrimitive::Cylinder { radius: s / 3.0, height: s, segments: 48 },
        "cone" => MeshPrimitive::Cone { radius: s / 2.5, height: s, segments: 48 },
        "torus" => MeshPrimitive::Torus { radius: s / 2.5, tube: s / 8.0, segments: 64, sides: 24 },
        "plane" => MeshPrimitive::Plane { width: s * 1.6, height: s, subdivisions: 1 },
        "pyramid" => MeshPrimitive::Pyramid { size: s, height: s },
        "circle" => MeshPrimitive::Circle { radius: s / 2.0, segments: 64 },
        "grid" => MeshPrimitive::Grid { width: s * 2.0, height: s * 2.0, cells: 10 },
        _ => MeshPrimitive::Cube { size: s },
    };
    let mut l = base_layer(primitive, LayerKind::Mesh(Box::new(MeshProps { primitive: prim, wireframe: false, smooth: true })), comp, start, rest(comp, start), 0.0, 0.0);
    l.name = format!("{}{}", primitive[..1].to_uppercase(), &primitive[1..]);
    l.is_3d = true;
    l.transform.anchor.value = [0.0, 0.0, 0.0];
    l.transform.rotation.value = [-20.0, 30.0, 0.0];
    l.material.lit = true;
    l.material.base_color.value = [1.0, 1.0, 1.0, 1.0];
    l.material.roughness.value = 0.35;
    l
}

pub fn particle_layer(comp: &Composition, start: f64) -> Layer {
    let (w, h) = (comp.width as f64, comp.height as f64);
    let p = ParticleProps {
        emitter: EmitterShape::Point,
        emitter_size: Prop::new([100.0, 100.0]),
        rate: Prop::new(60.0),
        max_particles: 4000,
        lifetime: Prop::new(3.0),
        lifetime_random: 0.3,
        speed: Prop::new(250.0),
        speed_random: 0.4,
        direction: Prop::new(0.0),
        spread: Prop::new(40.0),
        gravity: Prop::new([0.0, 150.0]),
        drag: 0.1,
        turbulence: Prop::new(0.0),
        turbulence_scale: 200.0,
        size: Prop::new(8.0),
        size_random: 0.5,
        size_end: 0.2,
        rotation_speed: 0.0,
        color: Prop::new([1.0, 0.75, 0.77, 1.0]),
        color_end: [0.95, 0.55, 0.59, 1.0],
        opacity: Prop::new(100.0),
        fade_out: true,
        floor: None,
        bounce: 0.5,
        trail: 0,
        seed: 1,
        shape: ParticleShape::Circle,
    };
    let mut l = base_layer("Particles", LayerKind::Particles(Box::new(p)), comp, start, rest(comp, start), w, h);
    l.transform.position.value = [w / 2.0, h / 2.0, 0.0];
    l
}

pub fn generator_layer(comp: &Composition, kind: GeneratorKind, start: f64) -> Layer {
    let mut params = BTreeMap::new();
    let mut put = |k: &str, v: ParamValue| {
        params.insert(k.to_string(), Prop::new(v));
    };
    match kind {
        GeneratorKind::Grid => {
            put("spacing", ParamValue::Num(80.0));
            put("width", ParamValue::Num(2.0));
            put("color", ParamValue::Vec(vec![1.0, 1.0, 1.0, 0.25]));
        }
        GeneratorKind::Noise => {
            put("scale", ParamValue::Num(120.0));
            put("evolution", ParamValue::Num(0.0));
            put("octaves", ParamValue::Num(4.0));
            put("contrast", ParamValue::Num(1.0));
        }
        GeneratorKind::Wave => {
            put("amplitude", ParamValue::Num(60.0));
            put("wavelength", ParamValue::Num(300.0));
            put("speed", ParamValue::Num(1.0));
            put("lines", ParamValue::Num(8.0));
            put("width", ParamValue::Num(3.0));
            put("color", ParamValue::Vec(vec![1.0, 1.0, 1.0, 1.0]));
        }
        GeneratorKind::Gradient => {
            put("colorA", ParamValue::Vec(vec![0.06, 0.06, 0.06, 1.0]));
            put("colorB", ParamValue::Vec(vec![1.0, 1.0, 1.0, 1.0]));
            put("angle", ParamValue::Num(90.0));
        }
        GeneratorKind::Checkerboard => {
            put("size", ParamValue::Num(64.0));
            put("colorA", ParamValue::Vec(vec![0.1, 0.1, 0.1, 1.0]));
            put("colorB", ParamValue::Vec(vec![0.2, 0.2, 0.2, 1.0]));
        }
        GeneratorKind::AnimatedBackground => {
            put("colorA", ParamValue::Vec(vec![0.07, 0.07, 0.07, 1.0]));
            put("colorB", ParamValue::Vec(vec![1.0, 1.0, 1.0, 1.0]));
            put("speed", ParamValue::Num(0.2));
            put("scale", ParamValue::Num(500.0));
        }
    }
    let (w, h) = (comp.width as f64, comp.height as f64);
    let mut l = base_layer(&format!("{kind:?}"), LayerKind::Generator(Box::new(GeneratorProps { generator: kind, params })), comp, start, rest(comp, start), w, h);
    l.name = format!("{kind:?} Generator");
    l
}

pub fn mask(kind: &str, w: f64, h: f64) -> Mask {
    let path = match kind {
        "ellipse" => ellipse_path(w / 2.0, h / 2.0, w * 0.3, h * 0.3),
        _ => rect_path(w * 0.2, h * 0.2, w * 0.8, h * 0.8),
    };
    Mask {
        id: new_id(),
        name: "Mask".into(),
        mode: MaskMode::Add,
        inverted: false,
        path: Prop::new(path),
        feather: Prop::new(0.0),
        expansion: Prop::new(0.0),
        opacity: Prop::new(100.0),
        enabled: true,
    }
}

pub fn rect_path(x0: f64, y0: f64, x1: f64, y1: f64) -> BezPath {
    let v = |x, y| PathVertex { p: [x, y], i: [0.0, 0.0], o: [0.0, 0.0] };
    BezPath { vertices: vec![v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)], closed: true }
}

pub fn ellipse_path(cx: f64, cy: f64, rx: f64, ry: f64) -> BezPath {
    const K: f64 = 0.5522847498;
    BezPath {
        vertices: vec![
            PathVertex { p: [cx, cy - ry], i: [-rx * K, 0.0], o: [rx * K, 0.0] },
            PathVertex { p: [cx + rx, cy], i: [0.0, -ry * K], o: [0.0, ry * K] },
            PathVertex { p: [cx, cy + ry], i: [rx * K, 0.0], o: [-rx * K, 0.0] },
            PathVertex { p: [cx - rx, cy], i: [0.0, ry * K], o: [0.0, -ry * K] },
        ],
        closed: true,
    }
}
