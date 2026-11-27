# Directory Beta — Feature Status, Test Report & Performance Review

Build machine: Windows 11 Pro, Intel UHD Graphics (Vulkan), 8 logical CPUs, 7.8 GB RAM.
Test date: 2026-11-26.

Legend: **✅ Implemented & tested** (automated test or verified in the running app) ·
**🟡 Implemented, not fully tested** (compiles, wired end-to-end, not exercised by a test) ·
**🟠 Partial** · **❌ Not implemented**.

## Feature status

| Area | Feature | Status |
|---|---|---|
| App | Desktop app launch, home screen, project creation | ✅ (real app via CDP) |
| App | Docking workspace: move/resize/dock/maximise/close panels, 8 presets, saved layouts | ✅ layout verified · 🟡 drag-docking by hand |
| App | Command palette, customisable shortcuts, context menus, toasts | 🟡 |
| App | Settings (general/performance/media/timeline/animation/export/interface/shortcuts) | 🟡 |
| Media | Bundled FFmpeg discovery (no user install) | ✅ |
| Media | Import + probe (resolution, fps, duration, audio/video streams, alpha, VFR, rotation) | ✅ |
| Media | Drag & drop from Explorer → media/timeline/viewer/home | 🟡 drop handler path ✅ (same function driven by E2E); physical OS drag not automatable |
| Media | Thumbnails, hover-scrub filmstrips, waveforms | ✅ thumbnails & waveform (tests) · 🟡 filmstrips |
| Media | Media browser: grid/list, search, sort, filter, folders, favourites, tags, duplicates, offline, relink | 🟡 |
| Media | Image sequences, SVG, glTF/OBJ models, subtitles import | 🟡 |
| Media | Proxies (generate, toggle, used for preview only) | 🟡 |
| Media | Hardware decode toggle (`-hwaccel auto`) | 🟡 |
| Timeline | Layers/tracks, clip move/trim/split/ripple/slip/slide/roll, snapping | ✅ trim (Alt+]), split (unit) · 🟡 mouse drags |
| Timeline | Speed, reverse, freeze, time remap, transitions | ✅ engine tests · 🟡 UI |
| Timeline | Markers, work area, cache bar, render preview, filmstrips/waveforms in clips | 🟡 |
| Timeline | Compound clips (create / open / unpack, preserves animation) | ✅ unit + GPU pixel-identical + E2E |
| Timeline | Nested compositions | ✅ |
| Animation | Keyframes on every property (registry-driven), linear/hold/bezier | ✅ |
| Animation | Graph editor (value/speed, bezier handles) | 🟡 |
| Animation | Expressions (wiggle, loopOut, linear, layer refs, safe sandbox) | ✅ |
| Animation | Animation presets (bounce, elastic, spring, wiggle, typewriter, stagger…) and custom presets | 🟡 |
| Objects | Universal inspector, transforms, parenting (multi-level, cycle-safe, unparent keeps placement) | ✅ |
| Objects | Null objects (invisible controllers) | ✅ |
| Shapes | Rect/rounded/ellipse/polygon/star/triangle/line/arrow/pen; fills, strokes, gradients, dashes, align, repeater, trim, combine | ✅ raster tests (7 shapes) · 🟡 advanced options |
| Text | Text layers, fonts, styling, background, animators by char/word/line, extrusion | ✅ render + extrusion tests · 🟡 animators UI |
| Effects | 70 GPU effects, all run without GPU errors; stack ops; adjustment layers | ✅ |
| Effects | Effects actually modify pixels (invert, blur spill) | ✅ |
| Compositing | 16 blend modes, track mattes (alpha/luma ± inverted), masks (modes, feather, expansion) | ✅ |
| Compositing | Chroma/luma key, spill, matte choker | ✅ runs · 🟡 quality on real green-screen footage |
| Colour | Colour grade wheels, curves, levels, hue curves, .cube LUT, scopes | ✅ curve/LUT tests · 🟡 UI |
| 3D | 3D layers, default & user cameras, DOF, orthographic | ✅ |
| 3D | Mesh primitives, PBR lighting, lights | ✅ |
| 3D | Extruded 3D text/shapes | ✅ |
| 3D | glTF/OBJ import | 🟡 |
| 3D | Blender .blend bridge | 🟡 implemented, **untested** (Blender not installed) |
| Motion | Particles (deterministic), generators, motion blur | ✅ particles/generators · 🟡 motion blur visuals |
| Tracking | Point/multi-point tracking (NCC, sub-pixel), track-to-null, stabilise | ✅ tracker unit test · 🟡 UI |
| Tracking | Planar / camera tracking | ❌ |
| Audio | Mixdown with volume automation, pan, fades, speed, reverse, effects (EQ, compressor, …) | ✅ export with audio · 🟡 individual effects |
| Audio | Synced preview playback, mixer meters | 🟡 |
| Playback | GPU preview, frame skipping, adaptive resolution, RAM+disk cache with selective invalidation | ✅ |
| Export | H.264/HEVC/AV1/VP9/ProRes/DNxHR/FFV1/sequences, presets, queue, pause/resume/cancel | ✅ H.264, ProRes 4444, VP9 alpha, PNG seq · 🟡 others |
| Export | Alpha: refuse unsupported, warn on transparent comps, verify output | ✅ |
| Export | Hardware encoding (QSV detected here) | 🟡 |
| Safety | Atomic save, backups, schema versioning, autosave, crash recovery, relink | ✅ save/load/backup/round-trip · 🟡 crash recovery UI |
| Interop | SRT/VTT import & export, OTIO & EDL export | ✅ subtitles · 🟡 OTIO/EDL |
| Plugins | Third-party plugin system | ❌ |

