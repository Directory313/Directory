// VEYRA effects uber-shader. All textures are premultiplied RGBA.
// Parameter slot i == registry parameter i (see veyra-core/src/registry.rs).

struct U {
    kind: u32,
    flags: u32,
    time: f32,
    scale: f32,
    size: vec2<f32>,     // render target size, px
    content: vec2<f32>,  // layer content size (without padding), px
    pad: vec2<f32>,      // padding on each side, px
    seed: f32,
    intensity: f32,
    p: array<vec4<f32>, 24>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var t_a: texture_2d<f32>;
@group(0) @binding(2) var t_b: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: U;
@group(0) @binding(4) var t_curves: texture_2d<f32>;
@group(0) @binding(5) var t_lut: texture_3d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var o: VOut;
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    o.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    o.uv = vec2<f32>(x, y);
    return o;
}

const PI: f32 = 3.14159265;

fn inb(uv: vec2<f32>) -> bool { return all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0)); }
fn sa(uv: vec2<f32>) -> vec4<f32> {
    if (!inb(uv)) { return vec4<f32>(0.0); }
    return textureSampleLevel(t_a, samp, uv, 0.0);
}
fn sb(uv: vec2<f32>) -> vec4<f32> {
    if (!inb(uv)) { return vec4<f32>(0.0); }
    return textureSampleLevel(t_b, samp, uv, 0.0);
}
fn unp(c: vec4<f32>) -> vec3<f32> { return c.rgb / max(c.a, 1e-5); }
fn pre(rgb: vec3<f32>, a: f32) -> vec4<f32> { return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(64.0)) * a, a); }
fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn px() -> vec2<f32> { return 1.0 / u.size; }
// Relative point (fraction of content) -> uv.
fn rp(f: vec2<f32>) -> vec2<f32> { return (u.pad + f * u.content) / u.size; }
fn aspect() -> vec2<f32> { return vec2<f32>(u.size.x / u.size.y, 1.0); }

fn hash(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7)) + u.seed * 17.13;
    return fract(sin(h) * 43758.5453);
}
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    let a = hash(i);
    let b = hash(i + vec2<f32>(1.0, 0.0));
    let c = hash(i + vec2<f32>(0.0, 1.0));
    let d = hash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
fn fbm(p: vec2<f32>, oct: i32) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var q = p;
    for (var i = 0; i < 8; i++) {
        if (i >= oct) { break; }
        v += a * vnoise(q);
        q = q * 2.03 + vec2<f32>(17.0, 9.0);
        a *= 0.5;
    }
    return v;
}

