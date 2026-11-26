//! Mesh generation: primitives, glTF/GLB/OBJ import and extrusion of 2D outlines.
//! Coordinates are layer-local pixels, y down (so "up" is -y), centred on the origin.

use bytemuck::{Pod, Zeroable};
use resvg::tiny_skia as sk;
use std::f32::consts::{PI, TAU};
use veyra_core::model::MeshPrimitive;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Clone, Default, Debug)]
pub struct MeshData {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

impl MeshData {
    fn v(&mut self, pos: [f32; 3], nrm: [f32; 3], uv: [f32; 2]) -> u32 {
        self.vertices.push(Vertex { pos, nrm, uv });
        (self.vertices.len() - 1) as u32
    }
    fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend_from_slice(&[a, b, c]);
    }
    fn quad(&mut self, a: u32, b: u32, c: u32, d: u32) {
        self.tri(a, b, c);
        self.tri(a, c, d);
    }
    pub fn append(&mut self, o: &MeshData) {
        let base = self.vertices.len() as u32;
        self.vertices.extend_from_slice(&o.vertices);
        self.indices.extend(o.indices.iter().map(|i| i + base));
    }
    /// Recompute flat normals by un-sharing vertices (faceted look).
    pub fn flat(&self) -> MeshData {
        let mut out = MeshData::default();
        for t in self.indices.chunks_exact(3) {
            let (a, b, c) = (self.vertices[t[0] as usize], self.vertices[t[1] as usize], self.vertices[t[2] as usize]);
            let n = normal(a.pos, b.pos, c.pos);
            let i = out.v(a.pos, n, a.uv);
            out.v(b.pos, n, b.uv);
            out.v(c.pos, n, c.uv);
            out.tri(i, i + 1, i + 2);
        }
        out
    }
    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        let mut lo = [f32::MAX; 3];
        let mut hi = [f32::MIN; 3];
        for v in &self.vertices {
            for i in 0..3 {
                lo[i] = lo[i].min(v.pos[i]);
                hi[i] = hi[i].max(v.pos[i]);
            }
        }
        (lo, hi)
    }
}

fn normal(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-12);
    [n[0] / l, n[1] / l, n[2] / l]
}

pub fn cube(s: f32) -> MeshData {
    let h = s / 2.0;
    let mut m = MeshData::default();
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, 1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
    ];
    for (n, u, v) in faces {
        let corner = |a: f32, b: f32| [(n[0] + u[0] * a + v[0] * b) * h, (n[1] + u[1] * a + v[1] * b) * h, (n[2] + u[2] * a + v[2] * b) * h];
        let i0 = m.v(corner(-1.0, -1.0), n, [0.0, 0.0]);
        let i1 = m.v(corner(1.0, -1.0), n, [1.0, 0.0]);
        let i2 = m.v(corner(1.0, 1.0), n, [1.0, 1.0]);
        let i3 = m.v(corner(-1.0, 1.0), n, [0.0, 1.0]);
        m.quad(i0, i1, i2, i3);
    }
    m
}

pub fn sphere(r: f32, seg: u32, rings: u32) -> MeshData {
    let (seg, rings) = (seg.clamp(3, 256), rings.clamp(2, 128));
    let mut m = MeshData::default();
    for y in 0..=rings {
        let v = y as f32 / rings as f32;
        let th = v * PI;
        for x in 0..=seg {
            let u = x as f32 / seg as f32;
            let ph = u * TAU;
            let n = [th.sin() * ph.cos(), -th.cos(), th.sin() * ph.sin()];
            m.v([n[0] * r, n[1] * r, n[2] * r], n, [u, v]);
        }
    }
    let row = seg + 1;
    for y in 0..rings {
        for x in 0..seg {
            let a = y * row + x;
            m.quad(a, a + 1, a + row + 1, a + row);
        }
    }
    m
}

