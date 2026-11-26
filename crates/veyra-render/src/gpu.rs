//! wgpu device, pipelines, texture pooling, uploads and readback.

use bytemuck::{Pod, Zeroable};
use parking_lot::Mutex;
use std::sync::Arc;
use wgpu::util::DeviceExt;

#[cfg(test)]
mod shader_tests {
    /// Parse + validate every WGSL module offline so shader errors fail fast with context.
    #[test]
    fn shaders_validate() {
        use wgpu::naga;
        for (name, src) in [
            ("effects", include_str!("shaders/effects.wgsl")),
            ("composite", include_str!("shaders/composite.wgsl")),
            ("mesh", include_str!("shaders/mesh.wgsl")),
        ] {
            let module = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(src)));
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
                .validate(&module)
                .unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(src)));
        }
    }
}

/// Count of uncaptured GPU validation errors (tests assert this stays zero).
pub static GPU_ERRORS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static LAST_GPU_ERROR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub const WORK: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
pub const OUT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
pub const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

#[derive(Debug, thiserror::Error)]
pub enum GpuError {
    #[error("no usable graphics adapter (GPU or software fallback) was found")]
    NoAdapter,
    #[error("graphics device error: {0}")]
    Device(String),
}

pub struct Tex {
    pub tex: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub w: u32,
    pub h: u32,
    pub format: wgpu::TextureFormat,
}

pub type TexRef = Arc<Tex>;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct EffU {
    pub kind: u32,
    pub flags: u32,
    pub time: f32,
    pub scale: f32,
    pub size: [f32; 2],
    pub content: [f32; 2],
    pub pad: [f32; 2],
    pub seed: f32,
    pub intensity: f32,
    pub p: [[f32; 4]; 24],
}

impl Default for EffU {
    fn default() -> Self {
        Zeroable::zeroed()
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LayerU {
    pub mvp: [[f32; 4]; 4],
    pub size: [f32; 2],
    pub origin: [f32; 2],
    pub opacity: f32,
    pub wipe_kind: u32,
    pub wipe: f32,
    pub feather: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BlendU {
    pub mode: u32,
    pub matte: u32,
    pub adjust: u32,
    pub opacity: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct LightU {
    pub pos: [f32; 4],
    pub dir: [f32; 4],
    pub color: [f32; 4],
    pub params: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MeshU {
    pub model: [[f32; 4]; 4],
    pub view_proj: [[f32; 4]; 4],
    pub normal_m: [[f32; 4]; 4],
    pub cam_pos: [f32; 4],
    pub base: [f32; 4],
    pub emission: [f32; 4],
    pub pbr: [f32; 4],
    pub uvt: [f32; 4],
    pub misc: [f32; 4],
    pub lights: [LightU; 8],
}

pub struct GpuMesh {
    pub vb: wgpu::Buffer,
    pub ib: wgpu::Buffer,
    pub count: u32,
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_name: String,
    pub backend: String,
    pub software: bool,
    pub max_texture: u32,
    sampler: wgpu::Sampler,
    sampler_repeat: wgpu::Sampler,
    fx_layout: wgpu::BindGroupLayout,
    fx_pipeline: wgpu::RenderPipeline,
    out_pipeline: wgpu::RenderPipeline,
    layer_layout: wgpu::BindGroupLayout,
    layer_over: wgpu::RenderPipeline,
    layer_add: wgpu::RenderPipeline,
    blend_layout: wgpu::BindGroupLayout,
    blend_pipeline: wgpu::RenderPipeline,
    mesh_layout: wgpu::BindGroupLayout,
    mesh_pipeline: wgpu::RenderPipeline,
    mesh_wire: Option<wgpu::RenderPipeline>,
    pub identity_curves: TexRef,
    pub identity_lut: TexRef,
    pub white: TexRef,
    pool: Mutex<Vec<Tex>>,
}

fn tex_entry(binding: u32, dim: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: dim, multisampled: false },
        count: None,
    }
}
fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }
}
fn uniform_entry(binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: vis, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }
}

