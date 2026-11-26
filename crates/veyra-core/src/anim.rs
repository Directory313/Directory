//! Universal property & keyframe engine.
//!
//! Every animatable value in VEYRA is a [`Prop<T>`]: a static value, an optional list of
//! keyframes and an optional expression. Keyframe times are *layer-local* seconds, so moving
//! a layer in time moves its animation with it.

use serde::{Deserialize, Serialize};

pub type Vec2 = [f64; 2];
pub type Vec3 = [f64; 3];
/// Straight (non-premultiplied) RGBA, 0..1.
pub type Color = [f64; 4];

/// How the segment *leaving* a keyframe is interpolated.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Interp {
    #[default]
    Linear,
    Hold,
    Bezier,
}

/// A normalised cubic-bezier control point inside a segment (x = time 0..1, y = progress).
/// `y` may leave 0..1 to produce overshoot.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Handle {
    pub x: f64,
    pub y: f64,
}

pub const HANDLE_OUT_LINEAR: Handle = Handle { x: 1.0 / 3.0, y: 1.0 / 3.0 };
pub const HANDLE_IN_LINEAR: Handle = Handle { x: 2.0 / 3.0, y: 2.0 / 3.0 };

fn default_out() -> Handle {
    HANDLE_OUT_LINEAR
}
fn default_in() -> Handle {
    HANDLE_IN_LINEAR
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe<T> {
    pub t: f64,
    pub v: T,
    #[serde(default)]
    pub interp: Interp,
    /// Outgoing handle (used by the segment that starts at this key).
    #[serde(default = "default_out")]
    pub out_h: Handle,
    /// Incoming handle (used by the segment that ends at this key).
    #[serde(default = "default_in")]
    pub in_h: Handle,
}

impl<T> Keyframe<T> {
    pub fn new(t: f64, v: T) -> Self {
        Self { t, v, interp: Interp::Linear, out_h: HANDLE_OUT_LINEAR, in_h: HANDLE_IN_LINEAR }
    }
    pub fn eased(t: f64, v: T) -> Self {
        Self { t, v, interp: Interp::Bezier, out_h: Handle { x: 0.33, y: 0.0 }, in_h: Handle { x: 0.67, y: 1.0 } }
    }
}

/// Values that can be interpolated between keyframes.
pub trait Lerp: Clone {
    fn lerp(a: &Self, b: &Self, t: f64) -> Self;
}

impl Lerp for f64 {
    fn lerp(a: &f64, b: &f64, t: f64) -> f64 {
        a + (b - a) * t
    }
}
impl<const N: usize> Lerp for [f64; N] {
    fn lerp(a: &Self, b: &Self, t: f64) -> Self {
        let mut o = *a;
        for i in 0..N {
            o[i] = a[i] + (b[i] - a[i]) * t;
        }
        o
    }
}
impl Lerp for bool {
    fn lerp(a: &bool, b: &bool, t: f64) -> bool {
        if t < 1.0 { *a } else { *b }
    }
}
impl Lerp for String {
    fn lerp(a: &String, b: &String, t: f64) -> String {
        if t < 1.0 { a.clone() } else { b.clone() }
    }
}

/// Numeric view of a value, used by expressions and the graph editor.
pub trait Components: Sized {
    fn to_components(&self) -> Vec<f64>;
    fn from_components(c: &[f64], fallback: &Self) -> Self;
}
impl Components for f64 {
    fn to_components(&self) -> Vec<f64> {
        vec![*self]
    }
    fn from_components(c: &[f64], fb: &Self) -> Self {
        c.first().copied().filter(|v| v.is_finite()).unwrap_or(*fb)
    }
}
impl<const N: usize> Components for [f64; N] {
    fn to_components(&self) -> Vec<f64> {
        self.to_vec()
    }
    fn from_components(c: &[f64], fb: &Self) -> Self {
        let mut o = *fb;
        for i in 0..N {
            if let Some(v) = c.get(i).copied().filter(|v| v.is_finite()) {
                o[i] = v;
            } else if c.len() == 1 && c[0].is_finite() {
                o[i] = c[0];
            }
        }
        o
    }
}

/// An animatable property.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prop<T> {
    pub value: T,
    #[serde(default = "Vec::new", skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<Keyframe<T>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
}

impl<T> Prop<T> {
    pub fn new(value: T) -> Self {
        Self { value, keys: Vec::new(), expr: None }
    }
    pub fn is_animated(&self) -> bool {
        !self.keys.is_empty() || self.expr.is_some()
    }
}

impl<T: Default> Default for Prop<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

