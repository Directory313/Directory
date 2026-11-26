//! Structural edit operations that are easier to get right in Rust than in the UI:
//! compound clips (pre-compose / unpack), splitting, ripple delete and cache keys.

use crate::model::*;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// Move `layer_ids` of `comp_id` into a new composition and replace them with one compound
/// clip layer. Timing, parenting among the moved layers, and all animation are preserved:
/// the new comp starts at the earliest moved layer, so inner layer times are shifted.
pub fn make_compound(p: &mut Project, comp_id: &str, layer_ids: &[Id], name: &str) -> Result<Id, String> {
    let comp = p.comp(comp_id).ok_or("composition not found")?.clone();
    let ids: HashSet<&str> = layer_ids.iter().map(|s| s.as_str()).collect();
    let moved: Vec<Layer> = comp.layers.iter().filter(|l| ids.contains(l.id.as_str())).cloned().collect();
    if moved.is_empty() {
        return Err("select at least one layer".into());
    }
    let t0 = moved.iter().map(|l| l.start).fold(f64::INFINITY, f64::min);
    let t1 = moved.iter().map(|l| l.end()).fold(f64::NEG_INFINITY, f64::max);
    let mut inner = Composition::new(name, comp.width, comp.height, comp.fps, (t1 - t0).max(1.0 / comp.fps));
    inner.background = comp.background;
    inner.transparent = true;
    inner.layers = moved
        .into_iter()
        .map(|mut l| {
            l.start -= t0;
            if l.parent.as_deref().is_some_and(|pid| !ids.contains(pid)) {
                l.parent = None;
            }
            l
        })
        .collect();
    let first_idx = comp.layers.iter().position(|l| ids.contains(l.id.as_str())).unwrap_or(0);
    let mut layer = crate::factory::comp_layer(&comp, &inner, t0);
    if let LayerKind::Comp { compound, .. } = &mut layer.kind {
        *compound = true;
    }
    layer.name = name.to_string();
    let new_id = layer.id.clone();
    let inner_id = inner.id.clone();
    p.compositions.push(inner);
    let c = p.comp_mut(comp_id).unwrap();
    c.layers.retain(|l| !ids.contains(l.id.as_str()));
    // Layers outside the compound that were parented to moved layers lose that parent.
    for l in &mut c.layers {
        if l.parent.as_deref().is_some_and(|pid| ids.contains(pid)) {
            l.parent = None;
        }
    }
    c.layers.insert(first_idx.min(c.layers.len()), layer);
    let _ = inner_id;
    Ok(new_id)
}

/// Replace a compound clip layer with its contents (re-timed into the parent comp).
/// The compound's own transform/effects are dropped only if they are identity; otherwise
/// the inner layers are parented to a new null that carries the compound's transform.
pub fn unpack_compound(p: &mut Project, comp_id: &str, layer_id: &str) -> Result<Vec<Id>, String> {
    let comp = p.comp(comp_id).ok_or("composition not found")?;
    let idx = comp.layers.iter().position(|l| l.id == layer_id).ok_or("layer not found")?;
    let outer = comp.layers[idx].clone();
    let LayerKind::Comp { comp: inner_id, .. } = &outer.kind else { return Err("not a compound clip".into()) };
    let inner = p.comp(inner_id).ok_or("nested composition missing")?.clone();
    let offset = outer.start - outer.source_in;
    let mut out: Vec<Layer> = Vec::new();
    let has_transform = outer.transform.position.is_animated()
        || outer.transform.scale.is_animated()
        || outer.transform.rotation.is_animated()
        || outer.transform.scale.value != [100.0, 100.0, 100.0]
        || outer.transform.rotation.value != [0.0, 0.0, 0.0]
        || outer.transform.position.value[0] != comp.width as f64 / 2.0
        || outer.transform.position.value[1] != comp.height as f64 / 2.0;
    let mut null_id = None;
    if has_transform {
        let mut n = crate::factory::null_layer(comp, outer.start);
        n.name = format!("{} Controller", outer.name);
        n.duration = outer.duration;
        n.transform = outer.transform.clone();
        n.transform.anchor.value = [inner.width as f64 / 2.0, inner.height as f64 / 2.0, 0.0];
        null_id = Some(n.id.clone());
        out.push(n);
    }
    for mut l in inner.layers.clone() {
        l.start += offset;
        // Clip to the compound's visible range.
        let (a, b) = (outer.start, outer.end());
        if l.end() <= a || l.start >= b {
            continue;
        }
        if l.start < a {
            let cut = a - l.start;
            l.source_in += cut * l.speed;
            l.start = a;
            l.duration -= cut;
        }
        if l.end() > b {
            l.duration = b - l.start;
        }
        if l.parent.is_none() {
            l.parent = null_id.clone();
        }
        out.push(l);
    }
    let ids = out.iter().map(|l| l.id.clone()).collect();
    let c = p.comp_mut(comp_id).unwrap();
    c.layers.remove(idx);
    for (i, l) in out.into_iter().enumerate() {
        c.layers.insert(idx + i, l);
    }
    // Remove the inner comp if nothing else references it.
    let still_used = p.compositions.iter().any(|c| c.layers.iter().any(|l| matches!(&l.kind, LayerKind::Comp { comp, .. } if comp == &inner.id)));
    if !still_used && p.active_comp != inner.id {
        p.compositions.retain(|c| c.id != inner.id);
    }
    Ok(ids)
}