const PREMUL_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
};
const ADDITIVE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
};

pub fn f32_to_f16(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let exp = ((x >> 23) & 0xff) as i32 - 127 + 15;
    let mant = x & 0x7fffff;
    if exp <= 0 {
        return sign;
    }
    if exp >= 31 {
        return sign | 0x7c00;
    }
    sign | ((exp as u16) << 10) | ((mant >> 13) as u16)
}

impl Gpu {
    pub fn new() -> Result<Self, GpuError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN, ..Default::default() });
        let pick = |fallback: bool| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: fallback,
                compatible_surface: None,
            }))
            .ok()
        };
        let forced_sw = std::env::var("VEYRA_SOFTWARE_RENDER").is_ok();
        let adapter = if forced_sw { pick(true) } else { pick(false).or_else(|| pick(true)) }.ok_or(GpuError::NoAdapter)?;
        let info = adapter.get_info();
        let software = info.device_type == wgpu::DeviceType::Cpu;
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("veyra"),
            required_features: adapter.features() & wgpu::Features::POLYGON_MODE_LINE,
            required_limits: wgpu::Limits { max_texture_dimension_2d: limits.max_texture_dimension_2d, ..wgpu::Limits::downlevel_defaults() },
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|e| GpuError::Device(e.to_string()))?;
        device.on_uncaptured_error(Box::new(|e| {
            GPU_ERRORS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            log::error!("wgpu: {e}");
            if let Ok(mut last) = LAST_GPU_ERROR.lock() {
                *last = format!("{e:?}");
            }
        }));

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let sampler_repeat = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            ..Default::default()
        });
        let fx_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("effects"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/effects.wgsl").into()) });
        let comp_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("composite"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/composite.wgsl").into()) });
        let mesh_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("mesh"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/mesh.wgsl").into()) });

        let fx_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fx"),
            entries: &[
                sampler_entry(0),
                tex_entry(1, wgpu::TextureViewDimension::D2),
                tex_entry(2, wgpu::TextureViewDimension::D2),
                uniform_entry(3, wgpu::ShaderStages::FRAGMENT),
                tex_entry(4, wgpu::TextureViewDimension::D2),
                tex_entry(5, wgpu::TextureViewDimension::D3),
            ],
        });
        let layer_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer"),
            entries: &[sampler_entry(0), tex_entry(1, wgpu::TextureViewDimension::D2), uniform_entry(2, wgpu::ShaderStages::VERTEX_FRAGMENT)],
        });
        let blend_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blend"),
            entries: &[
                sampler_entry(0),
                tex_entry(1, wgpu::TextureViewDimension::D2),
                tex_entry(2, wgpu::TextureViewDimension::D2),
                tex_entry(3, wgpu::TextureViewDimension::D2),
                uniform_entry(4, wgpu::ShaderStages::FRAGMENT),
            ],
        });
        let mesh_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mesh"),
            entries: &[sampler_entry(0), tex_entry(1, wgpu::TextureViewDimension::D2), uniform_entry(2, wgpu::ShaderStages::VERTEX_FRAGMENT)],
        });
        let pl = |l: &wgpu::BindGroupLayout| device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[l], push_constant_ranges: &[] });
        let fullscreen = |module: &wgpu::ShaderModule, layout: &wgpu::PipelineLayout, vs: &str, fs: &str, format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(fs),
                layout: Some(layout),
                vertex: wgpu::VertexState { module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview: None,
                cache: None,
            })
        };
        let fx_pl = pl(&fx_layout);
        let fx_pipeline = fullscreen(&fx_mod, &fx_pl, "vs", "fs", WORK, None);
        let out_pipeline = fullscreen(&fx_mod, &fx_pl, "vs", "fs", OUT, None);
        let layer_pl = pl(&layer_layout);
        let layer_over = fullscreen(&comp_mod, &layer_pl, "vs_layer", "fs_layer", WORK, Some(PREMUL_OVER));
        let layer_add = fullscreen(&comp_mod, &layer_pl, "vs_layer", "fs_layer", WORK, Some(ADDITIVE));
        let blend_pl = pl(&blend_layout);
        let blend_pipeline = fullscreen(&comp_mod, &blend_pl, "vs_full", "fs_blend", WORK, None);

        let mesh_pl = pl(&mesh_layout);
        let make_mesh = |mode: wgpu::PolygonMode| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("mesh"),
                layout: Some(&mesh_pl),
                vertex: wgpu::VertexState {
                    module: &mesh_mod,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<crate::mesh::Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
                    }],
                },
                primitive: wgpu::PrimitiveState { cull_mode: None, polygon_mode: mode, ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &mesh_mod,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: WORK, blend: Some(PREMUL_OVER), write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview: None,
                cache: None,
            })
        };
        let mesh_pipeline = make_mesh(wgpu::PolygonMode::Fill);
        let mesh_wire = device.features().contains(wgpu::Features::POLYGON_MODE_LINE).then(|| make_mesh(wgpu::PolygonMode::Line));

        let max_texture = device.limits().max_texture_dimension_2d;
        let identity_curves = {
            let t = create_tex(&device, max_texture, 256, 8, wgpu::TextureFormat::Rgba8Unorm);
            write_tex(&queue, &t, &curves_bytes(&crate::color::identity_curve_rows()));
            Arc::new(t)
        };
        let identity_lut = Arc::new(create_lut(&device, &queue, 2, &crate::color::identity_lut(2)));
        let white = {
            let t = create_tex(&device, max_texture, 1, 1, wgpu::TextureFormat::Rgba8Unorm);
            write_tex(&queue, &t, &[255, 255, 255, 255]);
            Arc::new(t)
        };
        let gpu = Self {
            adapter_name: info.name.clone(),
            backend: format!("{:?}", info.backend),
            software,
            max_texture,
            device,
            queue,
            sampler,
            sampler_repeat,
            fx_layout,
            fx_pipeline,
            out_pipeline,
            layer_layout,
            layer_over,
            layer_add,
            blend_layout,
            blend_pipeline,
            mesh_layout,
            mesh_pipeline,
            mesh_wire,
            identity_curves,
            identity_lut,
            white,
            pool: Mutex::new(Vec::new()),
        };
        log::info!("GPU: {} ({}){}", gpu.adapter_name, gpu.backend, if software { " [software fallback]" } else { "" });
        Ok(gpu)
    }

    pub fn new_texture(&self, w: u32, h: u32, format: wgpu::TextureFormat) -> Tex {
        create_tex(&self.device, self.max_texture, w, h, format)
    }

    /// Get a texture from the pool (or allocate). Contents are undefined.
    pub fn acquire(&self, w: u32, h: u32, format: wgpu::TextureFormat) -> Tex {
        let (w, h) = (w.clamp(1, self.max_texture), h.clamp(1, self.max_texture));
        let mut pool = self.pool.lock();
        if let Some(i) = pool.iter().position(|t| t.w == w && t.h == h && t.format == format) {
            return pool.swap_remove(i);
        }
        drop(pool);
        self.new_texture(w, h, format)
    }

    pub fn release(&self, t: Tex) {
        let mut pool = self.pool.lock();
        pool.push(t);
        // Bound pooled memory: keep the most recent 40 textures.
        if pool.len() > 40 {
            let n = pool.len() - 40;
            pool.drain(0..n);
        }
    }

    pub fn trim_pool(&self) {
        self.pool.lock().clear();
    }

    pub fn upload_rgba8(&self, w: u32, h: u32, data: &[u8], format: wgpu::TextureFormat) -> Tex {
        let t = self.acquire(w, h, format);
        self.write_rgba8(&t, data);
        t
    }

    pub fn write_rgba8(&self, t: &Tex, data: &[u8]) {
        write_tex(&self.queue, t, data);
    }

    pub fn curves_texture(&self, rows: &[[u8; 256]; 8]) -> Tex {
        let t = self.new_texture(256, 8, wgpu::TextureFormat::Rgba8Unorm);
        self.write_rgba8(&t, &curves_bytes(rows));
        t
    }

    /// 3D LUT texture from `n³` RGBA float values (r fastest).
    pub fn lut_texture(&self, n: u32, rgba: &[f32]) -> Tex {
        create_lut(&self.device, &self.queue, n, rgba)
    }
}

