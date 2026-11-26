# Known Limitations — VEYRA Beta

These are real gaps, not hidden behind placeholder controls. Items are grouped by area.

## Not implemented
* **Plugin / extension system.** Effects are defined in an internal registry; there is no
  third-party plugin API, sandbox, installer or plugin manager yet.
* **Planar tracking, camera (3D) tracking, rolling-shutter correction.** Point and
  multi-point tracking (with track-to-null and stabilisation) are implemented.
* **AI subject segmentation.** Manual masks and keying only.
* **Timeline interchange import** (XML/FCPXML/OTIO/EDL import). OTIO and EDL *export* work.
* **3D mesh editing** (vertex/edge/face selection, normal editing, bevel, subdivision).
  Primitives, imported meshes and extrusion are supported; geometry is not editable in-app.
* **Shadows, reflections, ambient occlusion and environment maps** in the 3D renderer.
  Lighting is GGX PBR with up to 8 lights and ambient/environment *fill* light.
* **ACES / OpenColorIO and HDR output.** Colour spaces are tagged on export; compositing is
  display-referred (gamma-space) as in After Effects' default mode.
* **Audio scrubbing**, live audio metering from the output bus, multichannel beyond stereo.
* **Cloud features** (accounts, sync). VEYRA is fully local by design.
* **Additional UI languages** (English only).

## Partial
* **Output precision**: compositing is 16-bit float but the final stage is 8-bit RGBA, so
  10/12-bit and EXR exports carry 8-bit source precision.
* **3D ordering**: 3D layers are depth-sorted as planes (painter's algorithm); meshes have
  their own depth buffer per layer, so a mesh and a 3D plane that intersect are not split.
  Motion blur and depth of field apply to 3D planes, not to meshes.
* **Materials**: base colour texture only (no normal/roughness/metallic maps).
* **glTF / Blender import**: static geometry, hierarchy transforms, base colour/metallic/
  roughness, cameras and punctual lights. Node animation and skinning are not transferred
  (reported on import). The Blender bridge needs Blender installed and was **not tested on
  the build machine** (Blender was not installed there).
* **Boolean shape operations** are pixel-based (coverage combine), not path-based; path
  merging/subdivision tools are not provided. SVG files import as resolution-independent
  rasters, not as editable vector paths. PSD imports flattened.
* **Text**: one style per layer (no mixed styles within a layer); text-on-path follows a
  flattened path; per-character blur is not available.
* **Expressions**: a purpose-built safe language (not JavaScript). `layer(name, prop)`
  reads another layer's keyframed (not expression) value.
* **Audio effects**: parameters are static (volume and pan are keyframeable).
* **Preview audio** is a pre-mixed WAV regenerated after audio-affecting edits; there can be
  a short delay before edited audio is heard.
* **Cache invalidation** is per-layer-and-time-range; edits to a parent, matte or an
  expression-referenced layer invalidate all frames of dependent layers.
* **3D viewport gizmos**: 3D layers are moved with the inspector/timeline; the viewer shows a
  2D bounding box (approximate for perspective) and an orbit tool for the active camera.
* **Proxies** are H.264 only.

## Platform
* Windows 10/11 x64 only. Requires the WebView2 runtime (bundled bootstrapper in the installer).
* On machines without a DirectX 12/Vulkan GPU, rendering uses the WARP software rasteriser
  and is much slower.