fn lathe(profile: &[(f32, f32)], seg: u32, caps: bool) -> MeshData {
    // profile: (radius, y) pairs from top to bottom.
    let seg = seg.clamp(3, 256);
    let mut m = MeshData::default();
    for (pi, w) in profile.windows(2).enumerate() {
        let ((r0, y0), (r1, y1)) = (w[0], w[1]);
        let slope = (r0 - r1) / (y1 - y0).abs().max(1e-6);
        let base = m.vertices.len() as u32;
        for x in 0..=seg {
            let a = x as f32 / seg as f32 * TAU;
            let (c, s) = (a.cos(), a.sin());
            let nl = (1.0 + slope * slope).sqrt();
            let n = [c / nl, slope / nl * (y1 - y0).signum() * -1.0, s / nl];
            m.v([c * r0, y0, s * r0], n, [x as f32 / seg as f32, pi as f32]);
            m.v([c * r1, y1, s * r1], n, [x as f32 / seg as f32, pi as f32 + 1.0]);
        }
        for x in 0..seg {
            let a = base + x * 2;
            m.quad(a, a + 2, a + 3, a + 1);
        }
    }
    if caps {
        for &(r, y, up) in &[(profile[0].0, profile[0].1, true), (profile[profile.len() - 1].0, profile[profile.len() - 1].1, false)] {
            if r <= 0.0 {
                continue;
            }
            let n = if up { [0.0, -1.0, 0.0] } else { [0.0, 1.0, 0.0] };
            let c = m.v([0.0, y, 0.0], n, [0.5, 0.5]);
            for x in 0..seg {
                let a0 = x as f32 / seg as f32 * TAU;
                let a1 = (x + 1) as f32 / seg as f32 * TAU;
                let p0 = m.v([a0.cos() * r, y, a0.sin() * r], n, [0.5 + a0.cos() / 2.0, 0.5 + a0.sin() / 2.0]);
                let p1 = m.v([a1.cos() * r, y, a1.sin() * r], n, [0.5 + a1.cos() / 2.0, 0.5 + a1.sin() / 2.0]);
                if up { m.tri(c, p0, p1) } else { m.tri(c, p1, p0) }
            }
        }
    }
    m
}

pub fn torus(r: f32, tube: f32, seg: u32, sides: u32) -> MeshData {
    let (seg, sides) = (seg.clamp(3, 512), sides.clamp(3, 128));
    let mut m = MeshData::default();
    for i in 0..=seg {
        let u = i as f32 / seg as f32 * TAU;
        for j in 0..=sides {
            let v = j as f32 / sides as f32 * TAU;
            let n = [v.cos() * u.cos(), v.sin(), v.cos() * u.sin()];
            let p = [(r + tube * v.cos()) * u.cos(), tube * v.sin(), (r + tube * v.cos()) * u.sin()];
            m.v(p, n, [i as f32 / seg as f32, j as f32 / sides as f32]);
        }
    }
    let row = sides + 1;
    for i in 0..seg {
        for j in 0..sides {
            let a = i * row + j;
            m.quad(a, a + row, a + row + 1, a + 1);
        }
    }
    m
}

pub fn plane(w: f32, h: f32, div: u32) -> MeshData {
    let div = div.clamp(1, 256);
    let mut m = MeshData::default();
    for y in 0..=div {
        for x in 0..=div {
            let (u, v) = (x as f32 / div as f32, y as f32 / div as f32);
            m.v([(u - 0.5) * w, (v - 0.5) * h, 0.0], [0.0, 0.0, -1.0], [u, v]);
        }
    }
    let row = div + 1;
    for y in 0..div {
        for x in 0..div {
            let a = y * row + x;
            m.quad(a, a + 1, a + row + 1, a + row);
        }
    }
    m
}

pub fn pyramid(s: f32, h: f32) -> MeshData {
    let hs = s / 2.0;
    let apex = [0.0, -h / 2.0, 0.0];
    let b = [[-hs, h / 2.0, -hs], [hs, h / 2.0, -hs], [hs, h / 2.0, hs], [-hs, h / 2.0, hs]];
    let mut m = MeshData::default();
    for i in 0..4 {
        let (p0, p1) = (b[i], b[(i + 1) % 4]);
        let n = normal(apex, p1, p0);
        let a = m.v(apex, n, [0.5, 0.0]);
        let c = m.v(p1, n, [1.0, 1.0]);
        let d = m.v(p0, n, [0.0, 1.0]);
        m.tri(a, c, d);
    }
    let n = [0.0, 1.0, 0.0];
    let i: Vec<u32> = b.iter().enumerate().map(|(k, p)| m.v(*p, n, [(k % 2) as f32, (k / 2) as f32])).collect();
    m.quad(i[0], i[1], i[2], i[3]);
    m
}

pub fn disc(r: f32, seg: u32) -> MeshData {
    let mut m = MeshData::default();
    let n = [0.0, 0.0, -1.0];
    let c = m.v([0.0, 0.0, 0.0], n, [0.5, 0.5]);
    let seg = seg.clamp(3, 512);
    for i in 0..=seg {
        let a = i as f32 / seg as f32 * TAU;
        m.v([a.cos() * r, a.sin() * r, 0.0], n, [0.5 + a.cos() / 2.0, 0.5 + a.sin() / 2.0]);
    }
    for i in 0..seg {
        m.tri(c, c + 1 + i, c + 2 + i);
    }
    m
}