/// Solve a CSS-style cubic bezier (0,0)-(p1)-(p2)-(1,1) for y given x.
pub fn cubic_bezier_ease(p1: Handle, p2: Handle, x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let (x1, x2) = (p1.x.clamp(0.0, 1.0), p2.x.clamp(0.0, 1.0));
    let bx = |s: f64| 3.0 * (1.0 - s) * (1.0 - s) * s * x1 + 3.0 * (1.0 - s) * s * s * x2 + s * s * s;
    let by = |s: f64| 3.0 * (1.0 - s) * (1.0 - s) * s * p1.y + 3.0 * (1.0 - s) * s * s * p2.y + s * s * s;
    let dbx = |s: f64| 3.0 * (1.0 - s) * (1.0 - s) * x1 + 6.0 * (1.0 - s) * s * (x2 - x1) + 3.0 * s * s * (1.0 - x2);
    // Newton iterations, then bisection fallback.
    let mut s = x;
    for _ in 0..8 {
        let err = bx(s) - x;
        if err.abs() < 1e-7 {
            return by(s);
        }
        let d = dbx(s);
        if d.abs() < 1e-6 {
            break;
        }
        s = (s - err / d).clamp(0.0, 1.0);
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    s = x;
    for _ in 0..40 {
        let v = bx(s);
        if (v - x).abs() < 1e-7 {
            break;
        }
        if v < x { lo = s } else { hi = s }
        s = 0.5 * (lo + hi);
    }
    by(s)
}

/// Evaluate keyframes at time `t` (no expression).
pub fn eval_keys<T: Lerp>(keys: &[Keyframe<T>], fallback: &T, t: f64) -> T {
    match keys.len() {
        0 => return fallback.clone(),
        1 => return keys[0].v.clone(),
        _ => {}
    }
    if t <= keys[0].t {
        return keys[0].v.clone();
    }
    let last = keys.len() - 1;
    if t >= keys[last].t {
        return keys[last].v.clone();
    }
    // Binary search for the segment.
    let i = match keys.binary_search_by(|k| k.t.partial_cmp(&t).unwrap_or(std::cmp::Ordering::Less)) {
        Ok(i) => return keys[i].v.clone(),
        Err(i) => i - 1,
    };
    let (a, b) = (&keys[i], &keys[i + 1]);
    let span = (b.t - a.t).max(1e-12);
    let x = (t - a.t) / span;
    let p = match a.interp {
        Interp::Hold => 0.0,
        Interp::Linear => x,
        Interp::Bezier => cubic_bezier_ease(a.out_h, b.in_h, x),
    };
    T::lerp(&a.v, &b.v, p)
}

impl<T: Lerp> Prop<T> {
    /// Keyframe-only evaluation (expressions are applied by [`crate::expr`]).
    pub fn at(&self, t: f64) -> T {
        eval_keys(&self.keys, &self.value, t)
    }

    /// Insert or replace a keyframe at `t` keeping keys sorted.
    pub fn set_key(&mut self, t: f64, v: T) {
        match self.keys.iter().position(|k| (k.t - t).abs() < 1e-6) {
            Some(i) => self.keys[i].v = v,
            None => {
                let k = Keyframe::new(t, v);
                let pos = self.keys.iter().position(|k| k.t > t).unwrap_or(self.keys.len());
                self.keys.insert(pos, k);
            }
        }
    }

    pub fn sort_keys(&mut self) {
        self.keys.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    }
}

/// Generic effect/shape parameter value. Colours and vectors are `Vec`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Num(f64),
    Vec(Vec<f64>),
    Str(String),
}

impl ParamValue {
    pub fn num(&self) -> f64 {
        match self {
            ParamValue::Num(v) => *v,
            ParamValue::Bool(b) => *b as i32 as f64,
            ParamValue::Vec(v) => v.first().copied().unwrap_or(0.0),
            ParamValue::Str(s) => s.parse().unwrap_or(0.0),
        }
    }
    pub fn boolean(&self) -> bool {
        match self {
            ParamValue::Bool(b) => *b,
            other => other.num() != 0.0,
        }
    }
    pub fn vec(&self) -> Vec<f64> {
        match self {
            ParamValue::Vec(v) => v.clone(),
            ParamValue::Num(v) => vec![*v],
            ParamValue::Bool(b) => vec![*b as i32 as f64],
            ParamValue::Str(_) => vec![],
        }
    }
    pub fn str(&self) -> &str {
        match self {
            ParamValue::Str(s) => s,
            _ => "",
        }
    }
}

impl Lerp for ParamValue {
    fn lerp(a: &Self, b: &Self, t: f64) -> Self {
        match (a, b) {
            (ParamValue::Num(x), ParamValue::Num(y)) => ParamValue::Num(x + (y - x) * t),
            (ParamValue::Vec(x), ParamValue::Vec(y)) if x.len() == y.len() => {
                ParamValue::Vec(x.iter().zip(y).map(|(p, q)| p + (q - p) * t).collect())
            }
            _ => {
                if t < 1.0 { a.clone() } else { b.clone() }
            }
        }
    }
}

