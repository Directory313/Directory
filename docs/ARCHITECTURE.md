# VEYRA Architecture

VEYRA is a Tauri 2 desktop application. All media processing, evaluation, rendering and
encoding happen in Rust; the React/TypeScript frontend is a thin editing UI that owns the
project document and sends it to the engine.

```
┌──────────────────────────── ui/ (React + TypeScript, Vite) ────────────────────────────┐
│ store/editor.ts  immutable Project (immer) · undo/redo · selection · playback state     │
│ lib/api.ts       typed wrappers for every Tauri command and event                      │
│ lib/ops.ts       shared edit operations · lib/actions.ts  command + shortcut registry   │
│ components/      shell (top bar, docking workspaces, home, dialogs) · media · library   │
│                  viewer (+ playback engine, on-canvas tools) · inspector · timeline ·   │
│                  graph editor · scopes · mixer · render queue · hierarchy              │
└───────────────▲─────────────────────────────────────────────┬──────────────────────────┘
                │ events (export-progress, cache-progress, …)  │ invoke (sync_project, render_frame, …)
┌───────────────┴──────────── src-tauri/ (app shell, commands) ▼──────────────────────────┐
│ state.rs (AppState: project, revision, renderer, frame cache, jobs, settings)           │
│ commands.rs (≈70 commands) · tracking.rs (NCC point tracker) · sys.rs (RAM/disk/Blender)│
└──────┬──────────────────┬─────────────────────┬──────────────────────┬──────────────────┘
       │                  │                     │                      │
 veyra-core          veyra-media           veyra-render           veyra-export
 model, Prop<T>      bundled FFmpeg        wgpu device + WGSL     codecs/presets,
 keyframes, bezier   discovery, probe,     effects, compositor,   alpha validation,
 expressions,        decoder pool,         tiny-skia raster       audio mix graph,
 transforms, camera, thumbnails,           (text/shapes/masks/    render→encode jobs,
 parenting, effect   waveforms, proxies,   particles/SVG), 3D     output validation
 registry, project   HW capability probe   meshes + PBR, frame
 I/O, ops, interop                         cache (RAM + disk)
```

## Data model (`crates/veyra-core/src/model.rs`)

* `Project` → `Composition[]` → `Layer[]` (index 0 is the top layer). Assets are project-wide.
* Every animatable value is a `Prop<T>` = static `value` + optional `keys` + optional `expr`.
  Keyframe times are **layer-local seconds**, so moving a layer moves its animation.
* `LayerKind` covers media, audio, solid, text, shape, null, adjustment, nested comp /
  compound clip, camera, light, mesh, particles and generators.
* Effects are `{kind, params: Map<key, Prop<ParamValue>>}` and are described by the
  registry (`registry.rs`). The inspector, keyframing, expressions and the GPU parameter
  block are all derived from the registry, so a new effect is automatically keyframeable.
* The TypeScript mirror is `ui/src/types/project.ts`.

## Evaluation

`veyra-core::eval` evaluates props (keyframes, then expressions), layer transforms
`T(position)·Rz·Ry·Rx·S·T(-anchor)`, parent chains (cycle-safe), camera matrices
(AE-compatible default camera so z = 0 is 1:1) and source-time mapping (speed, reverse,
freeze, time-remap). The expression language (`expr.rs`) is a sandboxed interpreter with
vector maths, `wiggle`, `loopOut`, `linear/ease`, `valueAt`, `layer(name, prop)` and an
evaluation budget; errors fall back to the keyframed value and are reported to the UI.

## Rendering (`crates/veyra-render`)

Per frame, per composition, bottom layer to top:

1. **Source**: decoded media frame (FFmpeg pipe, sized to preview scale) · CPU-rasterised
   text/shapes/particles/SVG (tiny-skia, premultiplied) · generator shader · nested comp
   (recursive render).
2. **Import** into a padded Rgba16Float layer texture (padding = what effects need to spill).
3. **Masks**: combined coverage (add/subtract/intersect/difference/lighten/darken, feather,
   expansion, opacity, invert) rasterised on the CPU, multiplied on the GPU.
4. **Effects**: WGSL uber-shader passes in stack order; multi-pass effects (blur, glow,
   shadows, unsharp, choke) are composed by the host; curves/LUTs use textures.
5. **Placement**: transformed quad (2D ortho or 3D camera), motion blur by sub-frame
   accumulation, depth-of-field blur by focal distance, transition modulation.
6. **Blend** into the accumulator with track matte and one of 16 blend modes (W3C formulas
   on premultiplied colour). Adjustment layers mix an effected copy of the accumulator.

3D: runs of consecutive 3D layers are depth-sorted; meshes (primitives, glTF/OBJ, extruded
text/shapes via lyon) render with a depth buffer and GGX PBR shading with up to 8 lights.
The GPU adapter falls back to Microsoft WARP when no hardware adapter is usable.

## Caching

`ops::CacheKeys` hashes each layer (plus dependencies: assets, nested comps, parents, mattes,
expression references). A frame key = comp settings + scale + time + hashes of layers active
at that time, so an edit only invalidates frames where the edited layer appears. Frames live
in a RAM LRU (byte budget) that spills to a disk tier. `prerender` fills the cache in the
background; newer requests cancel older ones.

## Media

FFmpeg/ffprobe are bundled in `resources/ffmpeg` and located at runtime (resource dir → exe
dir → dev path → PATH as last resort). Each (file, size) gets a persistent decoder process
that streams RGBA; forward playback reads sequentially, jumps restart with an accurate seek;
VFR footage is conformed to CFR with the `fps` filter. Stills are cached.

## Export

Frames are rendered on the GPU and piped to FFmpeg on a writer thread (render and encode
overlap). Audio is mixed by an FFmpeg filter graph built from the timeline (trim, speed,
reverse, volume automation as a piecewise expression, pan, fades, audio-effect chain, nested
comps). Output is written to a temporary name, renamed on success, then probed to verify
size, duration, audio presence and — for alpha exports — an alpha pixel format. Requesting
alpha from a codec that cannot store it is a validation error, never a silent drop.

## Project safety

Saves are atomic (temp file + fsync + rename) with rotating backups and a round-trip parse
check. Autosave writes to a separate recovery folder. A session lock file detects crashes
and the home screen offers recovery. Schema versioning with a migration hook; newer files
are refused rather than misread. Media is resolved relative-first for portable projects.