/// Split a layer at composition time `t`. Returns the id of the new right-hand layer.
pub fn split_layer(c: &mut Composition, layer_id: &str, t: f64) -> Option<Id> {
    let idx = c.layers.iter().position(|l| l.id == layer_id)?;
    let l = &c.layers[idx];
    if t <= l.start + 1e-6 || t >= l.end() - 1e-6 {
        return None;
    }
    let mut right = l.clone();
    right.id = new_id();
    let cut = t - l.start;
    right.start = t;
    right.duration = l.duration - cut;
    if !l.reverse {
        right.source_in = l.source_in + cut * l.speed;
    }
    // Shift layer-local keyframes so the right half keeps its animation timing.
    shift_layer_keys(&mut right, -cut);
    right.transition_in = None;
    let left = &mut c.layers[idx];
    left.duration = cut;
    if left.reverse {
        left.source_in += right.duration * left.speed;
    }
    left.transition_out = None;
    let rid = right.id.clone();
    c.layers.insert(idx, right);
    Some(rid)
}

/// Shift every keyframe (transform, effects, masks, audio, kind-specific) by `dt` seconds.
pub fn shift_layer_keys(l: &mut Layer, dt: f64) {
    let mut v = serde_json::to_value(&*l).unwrap_or_default();
    fn walk(v: &mut serde_json::Value, dt: f64) {
        match v {
            serde_json::Value::Object(m) => {
                if let Some(serde_json::Value::Array(keys)) = m.get_mut("keys") {
                    for k in keys.iter_mut() {
                        if let Some(t) = k.get("t").and_then(|t| t.as_f64()) {
                            k["t"] = (t + dt).into();
                        }
                    }
                }
                for (_, x) in m.iter_mut() {
                    walk(x, dt);
                }
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(|x| walk(x, dt)),
            _ => {}
        }
    }
    walk(&mut v, dt);
    if let Ok(nl) = serde_json::from_value(v) {
        *l = nl;
    }
}

/// Remove layers and close the gap on their track positions (ripple delete).
pub fn ripple_delete(c: &mut Composition, ids: &[Id]) {
    let mut gaps: Vec<(f64, f64)> = c.layers.iter().filter(|l| ids.contains(&l.id)).map(|l| (l.start, l.duration)).collect();
    gaps.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    c.layers.retain(|l| !ids.contains(&l.id));
    for (start, dur) in gaps {
        for l in &mut c.layers {
            if l.start >= start - 1e-9 {
                l.start -= dur;
            }
        }
    }
}

// ---------------------------------------------------------------- cache keys

fn hash_json<T: serde::Serialize>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(v).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// Hashes used for frame caching. A frame's key combines the comp settings with the hashes
/// of only the layers active at that frame (and everything they depend on), so an edit to
/// one layer invalidates only the frames where that layer appears.
pub struct CacheKeys {
    comp_settings: u64,
    layers: Vec<(f64, f64, u64)>,
    whole: u64,
}

impl CacheKeys {
    pub fn build(p: &Project, comp: &Composition) -> Self {
        let mut s = comp.clone();
        s.layers.clear();
        s.markers.clear();
        let comp_settings = hash_json(&s);
        let layers = comp
            .layers
            .iter()
            .map(|l| {
                let mut h = DefaultHasher::new();
                hash_json(l).hash(&mut h);
                // Dependencies: nested comps (whole), assets (path + proxy flag).
                match &l.kind {
                    LayerKind::Comp { comp, .. } => {
                        if let Some(c) = p.comp(comp) {
                            CacheKeys::build(p, c).whole.hash(&mut h);
                        }
                    }
                    LayerKind::Media { asset } => {
                        if let Some(a) = p.asset(asset) {
                            a.path.hash(&mut h);
                            a.missing.hash(&mut h);
                        }
                    }
                    _ => {}
                }
                // Parent transforms, track mattes and expression references affect this layer;
                // fold in every layer it may reference.
                if l.parent.is_some() || l.track_matte.is_some() || serde_json::to_string(l).map(|s| s.contains("layer(")).unwrap_or(false) {
                    hash_json(&comp.layers).hash(&mut h);
                }
                (l.start, l.end(), h.finish())
            })
            .collect::<Vec<_>>();
        let mut wh = DefaultHasher::new();
        comp_settings.hash(&mut wh);
        for l in &layers {
            l.2.hash(&mut wh);
        }
        Self { comp_settings, layers, whole: wh.finish() }
    }

    pub fn frame_key(&self, t: f64, scale_bits: u64) -> u64 {
        let mut h = DefaultHasher::new();
        self.comp_settings.hash(&mut h);
        scale_bits.hash(&mut h);
        t.to_bits().hash(&mut h);
        for (s, e, lh) in &self.layers {
            // Include layers within one frame of `t` so transitions/motion blur are covered;
            // adjustment and camera layers are included through their own ranges.
            if t >= *s - 0.05 && t < *e + 0.05 {
                lh.hash(&mut h);
            }
        }
        h.finish()
    }

    pub fn whole(&self) -> u64 {
        self.whole
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::factory::*;

    fn comp_with_two() -> Project {
        let mut p = Project::new("t");
        let c = p.compositions[0].clone();
        let mut a = solid_layer(&c, [1.0, 0.0, 0.0, 1.0], 0.0);
        a.duration = 2.0;
        let mut b = text_layer(&c, "B", 3.0);
        b.duration = 2.0;
        b.transform.opacity.set_key(0.5, 0.0);
        b.transform.opacity.set_key(1.0, 100.0);
        p.compositions[0].layers = vec![b, a];
        p
    }

    #[test]
    fn compound_round_trip_preserves_animation() {
        let mut p = comp_with_two();
        let cid = p.compositions[0].id.clone();
        let ids: Vec<Id> = p.compositions[0].layers.iter().map(|l| l.id.clone()).collect();
        let before = p.compositions[0].layers.clone();
        let cl = make_compound(&mut p, &cid, &ids, "Compound 1").unwrap();
        assert_eq!(p.compositions.len(), 2);
        assert_eq!(p.compositions[0].layers.len(), 1);
        crate::io::validate(&p).unwrap();
        unpack_compound(&mut p, &cid, &cl).unwrap();
        assert_eq!(p.compositions.len(), 1);
        let after = &p.compositions[0].layers;
        assert_eq!(after.len(), 2);
        for l in &before {
            let m = after.iter().find(|x| x.id == l.id).unwrap();
            assert!((m.start - l.start).abs() < 1e-9);
            assert_eq!(m.transform.opacity.keys, l.transform.opacity.keys);
        }
    }

    #[test]
    fn split_keeps_source_and_keys() {
        let mut p = comp_with_two();
        let c = &mut p.compositions[0];
        let id = c.layers[0].id.clone();
        let r = split_layer(c, &id, 4.0).unwrap();
        let right = c.layers.iter().find(|l| l.id == r).unwrap();
        assert_eq!(right.start, 4.0);
        assert_eq!(right.source_in, 1.0);
        assert_eq!(right.transform.opacity.keys[0].t, -0.5);
        let left = c.layers.iter().find(|l| l.id == id).unwrap();
        assert_eq!(left.duration, 1.0);
    }

    #[test]
    fn cache_keys_invalidate_locally() {
        let mut p = comp_with_two();
        let k1 = CacheKeys::build(&p, &p.compositions[0]);
        p.compositions[0].layers[0].transform.position.value[0] += 10.0; // text layer at 3..5
        let k2 = CacheKeys::build(&p, &p.compositions[0]);
        assert_eq!(k1.frame_key(1.0, 1), k2.frame_key(1.0, 1), "frame without the edited layer stays cached");
        assert_ne!(k1.frame_key(4.0, 1), k2.frame_key(4.0, 1), "frame with the edited layer is invalidated");
    }

    #[test]
    fn ripple_closes_gap() {
        let mut p = comp_with_two();
        let c = &mut p.compositions[0];
        let a = c.layers[1].id.clone();
        ripple_delete(c, &[a]);
        assert_eq!(c.layers[0].start, 1.0);
    }
}
