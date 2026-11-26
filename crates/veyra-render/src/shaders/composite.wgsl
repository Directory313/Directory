// Layer placement (transform a layer texture into composition space) and blending.

struct D {
    mvp: mat4x4<f32>,
    size: vec2<f32>,     // layer texture size in layer px (incl. padding)
    origin: vec2<f32>,   // top-left of the texture in layer px (= -padding)
    opacity: f32,
    wipe_kind: u32,      // 0 none, 1 left, 2 right, 3 up, 4 down
    wipe: f32,           // 0..1 revealed fraction
    feather: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var t_layer: texture_2d<f32>;
@group(0) @binding(2) var<uniform> d: D;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs_layer(@builtin(vertex_index) i: u32) -> VOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: VOut;
    let local = d.origin + c * d.size;
    o.pos = d.mvp * vec4<f32>(local, 0.0, 1.0);
    o.uv = c;
    return o;
}

@fragment
fn fs_layer(in: VOut) -> @location(0) vec4<f32> {
    var c = textureSample(t_layer, samp, in.uv) * d.opacity;
    if (d.wipe_kind != 0u) {
        var x = in.uv.x;
        if (d.wipe_kind == 2u) { x = 1.0 - in.uv.x; }
        if (d.wipe_kind == 3u) { x = 1.0 - in.uv.y; }
        if (d.wipe_kind == 4u) { x = in.uv.y; }
        let f = max(d.feather, 1e-4);
        c *= 1.0 - smoothstep(d.wipe - f, d.wipe, x);
    }
    return c;
}

// ------------------------------------------------------------------ blending

struct B {
    mode: u32,
    matte: u32,   // 0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted
    adjust: u32,  // 1 = adjustment layer: mix(dst, src, coverage * opacity)
    opacity: f32,
};

@group(0) @binding(0) var bsamp: sampler;
@group(0) @binding(1) var t_dst: texture_2d<f32>;
@group(0) @binding(2) var t_src: texture_2d<f32>;
@group(0) @binding(3) var t_matte: texture_2d<f32>;
@group(0) @binding(4) var<uniform> b: B;

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VOut {
    var o: VOut;
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    o.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    o.uv = vec2<f32>(x, y);
    return o;
}

fn lum(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }
fn clip_color(c: vec3<f32>) -> vec3<f32> {
    let l = lum(c);
    let n = min(c.r, min(c.g, c.b));
    let x = max(c.r, max(c.g, c.b));
    var o = c;
    if (n < 0.0) { o = l + (o - l) * l / max(l - n, 1e-5); }
    if (x > 1.0) { o = l + (o - l) * (1.0 - l) / max(x - l, 1e-5); }
    return o;
}
fn set_lum(c: vec3<f32>, l: f32) -> vec3<f32> { return clip_color(c + (l - lum(c))); }
fn satv(c: vec3<f32>) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn set_sat(c: vec3<f32>, s: f32) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    if (mx - mn <= 1e-5) { return vec3<f32>(0.0); }
    return (c - mn) * s / (mx - mn);
}
fn hard(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    return select(1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), 2.0 * cb * cs, cs <= vec3<f32>(0.5));
}
fn soft(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    let d = select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= vec3<f32>(0.25));
    return select(cb + (2.0 * cs - 1.0) * (d - cb), cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb), cs <= vec3<f32>(0.5));
}

fn blendf(m: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    switch m {
        case 1u: { return cb * cs; }
        case 2u: { return cb + cs - cb * cs; }
        case 3u: { return hard(cs, cb); }
        case 4u: { return soft(cb, cs); }
        case 5u: { return hard(cb, cs); }
        case 6u: { return min(cb, cs); }
        case 7u: { return max(cb, cs); }
        case 8u: { return abs(cb - cs); }
        case 9u: { return cb + cs - 2.0 * cb * cs; }
        case 10u: { return min(cb + cs, vec3<f32>(1.0)); }
        case 11u: { return max(cb - cs, vec3<f32>(0.0)); }
        case 12u: { return set_lum(cs, lum(cb)); }
        case 13u: { return set_lum(set_sat(cs, satv(cb)), lum(cb)); }
        case 14u: { return set_lum(set_sat(cb, satv(cs)), lum(cb)); }
        case 15u: { return set_lum(cb, lum(cs)); }
        default: { return cs; }
    }
}

@fragment
fn fs_blend(in: VOut) -> @location(0) vec4<f32> {
    let dst = textureSample(t_dst, bsamp, in.uv);
    var src = textureSample(t_src, bsamp, in.uv);
    let mt = textureSample(t_matte, bsamp, in.uv);
    if (b.adjust == 1u) {
        let cov = clamp(mt.r * b.opacity, 0.0, 1.0);
        return mix(dst, src, cov);
    }
    if (b.matte != 0u) {
        var f = mt.a;
        if (b.matte >= 3u) { f = lum(mt.rgb / max(mt.a, 1e-5)) * mt.a; }
        if (b.matte == 2u || b.matte == 4u) { f = 1.0 - f; }
        src *= f;
    }
    let as_ = src.a;
    let ab = dst.a;
    if (b.mode == 0u || ab <= 0.0) {
        return src + dst * (1.0 - as_);
    }
    if (as_ <= 0.0) { return dst; }
    let cs = clamp(src.rgb / as_, vec3<f32>(0.0), vec3<f32>(1.0));
    let cb = clamp(dst.rgb / ab, vec3<f32>(0.0), vec3<f32>(1.0));
    let bl = clamp(blendf(b.mode, cb, cs), vec3<f32>(0.0), vec3<f32>(1.0));
    let co = src.rgb * (1.0 - ab) + dst.rgb * (1.0 - as_) + as_ * ab * bl;
    return vec4<f32>(co, as_ + ab - as_ * ab);
}