fn rgb2hsv(c: vec3<f32>) -> vec3<f32> {
    let K = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    let p = mix(vec4<f32>(c.bg, K.wz), vec4<f32>(c.gb, K.xy), step(c.b, c.g));
    let q = mix(vec4<f32>(p.xyw, c.r), vec4<f32>(c.r, p.yzx), step(p.x, c.r));
    let d = q.x - min(q.w, q.y);
    let e = 1.0e-10;
    return vec3<f32>(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
    let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}
fn sat(c: vec3<f32>, s: f32) -> vec3<f32> { let l = luma(c); return mix(vec3<f32>(l), c, s); }
fn curve(row: f32, x: f32) -> f32 {
    return textureSampleLevel(t_curves, samp, vec2<f32>(clamp(x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, (row + 0.5) / 8.0), 0.0).r;
}
fn temp_tint(c: vec3<f32>, temp: f32, tint: f32) -> vec3<f32> {
    return c * vec3<f32>(1.0 + temp * 0.3 + tint * 0.1, 1.0 - tint * 0.25, 1.0 - temp * 0.3 + tint * 0.1);
}
fn rot2(v: vec2<f32>, a: f32) -> vec2<f32> { let c = cos(a); let s = sin(a); return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y); }

// ---------------------------------------------------------------- blur
fn gauss1d(uv: vec2<f32>, dir: vec2<f32>, radius: f32, box_: bool) -> vec4<f32> {
    if (radius < 0.5) { return sa(uv); }
    let taps = min(ceil(radius), 96.0);
    let stepl = radius / taps;
    let sigma = max(radius / 2.5, 0.5);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var i = -taps; i <= taps; i += 1.0) {
        let x = i * stepl;
        var w = 1.0;
        if (!box_) { w = exp(-0.5 * x * x / (sigma * sigma)); }
        var s = sa(uv + dir * x * px());
        if ((u.flags & 1u) != 0u) { s = textureSampleLevel(t_a, samp, clamp(uv + dir * x * px(), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0); }
        acc += s * w;
        wsum += w;
    }
    return acc / wsum;
}

fn directional(uv: vec2<f32>, angle: f32, len: f32) -> vec4<f32> {
    let d = vec2<f32>(sin(angle), -cos(angle)) * len * px();
    var acc = vec4<f32>(0.0);
    let n = 32.0;
    for (var i = 0.0; i < n; i += 1.0) { acc += sa(uv + d * (i / (n - 1.0) - 0.5)); }
    return acc / n;
}

fn lens_blur(uv: vec2<f32>, r: f32, bright: f32) -> vec4<f32> {
    if (r < 0.5) { return sa(uv); }
    var acc = vec4<f32>(0.0);
    var w = 0.0;
    let golden = 2.39996;
    for (var i = 0.0; i < 96.0; i += 1.0) {
        let rr = sqrt((i + 0.5) / 96.0) * r;
        let a = i * golden;
        let s = sa(uv + vec2<f32>(cos(a), sin(a)) * rr * px());
        let k = 1.0 + bright * pow(luma(unp(s)) * s.a, 4.0) * 8.0;
        acc += s * k;
        w += k;
    }
    return acc / w;
}

// ---------------------------------------------------------------- main
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let c = sa(uv);
    let P = u.p;
    let k = u.kind;
    let sc = u.scale;

    // ----- copy / blur family
    if (k == 1u) { return c; }
    if (k == 2u) { return gauss1d(uv, vec2<f32>(1.0, 0.0), P[0].x * sc, P[0].y > 0.5); }
    if (k == 3u) { return gauss1d(uv, vec2<f32>(0.0, 1.0), P[0].x * sc, P[0].y > 0.5); }
    if (k == 4u) { return directional(uv, P[0].x * PI / 180.0, P[1].x * sc); }
    if (k == 5u) { // radial (spin)
        let ctr = rp(P[0].xy);
        let d = (uv - ctr) * aspect();
        var acc = vec4<f32>(0.0);
        let amt = P[1].x * PI / 180.0;
        for (var i = 0.0; i < 32.0; i += 1.0) {
            let a = amt * (i / 31.0 - 0.5);
            acc += sa(ctr + rot2(d, a) / aspect());
        }
        return acc / 32.0;
    }
    if (k == 6u) { // zoom
        let ctr = rp(P[0].xy);
        var acc = vec4<f32>(0.0);
        for (var i = 0.0; i < 32.0; i += 1.0) {
            let s = 1.0 - P[1].x / 100.0 * (i / 31.0) * 0.5;
            acc += sa(ctr + (uv - ctr) * s);
        }
        return acc / 32.0;
    }
    if (k == 7u) { // sharpen
        let a = P[0].x / 100.0;
        let n = sa(uv + vec2<f32>(0.0, px().y)) + sa(uv - vec2<f32>(0.0, px().y)) + sa(uv + vec2<f32>(px().x, 0.0)) + sa(uv - vec2<f32>(px().x, 0.0));
        let r = c * (1.0 + 4.0 * a) - n * a;
        return vec4<f32>(clamp(r.rgb, vec3<f32>(0.0), vec3<f32>(r.a)), c.a);
    }
    if (k == 8u) { return gauss1d(uv, vec2<f32>(1.0, 0.0), P[1].x * sc, false); } // unsharp: first blur pass handled by host
    if (k == 9u) { return lens_blur(uv, P[0].x * sc, P[1].x); }

    // ----- glow family: 10 = extract bright parts (then host blurs), 67 = combine
    if (k == 10u) {
        let col = unp(c);
        let l = luma(col);
        let m = smoothstep(P[0].x, P[0].x + 0.1, l);
        return pre(col * P[3].rgb, c.a * m);
    }
    if (k == 67u) {
        let o = sb(uv);
        let g = c * P[2].x;
        let mode = i32(P[4].x + 0.5);
        if (mode == 0) { return g + o * (1.0 - g.a); }
        if (mode == 1) { return vec4<f32>(o.rgb + g.rgb - o.rgb * g.rgb, max(o.a, g.a)); }
        return vec4<f32>(o.rgb + g.rgb, max(o.a, min(g.a, 1.0)));
    }
    if (k == 11u) { // light rays
        let ctr = rp(P[0].xy);
        var acc = vec3<f32>(0.0);
        let n = 48.0;
        for (var i = 0.0; i < n; i += 1.0) {
            let s = 1.0 - P[1].x * (i / n);
            let q = sa(ctr + (uv - ctr) * s);
            let col = unp(q);
            acc += col * q.a * smoothstep(P[3].x, P[3].x + 0.2, luma(col));
        }
        let rays = acc / n * P[2].x;
        return vec4<f32>(c.rgb + rays * (1.0 - c.a * 0.0), max(c.a, clamp(luma(rays), 0.0, 1.0)));
    }
    if (k == 12u) { // vignette
        let d = (uv - 0.5) * mix(vec2<f32>(1.0), aspect(), P[2].x) * 2.0;
        let r = length(d);
        let v = smoothstep(P[1].x, P[1].x + P[3].x, r);
        let col = unp(c);
        var outc = col;
        if (P[0].x >= 0.0) { outc = mix(col, P[4].rgb, v * P[0].x); } else { outc = mix(col, vec3<f32>(1.0), v * -P[0].x); }
        return pre(outc, c.a);
    }
    if (k == 13u) { // drop shadow extract: offset alpha
        let a = P[2].x * PI / 180.0;
        let off = vec2<f32>(sin(a), -cos(a)) * P[3].x * sc * px();
        let s = sa(uv - off).a * P[1].x;
        return vec4<f32>(P[0].rgb * s, s);
    }
    if (k == 68u) { // shadow combine: original over shadow
        let o = sb(uv);
        if (P[5].x > 0.5) { return c * (1.0 - o.a); }
        return o + c * (1.0 - o.a);
    }
    if (k == 14u) { // inner shadow extract: inverted alpha offset
        let a = P[2].x * PI / 180.0;
        let off = vec2<f32>(sin(a), -cos(a)) * P[3].x * sc * px();
        let s = (1.0 - sa(uv - off).a) * P[1].x;
        return vec4<f32>(P[0].rgb * s, s);
    }
    if (k == 74u) { // inner shadow combine: shadow clipped to original alpha, over original
        let o = sb(uv);
        let s = c * o.a;
        return s + o * (1.0 - s.a);
    }
    if (k == 69u) { // unsharp combine: c = blurred, b = original
        let o = sb(uv);
        let diff = unp(o) - unp(c);
        let m = step(P[2].x, abs(luma(diff)));
        return pre(unp(o) + diff * P[0].x / 100.0 * m, o.a);
    }
    if (k == 15u) { // exposure
        let col = unp(c) * exp2(P[0].x) + P[1].x;
        return pre(pow(max(col, vec3<f32>(0.0)), vec3<f32>(1.0 / P[2].x)), c.a);
    }
    if (k == 16u) { // highlights & shadows
        var col = unp(c);
        let l = luma(col);
        let hw = smoothstep(0.5, 1.0, l);
        let sw = 1.0 - smoothstep(0.0, 0.5, l);
        col = col * (1.0 - P[0].x * hw * 0.5) + P[1].x * sw * 0.3;
        col = col + P[2].x * smoothstep(0.7, 1.0, l) * 0.2 + P[3].x * (1.0 - smoothstep(0.0, 0.3, l)) * 0.2;
        return pre(col, c.a);
    }
    if (k == 17u) { // film grain
        let cell = max(P[1].x * sc, 0.5);
        var t = 0.0;
        if (P[2].x > 0.5) { t = floor(u.time * 24.0); }
        let q = floor(uv * u.size / cell) + vec2<f32>(t * 13.1, t * 7.7);
        var g = vec3<f32>(hash(q) - 0.5);
        if (P[3].x > 0.5) { g = vec3<f32>(hash(q) - 0.5, hash(q + 3.1) - 0.5, hash(q + 7.3) - 0.5); }
        let col = unp(c);
        let l = luma(col);
        return pre(col + g * P[0].x * (1.0 - abs(l - 0.5)), c.a);
    }
    if (k == 18u) { // noise
        var t = 0.0;
        if (P[2].x > 0.5) { t = u.time * 60.0; }
        let q = uv * u.size + vec2<f32>(t, t * 1.37);
        var n = vec3<f32>(hash(q) - 0.5);
        if (P[1].x < 0.5) { n = vec3<f32>(hash(q) - 0.5, hash(q + 11.0) - 0.5, hash(q + 23.0) - 0.5); }
        return pre(unp(c) + n * P[0].x, c.a);
    }
    if (k == 19u) { // chromatic aberration
        let ctr = rp(P[1].xy);
        let d = (uv - ctr) * P[0].x * sc * px() * 0.05 * length(u.size);
        let r = sa(uv + d * 0.01);
        let b = sa(uv - d * 0.01);
        return vec4<f32>(r.r, c.g, b.b, max(max(r.a, c.a), b.a));
    }
    if (k == 20u) { // lens distortion
        let d = (uv - 0.5) * aspect();
        let r2 = dot(d, d);
        let f = 1.0 + P[0].x * r2;
        return sa(0.5 + d * f / P[1].x / aspect());
    }
    if (k == 21u) { // turbulent displace
        let q = uv * u.size / max(P[1].x * sc, 1.0) + vec2<f32>(P[2].x * 0.01);
        let oct = i32(P[3].x);
        let dx = fbm(q, oct) - 0.5;
        let dy = fbm(q + vec2<f32>(5.2, 1.3), oct) - 0.5;
        return sa(uv + vec2<f32>(dx, dy) * P[0].x * sc * px() * 2.0);
    }
    if (k == 22u) { // heat
        let q = uv * u.size / max(P[1].x * sc, 1.0) + vec2<f32>(0.0, u.time * P[2].x);
        let d = vec2<f32>(fbm(q, 3) - 0.5, fbm(q + 4.0, 3) - 0.5);
        return sa(uv + d * P[0].x * sc * px() * 2.0);
    }
    if (k == 23u) { // pixelate
        let cell = max(P[0].x * sc, 1.0);
        let q = (floor(uv * u.size / cell) + 0.5) * cell / u.size;
        return sa(q);
    }
    if (k == 24u) {
        let n = max(P[0].x - 1.0, 1.0);
        return pre(floor(unp(c) * n + 0.5) / n, c.a);
    }
    if (k == 25u) { // lens flare (additive)
        let ctr = rp(P[0].xy);
        let a = aspect();
        var f = vec3<f32>(0.0);
        let d0 = length((uv - ctr) * a);
        f += P[2].rgb * pow(max(1.0 - d0 / (0.25 * P[3].x), 0.0), 3.0) * 1.5;
        let axis = vec2<f32>(0.5) - ctr;
        for (var i = 1.0; i < 6.0; i += 1.0) {
            let pos = ctr + axis * (i * 0.45);
            let rr = (0.02 + 0.03 * fract(i * 0.37)) * P[3].x;
            let d = length((uv - pos) * a);
            f += P[2].rgb * vec3<f32>(0.6 + 0.4 * sin(i), 0.7, 0.9) * smoothstep(rr, rr * 0.6, d) * 0.25;
        }
        let streak = exp(-abs((uv.y - ctr.y) * u.size.y) / (6.0 * sc + 1.0)) * exp(-abs(uv.x - ctr.x) * 3.0) * 0.6;
        f += P[2].rgb * streak;
        f *= P[1].x;
        return vec4<f32>(c.rgb + f, max(c.a, clamp(luma(f), 0.0, 1.0)));
    }

    // ----- stylize
    if (k == 26u || k == 28u || k == 29u) {
        var ew = 1.0;
        if (k == 26u) { ew = P[2].x; }
        let e = ew * sc * px();
        var gx = 0.0;
        var gy = 0.0;
        for (var j = -1; j <= 1; j++) {
            for (var i = -1; i <= 1; i++) {
                let l = luma(unp(sa(uv + vec2<f32>(f32(i), f32(j)) * max(e, px())))) ;
                let wx = f32(i) * select(1.0, 2.0, j == 0);
                let wy = f32(j) * select(1.0, 2.0, i == 0);
                gx += l * wx;
                gy += l * wy;
            }
        }
        let edge = clamp(length(vec2<f32>(gx, gy)), 0.0, 1.0);
        if (k == 26u) {
            let n = max(P[0].x, 2.0);
            let col = floor(unp(c) * n + 0.5) / n;
            return pre(col * (1.0 - clamp(edge * P[1].x * 2.0, 0.0, 1.0)), c.a);
        }
        if (k == 28u) {
            var v = clamp(edge * P[0].x, 0.0, 1.0);
            if (P[1].x > 0.5) { v = 1.0 - v; }
            return pre(mix(vec3<f32>(v), unp(c), P[2].x), c.a);
        }
        let ink = clamp(edge * P[0].x, 0.0, 1.0);
        return pre(mix(P[1].rgb, P[2].rgb, ink), c.a);
    }
    if (k == 27u) { // outline around alpha
        let w = P[1].x * sc;
        var m = 0.0;
        for (var i = 0.0; i < 24.0; i += 1.0) {
            let a = i / 24.0 * 2.0 * PI;
            m = max(m, sa(uv + vec2<f32>(cos(a), sin(a)) * w * px()).a);
            m = max(m, sa(uv + vec2<f32>(cos(a), sin(a)) * w * 0.5 * px()).a);
        }
        let ring = vec4<f32>(P[0].rgb, 1.0) * m * P[0].a;
        if (P[2].x > 0.5) { return ring * (1.0 - c.a); }
        return c + ring * (1.0 - c.a);
    }
    if (k == 30u) { // halftone
        let s = max(P[0].x * sc, 2.0);
        let a = P[1].x * PI / 180.0;
        let q = rot2(uv * u.size, a);
        let cell = (fract(q / s) - 0.5);
        let center = (floor(q / s) + 0.5) * s;
        let src = sa(rot2(center, -a) / u.size);
        let col = unp(src);
        if (P[2].x > 0.5) {
            let cmy = 1.0 - col;
            let r = sqrt(cmy) * 0.5;
            let d = length(cell);
            let ink = vec3<f32>(step(d, r.r), step(d, r.g), step(d, r.b));
            return pre(1.0 - ink, c.a);
        }
        let r = sqrt(1.0 - luma(col)) * 0.6;
        let v = 1.0 - smoothstep(r - 0.05, r + 0.05, length(cell));
        return pre(vec3<f32>(1.0 - v), c.a);
    }
    if (k == 31u) {
        let l = luma(unp(c));
        let v = smoothstep(P[0].x - P[1].x - 0.001, P[0].x + P[1].x + 0.001, l);
        return pre(vec3<f32>(v), c.a);
    }
    if (k == 32u) { let l = luma(unp(c)); return pre(mix(unp(c), mix(P[0].rgb, P[1].rgb, l), P[2].x), c.a); }
    if (k == 33u) {
        let l = luma(unp(c));
        var t = mix(P[0].rgb, P[1].rgb, clamp(l * 2.0, 0.0, 1.0));
        if (l > 0.5) { t = mix(P[1].rgb, P[2].rgb, (l - 0.5) * 2.0); }
        return pre(mix(unp(c), t, P[3].x), c.a);
    }
    if (k == 70u) { // mosaic
        let cells = vec2<f32>(max(P[0].x, 1.0), max(P[1].x, 1.0));
        let q = (floor(uv * cells) + 0.5) / cells;
        return sa(q);
    }
    if (k == 34u) { // VHS
        let amt = P[0].x;
        let line = floor(uv.y * u.size.y / max(2.0 * sc, 1.0));
        let jitter = (hash(vec2<f32>(line, floor(u.time * 30.0))) - 0.5) * 0.004 * amt;
        let b = P[2].x * sc * px().x;
        let r = sa(uv + vec2<f32>(jitter + b, 0.0));
        let g = sa(uv + vec2<f32>(jitter, 0.0));
        let bl = sa(uv + vec2<f32>(jitter - b, 0.0));
        var col = vec3<f32>(r.r, g.g, bl.b) / max(g.a, 1e-5);
        col = sat(col, 1.0 - amt * 0.3);
        let n = (hash(uv * u.size + u.time) - 0.5) * P[1].x * 0.3;
        let scan = 0.92 + 0.08 * sin(uv.y * u.size.y * 1.5);
        return pre((col + n) * mix(1.0, scan, amt), max(g.a, r.a));
    }
    if (k == 35u) { // glitch
        let bs = max(P[1].x * sc, 1.0);
        let t = floor(u.time * P[2].x);
        let row = floor(uv.y * u.size.y / bs);
        let h = hash(vec2<f32>(row, t));
        var q = uv;
        if (h < P[0].x * 0.5) { q.x += (hash(vec2<f32>(row + 1.0, t)) - 0.5) * 0.2 * P[0].x; }
        let off = P[3].x * sc * px().x * step(1.0 - P[0].x, hash(vec2<f32>(t, 3.0)));
        let r = sa(q + vec2<f32>(off, 0.0));
        let g = sa(q);
        let b = sa(q - vec2<f32>(off, 0.0));
        return vec4<f32>(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
    }
    if (k == 36u) {
        let a = P[1].x * PI / 180.0;
        let d = vec2<f32>(cos(a), sin(a)) * P[0].x * sc * px();
        let r = sa(uv + d);
        let b = sa(uv - d);
        return vec4<f32>(r.r, c.g, b.b, max(max(r.a, c.a), b.a));
    }
    if (k == 37u) {
        let y = uv.y * u.size.y + u.time * P[2].x * 10.0;
        let s = 0.5 + 0.5 * sin(y / max(P[0].x * sc, 0.5) * PI);
        return pre(unp(c) * (1.0 - P[1].x * s), c.a);
    }
    if (k == 38u) { // film emulation / retro
        var col = unp(c);
        let s = P[0].x;
        let l = luma(col);
        let filmic = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
        col = mix(col, filmic, s * 0.6);
        col = temp_tint(col, P[1].x * 0.5, 0.0);
        col = mix(col, col * (1.0 - P[2].x * 0.35) + P[2].x * 0.12, s);
        col = sat(col, 1.0 - s * 0.15);
        col += vec3<f32>(1.0, 0.25, 0.15) * smoothstep(0.75, 1.0, l) * P[3].x * 0.3;
        return pre(col, c.a);
    }
    if (k == 39u) { // pixel art
        let cell = max(P[0].x * sc, 1.0);
        let q = (floor(uv * u.size / cell) + 0.5) * cell / u.size;
        let s = sa(q);
        let n = max(P[1].x - 1.0, 1.0);
        var col = floor(unp(s) * n + 0.5) / n;
        if (P[2].x > 0.5) {
            let e = sa(q + vec2<f32>(cell, 0.0) / u.size).a + sa(q - vec2<f32>(cell, 0.0) / u.size).a + sa(q + vec2<f32>(0.0, cell) / u.size).a + sa(q - vec2<f32>(0.0, cell) / u.size).a;
            if (s.a > 0.5 && e < 3.5) { col = col * 0.2; }
        }
        return pre(col, step(0.5, s.a));
    }

    // ----- distort
    if (k == 40u) { // bulge
        let ctr = rp(P[0].xy);
        let d = (uv - ctr) * aspect();
        let r = length(d);
        let rad = P[1].x;
        if (r < rad && rad > 0.0) {
            let f = pow(r / rad, 1.0 + P[2].x * 1.5) * rad / max(r, 1e-5);
            return sa(ctr + d * mix(1.0, f, 1.0) / aspect());
        }
        return c;
    }
    if (k == 72u) { // mesh warp: bilinear interpolation of 3x3 offsets (fractions)
        let g = clamp((uv * u.size - u.pad) / u.content, vec2<f32>(0.0), vec2<f32>(1.0)) * 2.0;
        let ix = min(floor(g.x), 1.0);
        let iy = min(floor(g.y), 1.0);
        let fx = g.x - ix;
        let fy = g.y - iy;
        let i0 = u32(iy) * 3u + u32(ix);
        let o00 = u.p[i0].xy;
        let o10 = u.p[i0 + 1u].xy;
        let o01 = u.p[i0 + 3u].xy;
        let o11 = u.p[i0 + 4u].xy;
        let o = mix(mix(o00, o10, fx), mix(o01, o11, fx), fy);
        return sa(uv - o * u.content / u.size);
    }
    if (k == 73u) { // liquify push
        let p_from = rp(P[0].xy);
        let p_to = rp(P[1].xy);
        let r = P[2].x;
        let d = length((uv - p_to) * aspect());
        let w = exp(-d * d / max(r * r, 1e-5) * 2.0) * P[3].x;
        return sa(uv - (p_to - p_from) * w);
    }
    if (k == 41u) { // wave
        let a = P[3].x * PI / 180.0;
        let dir = vec2<f32>(sin(a), -cos(a));
        let perp = vec2<f32>(-dir.y, dir.x);
        let ph = dot(uv * u.size, perp) / max(P[1].x * sc, 1.0) * 2.0 * PI + u.time * P[2].x * 2.0 * PI;
        return sa(uv + dir * sin(ph) * P[0].x * sc * px());
    }
    if (k == 42u) { // corner pin: inverse bilinear map
        let p0 = rp(P[0].xy);
        let p1 = rp(P[1].xy);
        let p2 = rp(P[2].xy);
        let p3 = rp(P[3].xy);
        let e = p1 - p0;
        let f = p2 - p0;
        let g = p0 - p1 - p2 + p3;
        let h = uv - p0;
        let k2 = g.x * f.y - g.y * f.x;
        let k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
        let k0 = h.x * e.y - h.y * e.x;
        var v = 0.0;
        if (abs(k2) < 1e-6) { v = -k0 / k1; } else {
            let disc = k1 * k1 - 4.0 * k0 * k2;
            if (disc < 0.0) { return vec4<f32>(0.0); }
            v = (-k1 - sqrt(disc)) / (2.0 * k2);
            if (v < 0.0 || v > 1.0) { v = (-k1 + sqrt(disc)) / (2.0 * k2); }
        }
        let den = e + g * v;
        var uu = 0.0;
        if (abs(den.x) > abs(den.y)) { uu = (h.x - f.x * v) / den.x; } else { uu = (h.y - f.y * v) / den.y; }
        if (uu < 0.0 || uu > 1.0 || v < 0.0 || v > 1.0) { return vec4<f32>(0.0); }
        return sa(rp(vec2<f32>(uu, v)));
    }
    if (k == 43u) { // transform
        let ctr = rp(P[0].xy);
        var d = (uv - ctr) * aspect();
        d = rot2(d, -P[2].x * PI / 180.0);
        d.x -= d.y * tan(P[4].x * PI / 180.0);
        d = d / max(P[1].x / 100.0, 1e-4);
        return sa(vec2<f32>(0.5) + d / aspect()) * (P[3].x / 100.0);
    }
    if (k == 44u) { // mirror
        let ctr = rp(P[0].xy);
        let a = P[1].x * PI / 180.0;
        let n = vec2<f32>(cos(a), sin(a));
        let d = (uv - ctr) * aspect();
        let s = dot(d, n);
        if (s < 0.0) { return sa(ctr + (d - 2.0 * s * n) / aspect()); }
        return c;
    }
    if (k == 45u) { // kaleidoscope
        let ctr = rp(P[0].xy);
        let d = (uv - ctr) * aspect();
        let seg = 2.0 * PI / max(P[1].x, 2.0);
        var a = atan2(d.y, d.x) - P[2].x * PI / 180.0;
        a = abs((a - seg * floor(a / seg)) - seg * 0.5);
        let r = length(d);
        return sa(ctr + vec2<f32>(cos(a), sin(a)) * r / aspect());
    }
    if (k == 46u) { // twirl
        let ctr = rp(P[0].xy);
        let d = (uv - ctr) * aspect();
        let r = length(d);
        let rad = P[2].x;
        if (r < rad) {
            let t = 1.0 - r / rad;
            return sa(ctr + rot2(d, P[1].x * PI / 180.0 * t * t) / aspect());
        }
        return c;
    }
    if (k == 47u) { // ripple
        let ctr = rp(P[0].xy);
        let d = (uv - ctr) * u.size;
        let r = length(d);
        let off = sin(r / max(P[2].x * sc, 1.0) * 2.0 * PI - u.time * P[3].x * 2.0 * PI) * P[1].x * sc;
        return sa(uv + normalize(d + 1e-5) * off * px());
    }

    // ----- color
    var col = unp(c);
    if (k == 48u) {
        let l = luma(col);
        let ws = 1.0 - smoothstep(0.0, 0.5, l);
        let wh = smoothstep(0.5, 1.0, l);
        let wm = 1.0 - ws - wh;
        var o = col + P[0].rgb * ws * 0.5 + P[1].rgb * wm * 0.5 + P[2].rgb * wh * 0.5;
        if (P[3].x > 0.5) { o = o * (l / max(luma(o), 1e-4)); }
        return pre(o, c.a);
    }
    if (k == 49u) {
        var hsv = rgb2hsv(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)));
        if (P[3].x > 0.5) { hsv.x = fract(P[0].x / 360.0); hsv.y = clamp(0.25 + P[1].x * 0.75, 0.0, 1.0); }
        else { hsv.x = fract(hsv.x + P[0].x / 360.0); hsv.y = clamp(hsv.y * (1.0 + P[1].x), 0.0, 1.0); }
        var o = hsv2rgb(hsv);
        if (P[2].x > 0.0) { o = mix(o, vec3<f32>(1.0), P[2].x); } else { o = o * (1.0 + P[2].x); }
        return pre(o, c.a);
    }
    if (k == 50u) { // curves: rows 0 master,1 r,2 g,3 b
        let m = vec3<f32>(curve(0.0, col.r), curve(0.0, col.g), curve(0.0, col.b));
        return pre(vec3<f32>(curve(1.0, m.r), curve(2.0, m.g), curve(3.0, m.b)), c.a);
    }
    if (k == 51u) {
        let x = clamp((col - P[0].x) / max(P[1].x - P[0].x, 1e-4), vec3<f32>(0.0), vec3<f32>(1.0));
        return pre(mix(vec3<f32>(P[3].x), vec3<f32>(P[4].x), pow(x, vec3<f32>(1.0 / P[2].x))), c.a);
    }
    if (k == 52u) { return pre(temp_tint(col, P[0].x, P[1].x), c.a); }
    if (k == 53u) {
        let mx = max(col.r, max(col.g, col.b));
        let mn = min(col.r, min(col.g, col.b));
        let s0 = mx - mn;
        let v = 1.0 + P[0].x * (1.0 - s0);
        return pre(sat(col, v * (1.0 + P[1].x)), c.a);
    }
    if (k == 54u) {
        let w = vec3<f32>(P[1].x, P[2].x, P[3].x);
        let l = dot(col, w) / max(P[1].x + P[2].x + P[3].x, 1e-3);
        return pre(mix(col, vec3<f32>(l), P[0].x), c.a);
    }
    if (k == 55u) {
        let a = rgb2hsv(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)));
        let f = rgb2hsv(P[0].rgb);
        let t = rgb2hsv(P[1].rgb);
        var dh = abs(a.x - f.x);
        dh = min(dh, 1.0 - dh);
        let m = (1.0 - smoothstep(P[2].x, P[2].x + P[3].x + 1e-4, dh)) * smoothstep(0.05, 0.2, a.y);
        let o = hsv2rgb(vec3<f32>(t.x, a.y, a.z));
        return pre(mix(col, o, m), c.a);
    }
    if (k == 66u) { // selective color
        var hsv = rgb2hsv(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)));
        var dh = abs(hsv.x - fract(P[0].x / 360.0));
        dh = min(dh, 1.0 - dh) * 360.0;
        let m = 1.0 - smoothstep(P[1].x * 0.5, P[1].x, dh);
        hsv.x = fract(hsv.x + P[2].x / 360.0 * m);
        hsv.y = clamp(hsv.y * (1.0 + P[3].x * m), 0.0, 1.0);
        hsv.z = clamp(hsv.z * (1.0 + P[4].x * m), 0.0, 4.0);
        return pre(hsv2rgb(hsv), c.a);
    }
    if (k == 56u) { // 3D LUT
        let lc = clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));
        let n = f32(textureDimensions(t_lut).x);
        let q = lc * ((n - 1.0) / n) + 0.5 / n;
        let o = textureSampleLevel(t_lut, samp, q, 0.0).rgb;
        return pre(mix(col, o, P[1].x * u.intensity), c.a);
    }
    if (k == 57u) { // primary grade
        var g = col;
        g = g * exp2(P[4].x);
        // whites / blacks / highlights / shadows
        let l0 = luma(g);
        g += P[12].x * smoothstep(0.6, 1.0, l0) * 0.25 + P[13].x * (1.0 - smoothstep(0.0, 0.25, l0)) * 0.15;
        g = g * (1.0 - P[10].x * smoothstep(0.5, 1.0, l0) * 0.4) + P[11].x * (1.0 - smoothstep(0.0, 0.5, l0)) * 0.25;
        // lift / gamma / gain / offset (wheels: rgb = colour push, a = master)
        let lift = P[0].rgb + P[0].a;
        let gam = P[1].rgb + P[1].a;
        let gain = P[2].rgb + P[2].a;
        if (P[15].x > 0.5) {
            // log-style wheels: shadows/mids/highlights ranges
            let l = luma(g);
            g += lift * (1.0 - smoothstep(0.0, 0.33, l)) + gam * (1.0 - abs(l - 0.5) * 2.0) * 0.5 + gain * smoothstep(0.55, 1.0, l);
        } else {
            g = g * (1.0 + gain) + lift * (1.0 - g);
            g = pow(max(g, vec3<f32>(0.0)), vec3<f32>(1.0) / max(vec3<f32>(1.0) + gam, vec3<f32>(0.05)));
        }
        g += P[3].rgb + P[3].a;
        // contrast around pivot
        g = (g - P[6].x) * P[5].x + P[6].x;
        g = temp_tint(g, P[8].x, P[9].x);
        // vibrance + saturation
        let mx = max(g.r, max(g.g, g.b));
        let mn = min(g.r, min(g.g, g.b));
        g = sat(g, (1.0 + P[14].x * (1.0 - (mx - mn))) * P[7].x);
        // hue curves (rows 4..7) — identity curves map to 0.5 offsets
        var hsv = rgb2hsv(clamp(g, vec3<f32>(0.0), vec3<f32>(1.0)));
        let hh = curve(4.0, hsv.x) - hsv.x;
        let hs = curve(5.0, hsv.x) * 2.0;
        let hl = curve(6.0, hsv.x) * 2.0;
        let ls = curve(7.0, hsv.z) * 2.0;
        hsv.x = fract(hsv.x + hh);
        hsv.y = clamp(hsv.y * hs * ls, 0.0, 1.0);
        let o = hsv2rgb(hsv) * hl;
        let keep = max(g - clamp(g, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.0));
        return pre(o + keep, c.a);
    }
    if (k == 58u) { return pre((col - 0.5) * (1.0 + P[1].x) + 0.5 + P[0].x, c.a); }
    if (k == 59u) { return pre(mix(col, 1.0 - col, P[0].x), c.a); }
    if (k == 60u) { return pre(mix(col, P[0].rgb, P[1].x), c.a); }
    if (k == 65u) { // gradient ramp
        let a = rp(P[0].xy) * u.size;
        let b = rp(P[2].xy) * u.size;
        let q = uv * u.size;
        var t = 0.0;
        if (P[4].x > 0.5) { t = length(q - a) / max(length(b - a), 1.0); } else { t = dot(q - a, b - a) / max(dot(b - a, b - a), 1.0); }
        let g = mix(P[1], P[3], clamp(t, 0.0, 1.0));
        let gp = vec4<f32>(g.rgb * g.a, g.a);
        let ramp = vec4<f32>(gp.rgb, gp.a) * c.a;
        return mix(ramp, c, P[5].x);
    }
    // ----- keying
    if (k == 61u) {
        let key = P[0].rgb;
        // Chroma distance in YCbCr space.
        let toY = mat3x3<f32>(vec3<f32>(0.299, -0.169, 0.5), vec3<f32>(0.587, -0.331, -0.419), vec3<f32>(0.114, 0.5, -0.081));
        let a = (toY * col).yz;
        let b = (toY * key).yz;
        let d = length(a - b);
        let t = P[1].x * 0.5;
        var alpha = smoothstep(t, t + P[2].x * 0.5 + 1e-4, d);
        alpha = clamp(alpha + P[4].x * -0.5 * (1.0 - alpha) * alpha * 4.0, 0.0, 1.0);
        // spill suppression: limit the key's dominant channel to the average of the others.
        var o = col;
        if (key.g >= key.b && key.g >= key.r) { o.g = mix(o.g, min(o.g, (o.r + o.b) * 0.5), P[3].x); }
        else if (key.b >= key.r) { o.b = mix(o.b, min(o.b, (o.r + o.g) * 0.5), P[3].x); }
        else { o.r = mix(o.r, min(o.r, (o.g + o.b) * 0.5), P[3].x); }
        return pre(o, c.a * alpha);
    }
    if (k == 62u) {
        let l = luma(col);
        var a = smoothstep(P[0].x, P[0].x + P[1].x + 1e-4, l);
        if (P[2].x > 0.5) { a = 1.0 - smoothstep(1.0 - P[0].x - P[1].x - 1e-4, 1.0 - P[0].x, l); }
        return pre(col, c.a * a);
    }
    if (k == 63u) {
        var o = col;
        let key = P[0].rgb;
        if (key.g >= key.b && key.g >= key.r) { o.g = mix(o.g, min(o.g, (o.r + o.b) * 0.5), P[1].x); }
        else if (key.b >= key.r) { o.b = mix(o.b, min(o.b, (o.r + o.g) * 0.5), P[1].x); }
        else { o.r = mix(o.r, min(o.r, (o.g + o.b) * 0.5), P[1].x); }
        return pre(o, c.a);
    }
    if (k == 64u) { // matte choker on a pre-blurred alpha (host blurs t_a, original in t_b)
        let o = sb(uv);
        var a = clamp((c.a - 0.5) * (1.0 + abs(P[0].x) * 4.0) + 0.5 - P[0].x * 0.5, 0.0, 1.0);
        a = pow(a, P[2].x);
        return pre(unp(o), min(a, 1.0));
    }
    if (k == 71u) { // multiply by mask coverage in t_b.r (mask covers the content area only)
        let suv = (uv * u.size - u.pad) / u.content;
        if (!inb(suv)) { return vec4<f32>(0.0); }
        return c * textureSampleLevel(t_b, samp, suv, 0.0).r;
    }

    // ----- generators (ignore input)
    let q = uv * u.size / max(sc, 1e-4);
    if (k == 80u) { // grid
        let s = max(P[0].x, 2.0);
        let w = P[1].x * 0.5;
        let g = fract(q / s) * s;
        let line = step(g.x, w) + step(s - w, g.x) + step(g.y, w) + step(s - w, g.y);
        let a = clamp(line, 0.0, 1.0) * P[2].a;
        return vec4<f32>(P[2].rgb * a, a);
    }
    if (k == 81u) { // noise
        let n = fbm(q / max(P[0].x, 1.0) + vec2<f32>(P[1].x * 0.05), i32(P[2].x));
        let v = clamp((n - 0.5) * P[3].x + 0.5, 0.0, 1.0);
        return vec4<f32>(vec3<f32>(v), 1.0);
    }
    if (k == 82u) { // wave lines
        var a = 0.0;
        let lines = max(P[3].x, 1.0);
        for (var i = 0.0; i < 32.0; i += 1.0) {
            if (i >= lines) { break; }
            let y0 = (i + 0.5) / lines * (u.size.y / sc);
            let y = y0 + sin(q.x / max(P[1].x, 1.0) * 2.0 * PI + u.time * P[2].x * 2.0 * PI + i * 0.7) * P[0].x;
            a = max(a, 1.0 - smoothstep(P[4].x * 0.5, P[4].x * 0.5 + 1.0, abs(q.y - y)));
        }
        return vec4<f32>(P[5].rgb * a * P[5].a, a * P[5].a);
    }
    if (k == 83u) { // gradient
        let a = P[2].x * PI / 180.0;
        let d = vec2<f32>(sin(a), -cos(a));
        let t = clamp(dot(uv - 0.5, d) + 0.5, 0.0, 1.0);
        let g = mix(P[0], P[1], t);
        return vec4<f32>(g.rgb * g.a, g.a);
    }
    if (k == 84u) { // checkerboard
        let s = max(P[0].x, 1.0);
        let f = (floor(q.x / s) + floor(q.y / s)) % 2.0;
        let g = mix(P[1], P[2], abs(f));
        return vec4<f32>(g.rgb * g.a, g.a);
    }
    if (k == 85u) { // animated background
        let sc2 = max(P[3].x, 1.0);
        let t = u.time * P[2].x;
        let n1 = fbm(q / sc2 + vec2<f32>(t, t * 0.6), 4);
        let n2 = fbm(q / sc2 * 1.7 - vec2<f32>(t * 0.8, -t * 0.3) + n1, 4);
        let g = mix(P[0], P[1], smoothstep(0.3, 0.8, n2));
        return vec4<f32>(g.rgb * g.a, g.a);
    }
    if (k == 86u) { // import: straight-alpha source (t_a) -> premultiplied, with padding
        let suv = (uv * u.size - u.pad) / u.content;
        if (!inb(suv)) { return vec4<f32>(0.0); }
        let s = textureSampleLevel(t_a, samp, suv, 0.0);
        if ((u.flags & 2u) != 0u) { return s; } // already premultiplied
        return vec4<f32>(s.rgb * s.a, s.a);
    }
    if (k == 87u) { // solid fill of the content area
        let suv = (uv * u.size - u.pad) / u.content;
        if (!inb(suv)) { return vec4<f32>(0.0); }
        return vec4<f32>(P[0].rgb * P[0].a, P[0].a);
    }
    if (k == 88u) { // final output: premultiplied -> straight (for export / preview)
        if (c.a <= 0.0) { return vec4<f32>(0.0); }
        return vec4<f32>(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(c.a, 0.0, 1.0));
    }
    if (k == 89u) { // multiply by scalar opacity (transitions)
        return c * P[0].x;
    }
    return c;
}
