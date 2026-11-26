//! VEYRA rendering engine: GPU compositing (wgpu/WGSL), CPU vector rasterisation, meshes,
//! colour tools and the frame cache.

pub mod cache;
pub mod color;
pub mod gpu;
pub mod mesh;
pub mod raster;
pub mod renderer;

pub use gpu::Gpu;
pub use renderer::{Image, RenderOptions, Renderer};
