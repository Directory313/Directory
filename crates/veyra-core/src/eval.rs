//! Evaluation of animated properties (keyframes + expressions), layer transforms,
//! parenting hierarchies and camera matrices.
//!
//! Coordinate system: x right, y down, z into the screen (After Effects convention).
//! 2D layers are placed in composition pixels; 3D layers are viewed through the active
//! camera (or a default camera that maps z = 0 to 1:1 pixels).

use crate::anim::*;
use crate::expr::{self, ExprEnv, ExprHost};
use crate::model::*;
use glam::{DMat4, DVec3, DVec4};
use std::collections::HashMap;
use std::sync::Mutex;

/// Per-composition evaluation context.
pub struct EvalCtx<'a> {
    pub project: &'a Project,
    pub comp: &'a Composition,
    /// Composition time in seconds.
    pub time: f64,
}

struct PropHost<'a, T> {
    prop: &'a Prop<T>,
    ctx: &'a EvalCtx<'a>,
    layer: &'a Layer,
}

impl<T: Lerp + Components> ExprHost for PropHost<'_, T> {
    fn value_at(&self, t: f64) -> Vec<f64> {
        self.prop.at(t).to_components()
    }
    fn key_range(&self) -> Option<(f64, f64)> {
        Some((self.prop.keys.first()?.t, self.prop.keys.last()?.t))
    }
    fn layer_prop(&self, name: &str, prop: &str, t_local: f64) -> Option<Vec<f64>> {
        let comp_t = t_local + self.layer.start;
        let l = self.ctx.comp.layers.iter().find(|l| l.name == name || l.id == name)?;
        let lt = comp_t - l.start;
        let tr = &l.transform;
        Some(match prop {
            "position" => tr.position.at(lt).to_vec(),
            "scale" => tr.scale.at(lt).to_vec(),
            "rotation" => tr.rotation.at(lt).to_vec(),
            "anchor" | "anchorPoint" => tr.anchor.at(lt).to_vec(),
            "opacity" => vec![tr.opacity.at(lt)],
            "volume" => vec![l.audio.volume.at(lt)],
            _ => return None,
        })
    }
}

thread_local! {
    static EXPR_CACHE: std::cell::RefCell<HashMap<String, Result<expr::Program, String>>> = std::cell::RefCell::new(HashMap::new());
}

/// Errors from expressions are collected here so the UI can show them without failing a render.
pub static EXPR_ERRORS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn seed_for(layer: &Layer, salt: &str) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for b in layer.id.bytes().chain(salt.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

impl<'a> EvalCtx<'a> {
    pub fn new(project: &'a Project, comp: &'a Composition, time: f64) -> Self {
        Self { project, comp, time }
    }

    /// Evaluate any numeric property on a layer at the current comp time.
    pub fn prop<T: Lerp + Components>(&self, layer: &Layer, prop: &Prop<T>, salt: &str) -> T {
        self.prop_at(layer, prop, salt, self.time)
    }

    pub fn prop_at<T: Lerp + Components>(&self, layer: &Layer, prop: &Prop<T>, salt: &str, comp_t: f64) -> T {
        let local = comp_t - layer.start;
        let base = prop.at(local);
        let Some(src) = prop.expr.as_deref().filter(|s| !s.trim().is_empty()) else { return base };
        let host = PropHost { prop, ctx: self, layer };
        let index = self.comp.layers.iter().position(|l| l.id == layer.id).unwrap_or(0) as f64 + 1.0;
        let env = ExprEnv {
            time: local,
            value: base.to_components(),
            fps: self.comp.fps,
            index,
            duration: layer.duration,
            comp_width: self.comp.width as f64,
            comp_height: self.comp.height as f64,
            seed: seed_for(layer, salt),
            host: &host,
        };
        let res = EXPR_CACHE.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() > 512 {
                c.clear();
            }
            let prog = c.entry(src.to_string()).or_insert_with(|| expr::parse(src)).clone();
            prog.and_then(|p| expr::run(&p, &env))
        });
        match res {
            Ok(v) => T::from_components(&v, &base),
            Err(e) => {
                if let Ok(mut errs) = EXPR_ERRORS.lock() {
                    let key = format!("{}:{}", layer.id, salt);
                    if !errs.iter().any(|(k, _)| *k == key) && errs.len() < 64 {
                        errs.push((key, e));
                    }
                }
                base
            }
        }
    }

    /// Evaluate a generic (non-Components) property — keyframes only.
    pub fn plain<T: Lerp>(&self, layer: &Layer, prop: &Prop<T>) -> T {
        prop.at(self.time - layer.start)
    }

    pub fn param(&self, layer: &Layer, effect: &Effect, key: &str) -> Option<ParamValue> {
        effect.params.get(key).map(|p| self.prop(layer, p, &format!("{}.{}", effect.id, key)))
    }
}

