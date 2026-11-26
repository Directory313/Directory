// Physically based (metallic/roughness, GGX) mesh shading with up to 8 lights.

struct Light {
    pos: vec4<f32>,     // xyz position, w = kind (0 point, 1 directional, 2 spot, 3 area, 4 ambient, 5 environment)
    dir: vec4<f32>,     // xyz direction the light points to
    color: vec4<f32>,   // rgb * intensity
    params: vec4<f32>,  // range, cos inner, cos outer, falloff
};

struct M {
    model: mat4x4<f32>,
    view_proj: mat4x4<f32>,
    normal_m: mat4x4<f32>,
    cam_pos: vec4<f32>,
    base: vec4<f32>,
    emission: vec4<f32>,
    pbr: vec4<f32>,     // metallic, roughness, specular, lit
    uvt: vec4<f32>,     // tiling.xy, offset.zw
    misc: vec4<f32>,    // opacity, light count, has texture, wireframe
    lights: array<Light, 8>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var t_base: texture_2d<f32>;
@group(0) @binding(2) var<uniform> m: M;

struct VIn { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32> };
struct VOut { @builtin(position) clip: vec4<f32>, @location(0) wpos: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32> };

@vertex
fn vs(v: VIn) -> VOut {
    var o: VOut;
    let w = m.model * vec4<f32>(v.pos, 1.0);
    o.wpos = w.xyz;
    o.n = normalize((m.normal_m * vec4<f32>(v.nrm, 0.0)).xyz);
    o.uv = v.uv * m.uvt.xy + m.uvt.zw;
    o.clip = m.view_proj * w;
    return o;
}

const PI: f32 = 3.14159265;

fn ggx(n: vec3<f32>, h: vec3<f32>, r: f32) -> f32 {
    let a = r * r;
    let a2 = a * a;
    let nh = max(dot(n, h), 0.0);
    let d = nh * nh * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d + 1e-6);
}
fn smith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, r: f32) -> f32 {
    let k = (r + 1.0) * (r + 1.0) / 8.0;
    let nv = max(dot(n, v), 0.0);
    let nl = max(dot(n, l), 0.0);
    return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}
fn fresnel(c: f32, f0: vec3<f32>) -> vec3<f32> { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    var base = m.base;
    if (m.misc.z > 0.5) { base = base * textureSample(t_base, samp, in.uv); }
    let opacity = m.misc.x * base.a;
    if (m.pbr.w < 0.5) {
        let c = base.rgb + m.emission.rgb;
        return vec4<f32>(c * opacity, opacity);
    }
    var n = normalize(in.n);
    let v = normalize(m.cam_pos.xyz - in.wpos);
    // Double-sided shading: orient the normal toward the viewer. (The y-down projection
    // flips winding, so `front_facing` is not a reliable cue here.)
    if (dot(n, v) < 0.0) { n = -n; }
    let metallic = clamp(m.pbr.x, 0.0, 1.0);
    let rough = clamp(m.pbr.y, 0.04, 1.0);
    let f0 = mix(vec3<f32>(0.08 * m.pbr.z), base.rgb, metallic);
    var color = vec3<f32>(0.0);
    var has_ambient = false;
    let count = u32(m.misc.y);
    for (var i = 0u; i < 8u; i++) {
        if (i >= count) { break; }
        let L = m.lights[i];
        let kind = u32(L.pos.w + 0.5);
        if (kind == 4u || kind == 5u) {
            has_ambient = true;
            // Ambient / simple hemispherical environment.
            var amb = L.color.rgb;
            if (kind == 5u) { amb = mix(L.color.rgb * 0.4, L.color.rgb, n.y * -0.5 + 0.5); }
            color += amb * base.rgb * (1.0 - metallic) + amb * f0 * 0.25;
            continue;
        }
        var l = vec3<f32>(0.0);
        var atten = 1.0;
        if (kind == 1u) {
            l = normalize(-L.dir.xyz);
        } else {
            let d = L.pos.xyz - in.wpos;
            let dist = length(d);
            l = d / max(dist, 1e-4);
            let range = max(L.params.x, 1.0);
            atten = pow(clamp(1.0 - dist / range, 0.0, 1.0), max(L.params.w, 0.01));
            if (kind == 2u) {
                let cd = dot(-l, normalize(L.dir.xyz));
                atten *= smoothstep(L.params.z, L.params.y, cd);
            }
            if (kind == 3u) { atten *= 1.25; }
        }
        let h = normalize(l + v);
        let nl = max(dot(n, l), 0.0);
        let F = fresnel(max(dot(h, v), 0.0), f0);
        let spec = ggx(n, h, rough) * smith(n, v, l, rough) * F / (4.0 * max(dot(n, v), 0.0) * nl + 1e-4);
        let kd = (1.0 - F) * (1.0 - metallic);
        color += (kd * base.rgb / PI + spec) * L.color.rgb * nl * atten * PI;
    }
    if (!has_ambient) { color += base.rgb * 0.03; }
    color += m.emission.rgb;
    return vec4<f32>(color * opacity, opacity);
}