fn create_tex(device: &wgpu::Device, max: u32, w: u32, h: u32, format: wgpu::TextureFormat) -> Tex {
    let (w, h) = (w.clamp(1, max), h.clamp(1, max));
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = tex.create_view(&Default::default());
    Tex { tex, view, w, h, format }
}

fn write_tex(queue: &wgpu::Queue, t: &Tex, data: &[u8]) {
    let bpp = if t.format == wgpu::TextureFormat::R8Unorm { 1 } else { 4 };
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &t.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        &data[..(t.w * t.h * bpp) as usize],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(t.w * bpp), rows_per_image: Some(t.h) },
        wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 },
    );
}

fn curves_bytes(rows: &[[u8; 256]; 8]) -> Vec<u8> {
    let mut data = vec![0u8; 256 * 8 * 4];
    for (r, row) in rows.iter().enumerate() {
        for (x, v) in row.iter().enumerate() {
            let i = (r * 256 + x) * 4;
            data[i..i + 4].copy_from_slice(&[*v, *v, *v, 255]);
        }
    }
    data
}

fn create_lut(device: &wgpu::Device, queue: &wgpu::Queue, n: u32, rgba: &[f32]) -> Tex {
    {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("lut"),
            size: wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let half: Vec<u8> = rgba.iter().flat_map(|v| f32_to_f16(*v).to_le_bytes()).collect();
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &half,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(n * 8), rows_per_image: Some(n) },
            wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
        );
        let view = tex.create_view(&Default::default());
        Tex { tex, view, w: n, h: n, format: wgpu::TextureFormat::Rgba16Float }
    }
}

