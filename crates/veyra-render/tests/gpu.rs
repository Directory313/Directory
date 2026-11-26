//! GPU integration tests: render real frames and inspect pixels.

use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use veyra_core::anim::ParamValue;
use veyra_core::factory::*;
use veyra_core::model::*;
use veyra_core::registry;
use veyra_media::DecoderPool;
use veyra_render::gpu::{GPU_ERRORS, LAST_GPU_ERROR};
use veyra_render::{Gpu, Image, RenderOptions, Renderer};

fn renderer() -> &'static Renderer {
    static R: OnceLock<Renderer> = OnceLock::new();
    R.get_or_init(|| Renderer::new(Arc::new(Gpu::new().expect("GPU init")), Arc::new(DecoderPool::default())))
}

fn px(img: &Image, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * img.width + x) * 4) as usize;
    [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
}

fn project(w: u32, h: u32) -> Project {
    let mut p = Project::new("t");
    p.compositions[0].width = w;
    p.compositions[0].height = h;
    p.compositions[0].duration = 2.0;
    p
}

fn render(p: &Project, t: f64) -> Image {
    let before = GPU_ERRORS.load(Ordering::SeqCst);
    let img = renderer().render(p, &p.active_comp, t, RenderOptions { scale: 1.0, use_proxies: false, draft: false }).expect("render");
    let after = GPU_ERRORS.load(Ordering::SeqCst);
    assert_eq!(before, after, "GPU validation error: {}", LAST_GPU_ERROR.lock().unwrap());
    img
}

fn alpha_count(img: &Image) -> usize {
    img.data.chunks_exact(4).filter(|p| p[3] > 8).count()
}

#[test]
fn background_and_transparency() {
    let mut p = project(64, 36);
    p.compositions[0].background = [1.0, 0.0, 0.0, 1.0];
    let img = render(&p, 0.0);
    assert_eq!((img.width, img.height), (64, 36));
    assert_eq!(px(&img, 10, 10), [255, 0, 0, 255]);
    p.compositions[0].transparent = true;
    let img = render(&p, 0.0);
    assert_eq!(px(&img, 10, 10)[3], 0, "transparent comps must keep alpha 0, not black");
}

#[test]
fn solid_transform_and_keyframes() {
    let mut p = project(200, 100);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    let mut l = solid_layer(&comp, [0.0, 0.0, 1.0, 1.0], 0.0);
    if let LayerKind::Solid { width, height, .. } = &mut l.kind {
        *width = 20;
        *height = 20;
    }
    l.transform.anchor.value = [10.0, 10.0, 0.0];
    l.transform.position.set_key(0.0, [30.0, 50.0, 0.0]);
    l.transform.position.set_key(1.0, [170.0, 50.0, 0.0]);
    p.compositions[0].layers.push(l);
    let a = render(&p, 0.0);
    assert_eq!(px(&a, 30, 50), [0, 0, 255, 255]);
    assert_eq!(px(&a, 170, 50)[3], 0);
    let b = render(&p, 1.0);
    assert_eq!(px(&b, 170, 50), [0, 0, 255, 255], "keyframed position must move the layer");
    assert_eq!(px(&b, 30, 50)[3], 0);
    let m = render(&p, 0.5);
    assert_eq!(px(&m, 100, 50)[2], 255, "linear interpolation midpoint");
}

#[test]
fn text_shapes_particles_generators_render() {
    let mut p = project(320, 180);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    for l in [text_layer(&comp, "VEYRA", 0.0), shape_layer(&comp, "star", 0.0), particle_layer(&comp, 0.0), generator_layer(&comp, GeneratorKind::Noise, 0.0)] {
        let mut q = p.clone();
        let name = l.kind.type_name();
        q.compositions[0].layers = vec![l];
        let img = render(&q, 1.0);
        assert!(alpha_count(&img) > 30, "{name} rendered nothing");
    }
}

#[test]
fn masks_affect_compositing() {
    let mut p = project(100, 100);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    let mut l = solid_layer(&comp, [1.0, 1.0, 1.0, 1.0], 0.0);
    l.masks.push(mask("ellipse", 100.0, 100.0));
    p.compositions[0].layers.push(l);
    let img = render(&p, 0.0);
    assert_eq!(px(&img, 50, 50)[3], 255);
    assert_eq!(px(&img, 2, 2)[3], 0, "outside the mask must be transparent");
}