/// Evaluated transform of a layer.
#[derive(Clone, Copy, Debug)]
pub struct EvalTransform {
    pub anchor: DVec3,
    pub position: DVec3,
    pub scale: DVec3,
    pub rotation: DVec3,
    pub opacity: f64,
}

pub fn eval_transform(ctx: &EvalCtx, layer: &Layer, t: f64) -> EvalTransform {
    let tr = &layer.transform;
    let a = ctx.prop_at(layer, &tr.anchor, "anchor", t);
    let p = ctx.prop_at(layer, &tr.position, "position", t);
    let s = ctx.prop_at(layer, &tr.scale, "scale", t);
    let r = ctx.prop_at(layer, &tr.rotation, "rotation", t);
    let o = ctx.prop_at(layer, &tr.opacity, "opacity", t);
    EvalTransform {
        anchor: DVec3::from_array(a),
        position: DVec3::from_array(p),
        scale: DVec3::from_array(s) / 100.0,
        rotation: DVec3::from_array(r),
        opacity: (o / 100.0).clamp(0.0, 1.0),
    }
}

impl EvalTransform {
    /// Local matrix: T(position) · Rz · Ry · Rx · S · T(-anchor).
    /// For 2D layers z components are ignored.
    pub fn matrix(&self, is_3d: bool) -> DMat4 {
        if is_3d {
            DMat4::from_translation(self.position)
                * DMat4::from_rotation_z(self.rotation.z.to_radians())
                * DMat4::from_rotation_y(self.rotation.y.to_radians())
                * DMat4::from_rotation_x(self.rotation.x.to_radians())
                * DMat4::from_scale(self.scale)
                * DMat4::from_translation(-self.anchor)
        } else {
            let p = DVec3::new(self.position.x, self.position.y, 0.0);
            let a = DVec3::new(self.anchor.x, self.anchor.y, 0.0);
            DMat4::from_translation(p)
                * DMat4::from_rotation_z(self.rotation.z.to_radians())
                * DMat4::from_scale(DVec3::new(self.scale.x, self.scale.y, 1.0))
                * DMat4::from_translation(-a)
        }
    }
}

/// World matrix of a layer including the parent chain. Cycles are broken defensively.
pub fn world_matrix(ctx: &EvalCtx, layer: &Layer, t: f64) -> DMat4 {
    let mut m = eval_transform(ctx, layer, t).matrix(layer.is_3d);
    let mut cur = layer;
    let mut guard = 0;
    while let Some(pid) = &cur.parent {
        guard += 1;
        if guard > 64 {
            break;
        }
        let Some(parent) = ctx.comp.layer(pid) else { break };
        let pm = eval_transform(ctx, parent, t).matrix(parent.is_3d || layer.is_3d);
        m = pm * m;
        cur = parent;
    }
    m
}

/// Would setting `child.parent = parent` create a cycle?
pub fn would_cycle(comp: &Composition, child: &str, parent: &str) -> bool {
    let mut cur = Some(parent.to_string());
    let mut guard = 0;
    while let Some(id) = cur {
        if id == child {
            return true;
        }
        guard += 1;
        if guard > 256 {
            return true;
        }
        cur = comp.layer(&id).and_then(|l| l.parent.clone());
    }
    false
}

/// Bake a layer's world transform into local values that, applied without a parent,
/// reproduce the same placement. Used when un-parenting so the object stays in place.
pub fn decompose_world(ctx: &EvalCtx, layer: &Layer, t: f64) -> (DVec3, DVec3, DVec3) {
    let m = world_matrix(ctx, layer, t);
    let a = DVec3::from_array(layer.transform.anchor.at(t - layer.start));
    let (scale, rot, _trans) = m.to_scale_rotation_translation();
    let pos = m.transform_point3(a);
    let (rz, ry, rx) = rot.to_euler(glam::EulerRot::ZYX);
    (pos, scale * 100.0, DVec3::new(rx.to_degrees(), ry.to_degrees(), rz.to_degrees()))
}