impl Gpu {
    fn ubuf<T: Pod>(&self, v: &T) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::bytes_of(v), usage: wgpu::BufferUsages::UNIFORM })
    }

    fn pass<'e>(enc: &'e mut wgpu::CommandEncoder, target: &'e wgpu::TextureView, clear: Option<wgpu::Color>, depth: Option<&'e wgpu::TextureView>) -> wgpu::RenderPass<'e> {
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: clear.map(wgpu::LoadOp::Clear).unwrap_or(wgpu::LoadOp::Load), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: depth.map(|d| wgpu::RenderPassDepthStencilAttachment {
                view: d,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        })
    }

    pub fn clear(&self, enc: &mut wgpu::CommandEncoder, target: &Tex, c: [f64; 4]) {
        let _ = Self::pass(enc, &target.view, Some(wgpu::Color { r: c[0] * c[3], g: c[1] * c[3], b: c[2] * c[3], a: c[3] }), None);
    }

    /// Run one effects-shader pass: `a` (+ optional `b`) -> `target`.
    pub fn effect(&self, enc: &mut wgpu::CommandEncoder, target: &Tex, a: &Tex, b: Option<&Tex>, u: &EffU, curves: Option<&Tex>, lut: Option<&Tex>) {
        let ub = self.ubuf(u);
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.fx_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&a.view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&b.unwrap_or(a).view) },
                wgpu::BindGroupEntry { binding: 3, resource: ub.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&curves.unwrap_or(&self.identity_curves).view) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&lut.unwrap_or(&self.identity_lut).view) },
            ],
        });
        let pipeline = if target.format == OUT { &self.out_pipeline } else { &self.fx_pipeline };
        let mut rp = Self::pass(enc, &target.view, None, None);
        rp.set_pipeline(pipeline);
        rp.set_bind_group(0, &bg, &[]);
        rp.draw(0..3, 0..1);
    }

    /// Draw a layer texture into `target` with a transform (premultiplied over, or additive).
    pub fn draw_layer(&self, enc: &mut wgpu::CommandEncoder, target: &Tex, layer: &Tex, u: &LayerU, clear: bool, additive: bool) {
        let ub = self.ubuf(u);
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.layer_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&layer.view) },
                wgpu::BindGroupEntry { binding: 2, resource: ub.as_entire_binding() },
            ],
        });
        let mut rp = Self::pass(enc, &target.view, clear.then_some(wgpu::Color::TRANSPARENT), None);
        rp.set_pipeline(if additive { &self.layer_add } else { &self.layer_over });
        rp.set_bind_group(0, &bg, &[]);
        rp.draw(0..6, 0..1);
    }

    pub fn blend(&self, enc: &mut wgpu::CommandEncoder, target: &Tex, dst: &Tex, src: &Tex, matte: Option<&Tex>, u: &BlendU) {
        let ub = self.ubuf(u);
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.blend_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dst.view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&src.view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&matte.unwrap_or(&self.white).view) },
                wgpu::BindGroupEntry { binding: 4, resource: ub.as_entire_binding() },
            ],
        });
        let mut rp = Self::pass(enc, &target.view, None, None);
        rp.set_pipeline(&self.blend_pipeline);
        rp.set_bind_group(0, &bg, &[]);
        rp.draw(0..3, 0..1);
    }

    pub fn upload_mesh(&self, m: &crate::mesh::MeshData) -> GpuMesh {
        let vb = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("vb"), contents: bytemuck::cast_slice(&m.vertices), usage: wgpu::BufferUsages::VERTEX });
        let ib = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("ib"), contents: bytemuck::cast_slice(&m.indices), usage: wgpu::BufferUsages::INDEX });
        GpuMesh { vb, ib, count: m.indices.len() as u32 }
    }

    pub fn draw_mesh(&self, enc: &mut wgpu::CommandEncoder, target: &Tex, depth: &Tex, mesh: &GpuMesh, u: &MeshU, tex: Option<&Tex>, wire: bool) {
        let ub = self.ubuf(u);
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.mesh_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&self.sampler_repeat) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&tex.unwrap_or(&self.white).view) },
                wgpu::BindGroupEntry { binding: 2, resource: ub.as_entire_binding() },
            ],
        });
        let mut rp = Self::pass(enc, &target.view, Some(wgpu::Color::TRANSPARENT), Some(&depth.view));
        let pipe = if wire { self.mesh_wire.as_ref().unwrap_or(&self.mesh_pipeline) } else { &self.mesh_pipeline };
        rp.set_pipeline(pipe);
        rp.set_bind_group(0, &bg, &[]);
        rp.set_vertex_buffer(0, mesh.vb.slice(..));
        rp.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint32);
        rp.draw_indexed(0..mesh.count, 0, 0..1);
    }

    pub fn encoder(&self) -> wgpu::CommandEncoder {
        self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None })
    }

    pub fn submit(&self, enc: wgpu::CommandEncoder) {
        self.queue.submit(Some(enc.finish()));
    }

    /// Copy an RGBA8 texture back to the CPU (tightly packed rows).
    pub fn readback(&self, t: &Tex) -> Vec<u8> {
        let bpr = (t.w * 4).div_ceil(256) * 256;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (bpr * t.h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = self.encoder();
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &t.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(t.h) } },
            wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 },
        );
        self.submit(enc);
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = self.device.poll(wgpu::PollType::Wait);
        let mut out = vec![0u8; (t.w * t.h * 4) as usize];
        if let Ok(Ok(())) = rx.recv() {
            let data = slice.get_mapped_range();
            let row = (t.w * 4) as usize;
            for y in 0..t.h as usize {
                out[y * row..(y + 1) * row].copy_from_slice(&data[y * bpr as usize..y * bpr as usize + row]);
            }
        }
        buf.unmap();
        out
    }
}