#[test]
fn every_effect_runs_without_gpu_errors() {
    let mut p = project(96, 54);
    let comp = p.compositions[0].clone();
    let base = shape_layer(&comp, "ellipse", 0.0);
    for def in registry::effects().iter().filter(|d| !d.audio) {
        let mut l = base.clone();
        l.effects.push(registry::instantiate(def.kind).unwrap());
        p.compositions[0].layers = vec![l];
        let _ = render(&p, 0.5);
    }
}

#[test]
fn effects_process_pixels() {
    let mut p = project(80, 80);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    let mut l = solid_layer(&comp, [1.0, 0.0, 0.0, 1.0], 0.0);
    if let LayerKind::Solid { width, height, .. } = &mut l.kind {
        *width = 40;
        *height = 40;
    }
    l.transform.anchor.value = [20.0, 20.0, 0.0];
    l.transform.position.value = [40.0, 40.0, 0.0];
    p.compositions[0].layers = vec![l.clone()];
    let plain = render(&p, 0.0);
    assert_eq!(px(&plain, 15, 40)[3], 0);
    // Invert: red -> cyan
    let mut inv = l.clone();
    inv.effects.push(registry::instantiate("invert").unwrap());
    p.compositions[0].layers = vec![inv];
    assert_eq!(px(&render(&p, 0.0), 40, 40), [0, 255, 255, 255]);
    // Gaussian blur spreads alpha beyond the original edge (padding works).
    let mut bl = l.clone();
    let mut e = registry::instantiate("gaussianBlur").unwrap();
    e.params.get_mut("radius").unwrap().value = ParamValue::Num(12.0);
    bl.effects.push(e);
    p.compositions[0].layers = vec![bl];
    let blurred = render(&p, 0.0);
    assert!(px(&blurred, 15, 40)[3] > 10, "blur should extend outside the layer bounds");
    assert!(px(&blurred, 40, 40)[3] > 200);
}

#[test]
fn blend_modes_and_track_matte() {
    let mut p = project(40, 40);
    p.compositions[0].background = [0.5, 0.5, 0.5, 1.0];
    let comp = p.compositions[0].clone();
    let mut top = solid_layer(&comp, [0.5, 0.5, 0.5, 1.0], 0.0);
    top.blend = BlendMode::Multiply;
    p.compositions[0].layers = vec![top.clone()];
    let m = render(&p, 0.0);
    assert!((px(&m, 20, 20)[0] as i32 - 64).abs() <= 3, "multiply 0.5*0.5 ~ 0.25, got {:?}", px(&m, 20, 20));
    top.blend = BlendMode::Screen;
    p.compositions[0].layers = vec![top.clone()];
    let s = render(&p, 0.0);
    assert!((px(&s, 20, 20)[0] as i32 - 191).abs() <= 3, "screen ~0.75, got {:?}", px(&s, 20, 20));
    for mode in [BlendMode::Overlay, BlendMode::SoftLight, BlendMode::HardLight, BlendMode::Darken, BlendMode::Lighten, BlendMode::Difference, BlendMode::Exclusion, BlendMode::Add, BlendMode::Subtract, BlendMode::Color, BlendMode::Hue, BlendMode::Saturation, BlendMode::Luminosity] {
        top.blend = mode;
        p.compositions[0].layers = vec![top.clone()];
        let _ = render(&p, 0.0);
    }
    // Track matte: white layer shown only through an ellipse matte.
    p.compositions[0].transparent = true;
    let mut fill = solid_layer(&comp, [1.0, 1.0, 1.0, 1.0], 0.0);
    let matte = shape_layer(&comp, "ellipse", 0.0);
    fill.track_matte = Some(TrackMatte { layer: matte.id.clone(), mode: MatteMode::Alpha });
    p.compositions[0].layers = vec![fill, matte];
    let img = render(&p, 0.0);
    assert_eq!(px(&img, 20, 20)[3], 255);
    assert_eq!(px(&img, 1, 1)[3], 0, "outside matte hidden; matte layer itself not drawn");
}