/// Camera view + projection matrices for 3D layers. Output clip space is wgpu's (z 0..1).
#[derive(Clone, Copy, Debug)]
pub struct CameraEval {
    pub view: DMat4,
    pub proj: DMat4,
    pub position: DVec3,
    pub zoom: f64,
    pub dof: Option<(f64, f64)>,
    pub ortho: bool,
}

pub fn default_zoom(comp: &Composition) -> f64 {
    // AE's default 50mm-equivalent camera for a comp of this width.
    comp.width as f64 * 1.3889
}

pub fn eval_camera(ctx: &EvalCtx) -> CameraEval {
    let (w, h) = (ctx.comp.width as f64, ctx.comp.height as f64);
    let t = ctx.time;
    let (position, view, zoom, near, far, dof, ortho) = match ctx.comp.active_camera(t) {
        Some(layer) => {
            let LayerKind::Camera(cam) = &layer.kind else { unreachable!() };
            let zoom = ctx.prop(layer, &cam.zoom, "zoom").max(1.0);
            let world = if cam.use_point_of_interest {
                let tr = eval_transform(ctx, layer, t);
                let poi = DVec3::from_array(ctx.prop(layer, &cam.point_of_interest, "poi"));
                let mut pos = tr.position;
                // Parent chain affects the camera position.
                if layer.parent.is_some() {
                    let wm = world_matrix(ctx, layer, t);
                    pos = wm.transform_point3(tr.anchor);
                }
                look_at_world(pos, poi) * DMat4::from_rotation_z(tr.rotation.z.to_radians())
            } else {
                let wm = world_matrix(ctx, layer, t);
                let tr = eval_transform(ctx, layer, t);
                wm * DMat4::from_translation(tr.anchor)
            };
            let dof = cam.depth_of_field.then(|| (ctx.prop(layer, &cam.focus_distance, "focus"), ctx.prop(layer, &cam.aperture, "aperture")));
            (world.w_axis.truncate(), world.inverse(), zoom, cam.near.max(0.1), cam.far.max(cam.near + 1.0), dof, cam.projection == Projection::Orthographic)
        }
        None => {
            let zoom = default_zoom(ctx.comp);
            let pos = DVec3::new(w / 2.0, h / 2.0, -zoom);
            let world = DMat4::from_translation(pos);
            (pos, world.inverse(), zoom, 1.0, 100000.0, None, false)
        }
    };
    let proj = if ortho {
        // Orthographic: 1 px at any depth = 1 px on screen.
        DMat4::from_cols(
            DVec4::new(2.0 / w, 0.0, 0.0, 0.0),
            DVec4::new(0.0, -2.0 / h, 0.0, 0.0),
            DVec4::new(0.0, 0.0, 1.0 / (far - near), 0.0),
            DVec4::new(0.0, 0.0, -near / (far - near), 1.0),
        )
    } else {
        // Perspective with y down, z forward; maps camera-space (x, y, z) to
        // ndc x = x*zoom/z/(w/2), y = -y*zoom/z/(h/2), depth = far(z-near)/((far-near)z).
        let fz = far / (far - near);
        DMat4::from_cols(
            DVec4::new(zoom / (w / 2.0), 0.0, 0.0, 0.0),
            DVec4::new(0.0, -zoom / (h / 2.0), 0.0, 0.0),
            DVec4::new(0.0, 0.0, fz, 1.0),
            DVec4::new(0.0, 0.0, -near * fz, 0.0),
        )
    };
    CameraEval { view, proj, position, zoom, dof, ortho }
}

/// World matrix of an object at `eye` looking at `target` (z forward, y down).
pub fn look_at_world(eye: DVec3, target: DVec3) -> DMat4 {
    let f = (target - eye).try_normalize().unwrap_or(DVec3::Z);
    let up = if f.y.abs() > 0.999 { DVec3::Z } else { DVec3::NEG_Y };
    let r = up.cross(f).normalize() * -1.0;
    let r = if r.is_nan() { DVec3::X } else { r };
    let d = f.cross(r).normalize();
    DMat4::from_cols(r.extend(0.0), d.extend(0.0), f.extend(0.0), eye.extend(1.0))
}