pub fn primitive(p: &MeshPrimitive) -> MeshData {
    match p {
        MeshPrimitive::Cube { size } => cube(*size as f32),
        MeshPrimitive::Sphere { radius, segments, rings } => sphere(*radius as f32, *segments, *rings),
        MeshPrimitive::Cylinder { radius, height, segments } => {
            let (r, h) = (*radius as f32, *height as f32);
            lathe(&[(r, -h / 2.0), (r, h / 2.0)], *segments, true)
        }
        MeshPrimitive::Cone { radius, height, segments } => {
            let (r, h) = (*radius as f32, *height as f32);
            lathe(&[(0.0001, -h / 2.0), (r, h / 2.0)], *segments, true)
        }
        MeshPrimitive::Torus { radius, tube, segments, sides } => torus(*radius as f32, *tube as f32, *segments, *sides),
        MeshPrimitive::Plane { width, height, subdivisions } => plane(*width as f32, *height as f32, *subdivisions),
        MeshPrimitive::Grid { width, height, cells } => plane(*width as f32, *height as f32, *cells),
        MeshPrimitive::Pyramid { size, height } => pyramid(*size as f32, *height as f32),
        MeshPrimitive::Circle { radius, segments } => disc(*radius as f32, *segments),
        MeshPrimitive::Custom { positions, indices } => {
            let mut m = MeshData::default();
            for p in positions {
                m.v([p[0] as f32, p[1] as f32, p[2] as f32], [0.0, 0.0, -1.0], [0.0, 0.0]);
            }
            m.indices = indices.iter().copied().filter(|i| (*i as usize) < positions.len()).collect();
            m.indices.truncate(m.indices.len() / 3 * 3);
            m.flat()
        }
        MeshPrimitive::Imported { .. } => MeshData::default(),
    }
}

// ------------------------------------------------------------------ import

/// Load all meshes from a glTF/GLB file with node transforms baked, scaled so the model's
/// largest dimension is `target` px. glTF is y-up metres; VEYRA is y-down px.
pub fn load_gltf(path: &str, node: Option<usize>, target: f32) -> Result<MeshData, String> {
    let (doc, buffers, _) = gltf::import(path).map_err(|e| e.to_string())?;
    let mut out = MeshData::default();
    fn walk(n: gltf::Node, parent: glam::Mat4, buffers: &[gltf::buffer::Data], out: &mut MeshData, only: Option<usize>, inside: bool) {
        let m = parent * glam::Mat4::from_cols_array_2d(&n.transform().matrix());
        let take = only.is_none() || inside || only == Some(n.index());
        if take {
            if let Some(mesh) = n.mesh() {
                for prim in mesh.primitives() {
                    let r = prim.reader(|b| Some(&buffers[b.index()]));
                    let Some(pos) = r.read_positions() else { continue };
                    let pos: Vec<[f32; 3]> = pos.collect();
                    let nrm: Vec<[f32; 3]> = r.read_normals().map(|n| n.collect()).unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; pos.len()]);
                    let uv: Vec<[f32; 2]> = r.read_tex_coords(0).map(|t| t.into_f32().collect()).unwrap_or_else(|| vec![[0.0, 0.0]; pos.len()]);
                    let idx: Vec<u32> = r.read_indices().map(|i| i.into_u32().collect()).unwrap_or_else(|| (0..pos.len() as u32).collect());
                    let nm = m.inverse().transpose();
                    let mut part = MeshData::default();
                    for i in 0..pos.len() {
                        let p = m.transform_point3(glam::Vec3::from(pos[i]));
                        let nn = nm.transform_vector3(glam::Vec3::from(nrm[i])).normalize_or_zero();
                        // y-up -> y-down
                        part.v([p.x, -p.y, p.z], [nn.x, -nn.y, nn.z], uv[i]);
                    }
                    // Flipping y mirrors the mesh, so reverse winding.
                    for t in idx.chunks_exact(3) {
                        part.tri(t[0], t[2], t[1]);
                    }
                    out.append(&part);
                }
            }
        }
        for c in n.children() {
            walk(c, m, buffers, out, only, take && only.is_some());
        }
    }
    let scene = doc.default_scene().or_else(|| doc.scenes().next()).ok_or("glTF has no scenes")?;
    for n in scene.nodes() {
        walk(n, glam::Mat4::IDENTITY, &buffers, &mut out, node, false);
    }
    if out.vertices.is_empty() {
        return Err("no mesh geometry found".into());
    }
    normalise(&mut out, target);
    Ok(out)
}