#[test]
fn nested_comp_null_parenting_and_compound() {
    let mut p = project(100, 100);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    let mut sq = solid_layer(&comp, [0.0, 1.0, 0.0, 1.0], 0.0);
    if let LayerKind::Solid { width, height, .. } = &mut sq.kind {
        *width = 10;
        *height = 10;
    }
    sq.transform.anchor.value = [5.0, 5.0, 0.0];
    sq.transform.position.value = [50.0, 50.0, 0.0];
    let mut n = null_layer(&comp, 0.0);
    n.transform.position.value = [50.0, 50.0, 0.0];
    n.transform.anchor.value = [50.0, 50.0, 0.0];
    n.transform.position.set_key(0.0, [50.0, 50.0, 0.0]);
    n.transform.position.set_key(1.0, [80.0, 50.0, 0.0]);
    sq.parent = Some(n.id.clone());
    p.compositions[0].layers = vec![sq.clone(), n];
    let img = render(&p, 1.0);
    assert_eq!(px(&img, 80, 50)[1], 255, "child follows animated null");
    assert_eq!(px(&img, 50, 50)[3], 0, "null itself is invisible");
    // Pre-compose both into a compound clip: output must be identical.
    let ids: Vec<String> = p.compositions[0].layers.iter().map(|l| l.id.clone()).collect();
    let cid = p.compositions[0].id.clone();
    veyra_core::ops::make_compound(&mut p, &cid, &ids, "Compound").unwrap();
    let img2 = render(&p, 1.0);
    assert_eq!(img.data, img2.data, "compound clip must preserve its contents");
}

#[test]
fn three_d_camera_mesh_and_extrusion() {
    let mut p = project(160, 90);
    p.compositions[0].transparent = true;
    let comp = p.compositions[0].clone();
    let cube = mesh_layer(&comp, "cube", 0.0);
    let cam = camera_layer(&comp, 0.0);
    let light = light_layer(&comp, LightKind::Point, 0.0);
    p.compositions[0].layers = vec![cube.clone(), cam, light];
    let img = render(&p, 0.0);
    let n = alpha_count(&img);
    assert!(n > 500, "cube should cover the centre, got {n} px");
    let c = px(&img, 80, 45);
    assert!(c[0] > 30 && c[3] == 255, "lit cube pixel {c:?}");
    // A 3D plane rotated 90° about Y is edge-on: nearly invisible.
    let mut plane = solid_layer(&comp, [1.0, 1.0, 1.0, 1.0], 0.0);
    plane.is_3d = true;
    plane.transform.rotation.value = [0.0, 90.0, 0.0];
    p.compositions[0].layers = vec![plane];
    assert!(alpha_count(&render(&p, 0.0)) < 200);
    // Extruded 3D text produces geometry.
    let mut t = text_layer(&comp, "3D", 0.0);
    t.is_3d = true;
    if let LayerKind::Text(tp) = &mut t.kind {
        tp.extrude = 30.0;
    }
    t.transform.rotation.value = [20.0, 30.0, 0.0];
    p.compositions[0].layers = vec![t];
    assert!(alpha_count(&render(&p, 0.0)) > 100, "extruded text rendered");
}

#[test]
fn transitions_and_adjustment_layer() {
    let mut p = project(50, 50);
    let comp = p.compositions[0].clone();
    let mut l = solid_layer(&comp, [1.0, 1.0, 1.0, 1.0], 0.0);
    l.transition_in = Some(Transition { kind: TransitionKind::CrossDissolve, duration: 1.0, ease: false });
    p.compositions[0].layers = vec![l.clone()];
    let half = render(&p, 0.5);
    let v = px(&half, 25, 25)[0];
    assert!((100..=155).contains(&v), "cross dissolve at 50% over black, got {v}");
    let mut adj = adjustment_layer(&comp, 0.0);
    adj.effects.push(registry::instantiate("invert").unwrap());
    l.transition_in = None;
    p.compositions[0].layers = vec![adj, l];
    assert_eq!(px(&render(&p, 0.5), 25, 25)[0], 0, "adjustment layer inverts everything below");
}