/// Projection for 2D layers: composition pixels -> clip space.
pub fn ortho_2d(w: f64, h: f64) -> DMat4 {
    DMat4::from_cols(
        DVec4::new(2.0 / w, 0.0, 0.0, 0.0),
        DVec4::new(0.0, -2.0 / h, 0.0, 0.0),
        DVec4::new(0.0, 0.0, 1.0, 0.0),
        DVec4::new(-1.0, 1.0, 0.5, 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer_at(x: f64, y: f64) -> Layer {
        Layer {
            id: new_id(),
            name: "L".into(),
            kind: LayerKind::Null,
            start: 0.0,
            duration: 10.0,
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
            transform: Transform::centered(100.0, 100.0, x, y),
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

    #[test]
    fn anchor_maps_to_position() {
        let mut p = Project::new("t");
        let l = layer_at(960.0, 540.0);
        p.compositions[0].layers.push(l.clone());
        let comp = &p.compositions[0];
        let ctx = EvalCtx::new(&p, comp, 0.0);
        let m = world_matrix(&ctx, &l, 0.0);
        let c = m.transform_point3(DVec3::new(50.0, 50.0, 0.0));
        assert!((c - DVec3::new(960.0, 540.0, 0.0)).length() < 1e-9);
    }

    #[test]
    fn parenting_inherits_transform() {
        let mut p = Project::new("t");
        let mut parent = layer_at(100.0, 100.0);
        parent.transform.rotation.value = [0.0, 0.0, 90.0];
        let mut child = layer_at(150.0, 50.0); // offset (100, 0) from parent anchor (50,50)
        child.parent = Some(parent.id.clone());
        p.compositions[0].layers = vec![child.clone(), parent.clone()];
        let comp = &p.compositions[0];
        let ctx = EvalCtx::new(&p, comp, 0.0);
        let m = world_matrix(&ctx, &child, 0.0);
        let c = m.transform_point3(DVec3::new(50.0, 50.0, 0.0));
        // child centre is at parent-local (150,50); parent rotates 90° about its anchor (50,50)
        // -> local offset (100,0) becomes (0,100); world = (100,100) + (0,100)
        assert!((c - DVec3::new(100.0, 200.0, 0.0)).length() < 1e-6, "{c:?}");
        assert!(would_cycle(comp, &parent.id, &child.id));
        assert!(!would_cycle(comp, &child.id, &parent.id));
    }

    #[test]
    fn default_camera_maps_z0_to_pixels() {
        let p = Project::new("t");
        let comp = &p.compositions[0];
        let ctx = EvalCtx::new(&p, comp, 0.0);
        let cam = eval_camera(&ctx);
        let vp = cam.proj * cam.view;
        let pt = vp * DVec4::new(1920.0, 0.0, 0.0, 1.0);
        let ndc = pt.truncate() / pt.w;
        assert!((ndc.x - 1.0).abs() < 1e-6 && (ndc.y - 1.0).abs() < 1e-6, "{ndc:?}");
        let o = ortho_2d(1920.0, 1080.0) * DVec4::new(0.0, 1080.0, 0.0, 1.0);
        assert!((o.x + 1.0).abs() < 1e-9 && (o.y + 1.0).abs() < 1e-9);
    }

    #[test]
    fn expression_drives_property() {
        let mut p = Project::new("t");
        let mut l = layer_at(0.0, 0.0);
        l.transform.opacity.expr = Some("time * 10".into());
        p.compositions[0].layers.push(l.clone());
        let comp = &p.compositions[0];
        let ctx = EvalCtx::new(&p, comp, 5.0);
        assert_eq!(eval_transform(&ctx, &l, 5.0).opacity, 0.5);
    }

    #[test]
    fn source_time_mapping() {
        let mut l = layer_at(0.0, 0.0);
        l.start = 2.0;
        l.source_in = 1.0;
        l.speed = 2.0;
        assert_eq!(l.source_time(3.0), 3.0);
        l.reverse = true;
        l.duration = 4.0;
        assert_eq!(l.source_time(2.0), 9.0);
        l.freeze_at = Some(4.5);
        assert_eq!(l.source_time(5.0), 4.5);
    }
}