pub fn load_obj(path: &str, target: f32) -> Result<MeshData, String> {
    let src = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let (mut p, mut t, mut n) = (vec![], vec![], vec![]);
    let mut out = MeshData::default();
    for line in src.lines() {
        let mut it = line.split_whitespace();
        let f = |it: &mut std::str::SplitWhitespace| -> Vec<f32> { it.filter_map(|x| x.parse().ok()).collect() };
        match it.next() {
            Some("v") => {
                let v = f(&mut it);
                if v.len() >= 3 {
                    p.push([v[0], -v[1], v[2]]);
                }
            }
            Some("vt") => {
                let v = f(&mut it);
                t.push([*v.first().unwrap_or(&0.0), 1.0 - *v.get(1).unwrap_or(&0.0)]);
            }
            Some("vn") => {
                let v = f(&mut it);
                if v.len() >= 3 {
                    n.push([v[0], -v[1], v[2]]);
                }
            }
            Some("f") => {
                let idx = |s: &str, len: usize| -> Option<usize> {
                    let i: i64 = s.parse().ok()?;
                    Some(if i < 0 { (len as i64 + i) as usize } else { (i - 1) as usize })
                };
                let verts: Vec<u32> = it
                    .filter_map(|c| {
                        let mut parts = c.split('/');
                        let pi = idx(parts.next()?, p.len())?;
                        let ti = parts.next().and_then(|s| idx(s, t.len()));
                        let ni = parts.next().and_then(|s| idx(s, n.len()));
                        let pos = *p.get(pi)?;
                        Some(out.v(pos, ni.and_then(|i| n.get(i).copied()).unwrap_or([0.0, 0.0, 0.0]), ti.and_then(|i| t.get(i).copied()).unwrap_or([0.0, 0.0])))
                    })
                    .collect();
                for k in 1..verts.len().saturating_sub(1) {
                    out.tri(verts[0], verts[k + 1], verts[k]);
                }
            }
            _ => {}
        }
    }
    if out.vertices.is_empty() {
        return Err("OBJ contains no faces".into());
    }
    if n.is_empty() {
        out = out.flat();
    }
    normalise(&mut out, target);
    Ok(out)
}

fn normalise(m: &mut MeshData, target: f32) {
    let (lo, hi) = m.bounds();
    let size = (0..3).map(|i| hi[i] - lo[i]).fold(0.0f32, f32::max).max(1e-6);
    let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let s = target / size;
    for v in &mut m.vertices {
        for i in 0..3 {
            v.pos[i] = (v.pos[i] - c[i]) * s;
        }
    }
}

// ------------------------------------------------------------------ extrusion

fn flatten_contours(path: &sk::Path) -> Vec<Vec<[f32; 2]>> {
    let mut out: Vec<Vec<[f32; 2]>> = vec![];
    let mut cur: Vec<[f32; 2]> = vec![];
    let mut last = [0.0f32, 0.0];
    for seg in path.segments() {
        match seg {
            sk::PathSegment::MoveTo(p) => {
                if cur.len() > 2 {
                    out.push(std::mem::take(&mut cur));
                }
                cur.clear();
                cur.push([p.x, p.y]);
                last = [p.x, p.y];
            }
            sk::PathSegment::LineTo(p) => {
                cur.push([p.x, p.y]);
                last = [p.x, p.y];
            }
            sk::PathSegment::QuadTo(c, p) => {
                for i in 1..=8 {
                    let t = i as f32 / 8.0;
                    let mt = 1.0 - t;
                    cur.push([mt * mt * last[0] + 2.0 * mt * t * c.x + t * t * p.x, mt * mt * last[1] + 2.0 * mt * t * c.y + t * t * p.y]);
                }
                last = [p.x, p.y];
            }
            sk::PathSegment::CubicTo(c1, c2, p) => {
                for i in 1..=12 {
                    let t = i as f32 / 12.0;
                    let mt = 1.0 - t;
                    cur.push([
                        mt * mt * mt * last[0] + 3.0 * mt * mt * t * c1.x + 3.0 * mt * t * t * c2.x + t * t * t * p.x,
                        mt * mt * mt * last[1] + 3.0 * mt * mt * t * c1.y + 3.0 * mt * t * t * c2.y + t * t * t * p.y,
                    ]);
                }
                last = [p.x, p.y];
            }
            sk::PathSegment::Close => {
                if cur.len() > 2 {
                    out.push(std::mem::take(&mut cur));
                }
            }
        }
    }
    if cur.len() > 2 {
        out.push(cur);
    }
    out
}