impl Components for ParamValue {
    fn to_components(&self) -> Vec<f64> {
        self.vec()
    }
    fn from_components(c: &[f64], fb: &Self) -> Self {
        match fb {
            ParamValue::Num(_) => ParamValue::Num(f64::from_components(c, &fb.num())),
            ParamValue::Vec(v) => {
                let mut o = v.clone();
                for (i, x) in o.iter_mut().enumerate() {
                    if let Some(n) = c.get(i).filter(|n| n.is_finite()) {
                        *x = *n;
                    }
                }
                ParamValue::Vec(o)
            }
            ParamValue::Bool(_) => ParamValue::Bool(c.first().map(|v| *v != 0.0).unwrap_or(fb.boolean())),
            ParamValue::Str(_) => fb.clone(),
        }
    }
}

/// A bezier path vertex: point plus in/out tangents (relative to the point).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct PathVertex {
    pub p: Vec2,
    #[serde(default)]
    pub i: Vec2,
    #[serde(default)]
    pub o: Vec2,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BezPath {
    pub vertices: Vec<PathVertex>,
    pub closed: bool,
}

impl Lerp for BezPath {
    /// Vertex-wise morph. Paths with different vertex counts are resampled by
    /// duplicating the last vertex of the shorter path so the morph stays continuous.
    fn lerp(a: &Self, b: &Self, t: f64) -> Self {
        if a.vertices.is_empty() || b.vertices.is_empty() {
            return if t < 1.0 { a.clone() } else { b.clone() };
        }
        let n = a.vertices.len().max(b.vertices.len());
        let get = |p: &BezPath, i: usize| p.vertices[i.min(p.vertices.len() - 1)].clone();
        let vertices = (0..n)
            .map(|i| {
                let (va, vb) = (get(a, i), get(b, i));
                PathVertex { p: Lerp::lerp(&va.p, &vb.p, t), i: Lerp::lerp(&va.i, &vb.i, t), o: Lerp::lerp(&va.o, &vb.o, t) }
            })
            .collect();
        BezPath { vertices, closed: if t < 0.5 { a.closed } else { b.closed } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_interpolation() {
        let mut p = Prop::new(0.0);
        p.set_key(0.0, 0.0);
        p.set_key(2.0, 100.0);
        assert_eq!(p.at(-1.0), 0.0);
        assert!((p.at(1.0) - 50.0).abs() < 1e-9);
        assert_eq!(p.at(5.0), 100.0);
    }

    #[test]
    fn hold_interpolation() {
        let mut p = Prop::new(0.0);
        p.set_key(0.0, 1.0);
        p.set_key(1.0, 9.0);
        p.keys[0].interp = Interp::Hold;
        assert_eq!(p.at(0.99), 1.0);
        assert_eq!(p.at(1.0), 9.0);
    }

    #[test]
    fn bezier_ease_is_monotonic_and_symmetric() {
        let p1 = Handle { x: 0.42, y: 0.0 };
        let p2 = Handle { x: 0.58, y: 1.0 };
        assert!((cubic_bezier_ease(p1, p2, 0.5) - 0.5).abs() < 1e-4);
        let mut last = 0.0;
        for i in 0..=100 {
            let v = cubic_bezier_ease(p1, p2, i as f64 / 100.0);
            assert!(v + 1e-9 >= last);
            last = v;
        }
        assert!(cubic_bezier_ease(p1, p2, 0.1) < 0.1);
    }

    #[test]
    fn keys_inserted_sorted_and_replaced() {
        let mut p = Prop::new([0.0, 0.0]);
        p.set_key(2.0, [2.0, 2.0]);
        p.set_key(0.0, [0.0, 0.0]);
        p.set_key(1.0, [5.0, 5.0]);
        p.set_key(1.0, [1.0, 1.0]);
        assert_eq!(p.keys.len(), 3);
        assert_eq!(p.keys.iter().map(|k| k.t).collect::<Vec<_>>(), vec![0.0, 1.0, 2.0]);
        assert_eq!(p.at(1.5), [1.5, 1.5]);
    }

    #[test]
    fn param_value_lerp() {
        let a = ParamValue::Vec(vec![0.0, 0.0, 0.0, 1.0]);
        let b = ParamValue::Vec(vec![1.0, 1.0, 1.0, 1.0]);
        assert_eq!(ParamValue::lerp(&a, &b, 0.5), ParamValue::Vec(vec![0.5, 0.5, 0.5, 1.0]));
        assert_eq!(ParamValue::lerp(&ParamValue::Str("a".into()), &ParamValue::Str("b".into()), 0.5), ParamValue::Str("a".into()));
    }

    #[test]
    fn path_morph_handles_different_counts() {
        let a = BezPath { vertices: vec![PathVertex { p: [0.0, 0.0], ..Default::default() }; 3], closed: true };
        let b = BezPath { vertices: vec![PathVertex { p: [10.0, 10.0], ..Default::default() }; 4], closed: true };
        let m = BezPath::lerp(&a, &b, 0.5);
        assert_eq!(m.vertices.len(), 4);
        assert_eq!(m.vertices[3].p, [5.0, 5.0]);
    }
}
