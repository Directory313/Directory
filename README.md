# Directory Beta

A GPU-accelerated desktop video editor and motion-graphics application for Windows:
CapCut-style simplicity, After-Effects-style compositing and animation, and
Resolve-style colour tools — built in Rust (Tauri 2, wgpu) with a React/TypeScript UI.

> **Status:** Directory Beta (0.9.0-beta). See [docs/STATUS.md](docs/STATUS.md) for exactly what is
> implemented and tested, and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Highlights

* Drag footage from Explorer and start editing — FFmpeg is bundled; nothing else to install.
* Multitrack layer timeline: trim, split, ripple, slip, slide, roll, speed, reverse, freeze,
  transitions, markers, work area, compound clips and nested compositions.
* Universal keyframing: every property of every layer and effect, linear/bezier/hold,
  graph editor with bezier handles, and a sandboxed expression language.
* 70 GPU effects (WGSL), 16 blend modes, masks, track mattes, adjustment layers, chroma key.
* Text with per-character animators, vector shapes with repeaters and trim paths, particles,
  procedural generators.
* 3D: layers in 3D space, cameras with depth of field, lights, PBR meshes, glTF/OBJ import,
  extruded 3D text and shapes, Blender (.blend) import via a background Blender bridge.
* Colour: primary grade wheels, curves, levels, hue curves, .cube LUTs, scopes.
* Export: H.264/HEVC/AV1/VP9/ProRes/DNxHR/FFV1/image sequences with verified alpha
  (ProRes 4444, VP9, PNG/TIFF/EXR), hardware encoding where available, render queue.
* Project safety: atomic saves, backups, autosave recovery, crash detection, relinking.

## Install

Run `VEYRA_0.9.0_x64-setup.exe` (per-user install, no admin needed) or unzip the portable
build and run `Directory.exe`. Windows 10/11 x64 with the Edge WebView2 runtime (preinstalled on
current Windows). A DirectX 12 or Vulkan GPU is recommended; Directory falls back to software
rendering (WARP) when none is available.

## Build from source

Requirements: Rust (stable, MSVC), Visual Studio 2022 Build Tools (C++ workload + Windows
SDK), Node.js 20+.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-ffmpeg.ps1   # bundle the media engine
cd ui; npm ci; cd ..
cargo test --workspace --exclude veyra                              # engine tests (GPU + FFmpeg)
cd ui; npx tauri dev                                                # run in development
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1  # installers + portable zip
```

Outputs land in `release/` (NSIS installer, MSI, portable ZIP).

### Building on GitHub (no local build files)

`.github/workflows/build.yml` builds the installer on GitHub Actions:

- **New version:** bump `version` in `src-tauri/tauri.conf.json`, commit, then push a matching tag
  (`git tag v0.9.2; git push origin v0.9.2`). The installer is published as a GitHub Release.
- **Test build:** Actions tab → "Build installer" → "Run workflow". The installer is attached to
  the run under "Artifacts" for 7 days; nothing is published.

After a version is published, the local `target/` folder (several GB) can be deleted safely.

## Repository layout

| Path | Contents |
|------|----------|
| `crates/veyra-core` | Project model, animation engine, expressions, transforms, effect registry, project I/O |
| `crates/veyra-media` | Bundled FFmpeg discovery, probing, decoding, thumbnails, waveforms, proxies |
| `crates/veyra-render` | wgpu renderer, WGSL shaders, vector raster, meshes, colour, frame cache |
| `crates/veyra-export` | Codecs/presets, alpha validation, audio mixdown, export jobs |
| `src-tauri` | Desktop shell, commands, tracking, Blender bridge, packaging config |
| `ui` | React/TypeScript frontend |
| `docs` | Architecture, user guide, shortcuts, formats, status, limitations, troubleshooting |
| `scripts` | FFmpeg setup and release build |

## Documentation

* [Architecture](docs/ARCHITECTURE.md) · [User guide](docs/USER_GUIDE.md) ·
  [Keyboard shortcuts](docs/SHORTCUTS.md) · [Export formats](docs/EXPORT_FORMATS.md)
* [Feature status & test report](docs/STATUS.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md) ·
  [Troubleshooting](docs/TROUBLESHOOTING.md) · [Dependencies & licences](docs/DEPENDENCIES.md)

## Licence

Directory source: GPL-3.0-or-later. The bundled FFmpeg build is GPL (see
`src-tauri/resources/ffmpeg/LICENSE-FFmpeg.txt`); its source is available from ffmpeg.org and
the build's provenance is described in `README-FFmpeg-build.txt`.