/// Extrude filled 2D paths (layer px) into a closed 3D mesh `depth` px deep, centred on
/// `center`. Caps are tessellated with lyon (handles holes, e.g. the inside of "O").
pub fn extrude(paths: &[sk::Path], depth: f32, center: [f32; 2]) -> MeshData {
    use lyon_tessellation::{geom::point, path::Path as LPath, BuffersBuilder, FillOptions, FillTessellator, FillVertex, VertexBuffers};
    let mut out = MeshData::default();
    let (z0, z1) = (-depth / 2.0, depth / 2.0);
    for p in paths {
        let contours = flatten_contours(p);
        let mut lb = LPath::builder();
        for c in &contours {
            lb.begin(point(c[0][0], c[0][1]));
            for q in &c[1..] {
                lb.line_to(point(q[0], q[1]));
            }
            lb.end(true);
        }
        let lp = lb.build();
        let mut geo: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
        let ok = FillTessellator::new().tessellate_path(
            &lp,
            &FillOptions::tolerance(0.25).with_fill_rule(lyon_tessellation::FillRule::NonZero),
            &mut BuffersBuilder::new(&mut geo, |v: FillVertex| v.position().to_array()),
        );
        if ok.is_err() {
            continue;
        }
        for (z, nz, flip) in [(z0, -1.0f32, false), (z1, 1.0, true)] {
            let base = out.vertices.len() as u32;
            for v in &geo.vertices {
                out.v([v[0] - center[0], v[1] - center[1], z], [0.0, 0.0, nz], [0.0, 0.0]);
            }
            for t in geo.indices.chunks_exact(3) {
                if flip {
                    out.tri(base + t[0], base + t[2], base + t[1]);
                } else {
                    out.tri(base + t[0], base + t[1], base + t[2]);
                }
            }
        }
        if depth > 0.0 {
            for c in &contours {
                for i in 0..c.len() {
                    let (a, b) = (c[i], c[(i + 1) % c.len()]);
                    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                    let l = (dx * dx + dy * dy).sqrt().max(1e-6);
                    let n = [dy / l, -dx / l, 0.0];
                    let pa = [a[0] - center[0], a[1] - center[1]];
                    let pb = [b[0] - center[0], b[1] - center[1]];
                    let i0 = out.v([pa[0], pa[1], z0], n, [0.0, 0.0]);
                    let i1 = out.v([pb[0], pb[1], z0], n, [1.0, 0.0]);
                    let i2 = out.v([pb[0], pb[1], z1], n, [1.0, 1.0]);
                    let i3 = out.v([pa[0], pa[1], z1], n, [0.0, 1.0]);
                    out.quad(i0, i3, i2, i1);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitives_are_valid() {
        for p in [
            MeshPrimitive::Cube { size: 100.0 },
            MeshPrimitive::Sphere { radius: 50.0, segments: 16, rings: 8 },
            MeshPrimitive::Cylinder { radius: 20.0, height: 80.0, segments: 16 },
            MeshPrimitive::Cone { radius: 20.0, height: 80.0, segments: 16 },
            MeshPrimitive::Torus { radius: 40.0, tube: 10.0, segments: 16, sides: 8 },
            MeshPrimitive::Plane { width: 100.0, height: 50.0, subdivisions: 2 },
            MeshPrimitive::Pyramid { size: 50.0, height: 50.0 },
            MeshPrimitive::Circle { radius: 10.0, segments: 12 },
        ] {
            let m = primitive(&p);
            assert!(!m.indices.is_empty() && m.indices.len() % 3 == 0, "{p:?}");
            assert!(m.indices.iter().all(|i| (*i as usize) < m.vertices.len()));
        }
    }

    #[test]
    fn extrusion_handles_holes() {
        let mut pb = sk::PathBuilder::new();
        pb.push_rect(sk::Rect::from_xywh(0.0, 0.0, 100.0, 100.0).unwrap());
        pb.push_rect(sk::Rect::from_xywh(25.0, 25.0, 50.0, 50.0).unwrap());
        let p = pb.finish().unwrap();
        let m = extrude(&[p], 20.0, [50.0, 50.0]);
        assert!(m.indices.len() >= 3 * (8 * 2 + 16));
        let (lo, hi) = m.bounds();
        assert_eq!((lo[2], hi[2]), (-10.0, 10.0));
    }
}
