# Dependencies & Licences

## Runtime (bundled)
| Component | Version | Licence | Use |
|---|---|---|---|
| FFmpeg / FFprobe (gyan.dev full build) | 9.1 | GPL-3.0 (with GPL/version3 libs: x264, x265, SVT-AV1, libvpx, …) | Decode, encode, probe, audio mix |
| Microsoft Edge WebView2 | system | Microsoft | UI host (installer bootstraps it) |

The FFmpeg build's licence and build description are shipped in `ffmpeg/`. Because a GPL
FFmpeg build is distributed, Directory is distributed under GPL-3.0-or-later and the FFmpeg
source is available from https://ffmpeg.org and https://www.gyan.dev/ffmpeg/builds/.

## Rust crates (main)
| Crate | Version | Purpose |
|---|---|---|
| tauri, tauri-build, tauri-plugin-dialog | 2.x | Desktop shell, IPC, file dialogs |
| wgpu | 26 | GPU compositing (DX12/Vulkan, WARP fallback). Pinned to 26 for API stability; newer majors exist. |
| resvg / tiny-skia | 0.45 / 0.11 | SVG and vector rasterisation |
| cosmic-text, swash | 0.14, 0.2 | Text shaping, font discovery, glyph outlines |
| lyon_tessellation | 1 | Fill tessellation for 3D extrusion |
| gltf | 1 | glTF/GLB import |
| glam | 0.30 | Matrix maths |
| serde, serde_json | 1 | Project serialisation |
| rayon, parking_lot, pollster, bytemuck, uuid, base64, log, env_logger, thiserror | – | Utilities |

## Frontend (npm)
react 19, react-dom, zustand 5, immer 10, flexlayout-react 0.8 (docking), lucide-react
(icons), @tauri-apps/api & plugin-dialog 2. Dev: vite 6, typescript 5.8, vitest 3,
@playwright/test (CDP-driven end-to-end tests), @tauri-apps/cli 2.

## Build tools
Rust stable (MSVC, 1.100), Visual Studio 2022 Build Tools (VC tools + Windows 11 SDK),
Node.js 20+, Git.