## Automated tests (all passing)

| Suite | Tests | Covers |
|---|---|---|
| veyra-core | 26 | Interpolation, bezier, expressions, transforms, parenting, camera, compound clips, split, ripple, cache keys, save/load/backups/migration, subtitles |
| veyra-media | 1 (integration) | Real FFmpeg: synthesise, probe, decode, random access, waveform, thumbnail |
| veyra-render (unit) | 10 | Shader validation (naga), masks, particles, shapes, curves, LUT, meshes, extrusion, cache |
| veyra-render (GPU) | 10 | Real GPU renders: background/alpha, keyframed motion, all 70 effects, effect pixels, blend modes, track matte, masks, nested/null/compound, 3D camera + lit mesh + extruded text, transitions, adjustment layers |
| veyra-export (unit) | 4 | Alpha rules, codec args, volume automation, atempo |
| veyra-export (E2E) | 1 | Render+encode H.264/AAC, ProRes 4444, VP9 alpha, PNG sequence; decode and verify alpha pixels; refuse H.264 alpha |
| src-tauri | 1 | Tracker sub-pixel accuracy |
| UI (vitest) | 10 | Keyframe evaluation mirror, timecodes, timeline model |
| App E2E (Playwright over CDP, real desktop window) | 6 scripts | Spec workflow steps 1–17, round-trip, transparent export via UI, playback performance |

### Spec workflow (run in the real app)
1 open ✅ · 2 create project ✅ · 3 import via drop handler ✅ · 4 on timeline ✅ · 5 trim ✅ ·
6 text tool ✅ · 7 animate (stopwatch + key) ✅ · 8 effect from Library ✅ · 9 compound clip ✅ ·
10 null ✅ · 11 parent ✅ · 12 mask tool ✅ · 13 3D ✅ · 14 save ✅ · 15 reopen — zero
differences after save→open→save ✅ · 16 export (1920×1080 H.264 + AAC, 30 s) ✅ · 17 output
probed and frames inspected (mask, animated text, 3D compound, null rotation visible) ✅.
Transparent ProRes 4444 via the Export dialog: decoded alpha 0 in the background, 255 on
the shape ✅.

## Performance review (debug build unless stated)

| Measurement | Result |
|---|---|
| Playback, Half resolution, comp with masked video + glow text + 3D nested compound + null | 21 fps achieved (comp 30 fps), frames skipped rather than queued |
| Export 30 s 1080p H.264 of that comp | 166 s (≈5.4 fps render+encode) in debug |
| Export 2 s 720p ProRes 4444 star | 5.2 s |
| GPU test suite (all 70 effects etc.) | 0.7 s debug / 1.3 s release (incl. device init) |
| **Installed release build**: import 8 s 720p clip, GPU render, export 3 s 720p H.264+AAC | export 3.1 s (≈ real time); bundled FFmpeg used from the install folder |

### Packaging (verified)
`release/VEYRA_0.9.0_x64-setup.exe` (NSIS, per-user, 130 MB), `release/VEYRA_0.9.0_x64_en-US.msi`
(184 MB), `release/Directory-Beta-portable.zip` (183 MB). The NSIS installer was installed silently
on the build machine and the installed app was launched and exercised (above). The MSI and the
portable ZIP were built but not separately installed/launched.

Optimisations in place: decoder processes persist and stream sequentially (no re-seek during
playback); render/encode overlap via a writer thread; texture pooling with submission-
ordered recycling; preview requests coalesce (one in flight); per-layer cache keys; adaptive
preview scale; dependency crates built optimised even in debug.

## 0.9.1 update (2026-11-27): beta bug-report fixes

Renamed to **Directory** (new logo, white accent). Full details of each fix and its root cause are in
`docs/NEXT_VERSION.md` → "Resolution log".

| Suite | Result |
|---|---|
| veyra-core | 27 passed (adds elastic/bounce easing) |
| veyra-render GPU | 12 passed (adds exact picked colours for solid/rect/ellipse/text on opaque and transparent comps, and 3D rotation on every axis for a 3D layer and a mesh) |
| UI (vitest) | 15 passed (adds easing curves, safe number-field arithmetic) |
| App E2E (dev build) | Preview stress test (640 rapid edits) follows edits; ellipse tool, exact colour via picker, layer reorder, 3D rotation (layer + cube), easing keeps 2 keys, per-project layout (6 checks): all pass |
| App E2E (**release build**, strict CSP) | Typed scale/rotation/opacity/position apply and show in the preview; `*2` arithmetic; 3D inspector does not crash; 3D X/Y rotation; import + render + 3 s 720p H.264/AAC export in 3.1 s, output probed: all pass |

Packaging: `release/Directory_0.9.1_x64-setup.exe` (130 MB), `release/Directory_0.9.1_x64_en-US.msi`
(184 MB), `release/Directory-Beta-portable.zip` (183 MB). The release exe was run and tested
directly. The installers were built but **not** installed on this machine.
