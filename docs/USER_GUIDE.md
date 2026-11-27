# Directory Beta — User Guide

## 1. Start editing in under a minute

1. Open Directory. The home screen shows **New project**, **Recent** projects and system status.
2. Drag one or more video files from Windows File Explorer anywhere onto the window.
   Directory creates a project that matches the first clip's resolution and frame rate and
   places the clips on the timeline one after another. No codecs or encoders need to be
   installed — the media engine ships inside Directory.
3. Press **Space** to play. Drag a clip edge to trim, press **S** to split at the playhead.
4. Click the **T** tool in the viewer and click on the image to add text.
5. Open **Library → Effects** and click an effect to apply it to the selected clip.
6. Press **Ctrl+M** (or the pink **Export** button), pick a preset, and export.

## 2. The workspace

| Area | What it does |
|------|--------------|
| Top bar | Menus, project name (double-click to rename), save status, undo/redo, workspace and preview-quality selectors, render status, settings, Export |
| Media | Imported files: thumbnails or list, search, sort, filter, folders, favourites, tags, hover-scrub previews, audio preview, proxies, offline/relink |
| Library | Effects, transitions, animation presets, text presets, shapes, 3D objects, generators, audio effects, composition templates |
| Viewer | The rendered composition with playback controls and on-canvas tools |
| Inspector | Every property of the selection (or the composition when nothing is selected) |
| Timeline | Layers/tracks, clips, keyframes, markers, work area, cache bar |
| Graph Editor | Value/speed curves with editable bezier handles |
| Scopes | Waveform, RGB parade, vectorscope, histogram |
| Audio Mixer | Faders, pan, mute/solo, level meters per audio clip |
| Render Queue | Export jobs with progress, ETA, pause/resume/cancel/retry and logs |
| Hierarchy | Parent/child tree — drag a layer onto another to parent it |

Every panel can be dragged by its tab to dock elsewhere, resized by its splitters, maximised
(double-click its tab strip or press <kbd>`</kbd>), closed, and re-opened from **Window**.
Eight workspace presets (Editing, Motion Graphics, Compositing, Colour Grading, 3D,
Audio, Effects, Minimal) are on **Alt+1…8**. Layout changes are remembered per workspace;
**Window → Reset Workspace** restores the preset.

## 3. Projects and compositions

* **New project**: name, format preset (1080p, 4K, 720p, vertical 9:16, 4:5, square,
  vertical 4K, or custom), frame rate (23.976 … 120), duration, background, transparency.
* A project holds any number of **compositions** (Composition → New, Ctrl+N). Composition
  settings (Ctrl+Alt+K or the Inspector with nothing selected) cover size, frame rate,
  duration, background/transparency, colour space, audio rate/channels and motion blur.
* **Nesting**: place a composition inside another (Composition → Nest, or create a compound
  clip). Double-click a nested comp/compound clip to open it; the breadcrumb returns.
* **Saving** (Ctrl+S) is atomic and keeps rotating backups in a `Backups` folder.
  **Autosave** writes recovery snapshots every few minutes to a separate folder; after a
  crash the home screen offers to recover them.
* **Missing media** is flagged offline; use Media → right-click → Relink, or File →
  Relink Missing Media to search a folder. **File → Collect Files** copies all media next
  to the project for a portable package.

## 4. Media

Supported imports include MP4, MOV, MKV, AVI, WebM, MPEG/MPG, M4V, MXF, TS/MTS/M2TS, FLV,
WMV, 3GP, GIF; H.264, HEVC, AV1, VP8/VP9 (incl. alpha), MPEG-2, ProRes, DNxHD/HR,
CineForm, MJPEG, FFV1; PNG, JPEG, WebP, TIFF, TGA, BMP, EXR, HDR, PSD (flattened), SVG;
WAV, MP3, AAC, FLAC, OGG, Opus, AIFF, M4A, WMA; numbered image sequences (File → Import
Image Sequence); glTF/GLB/OBJ models; .blend/.fbx/.usd/.abc via Blender; SRT/VTT subtitles.

Import is parallel and non-blocking; thumbnails and waveforms are generated lazily.
**Proxies**: right-click a clip → Generate Proxy (half/quarter/eighth/720p). Preview uses
proxies when enabled in Settings → Media; export always uses originals.

## 5. Timeline editing

* Drag clips to move (snaps to the playhead, clip edges, markers; hold Alt to disable).
* Drag edges to trim; **Alt+drag** slips the source; **Ctrl+drag** slides; select two
  touching clips and drag the shared edge to roll.
* **S** / Ctrl+K split, **Shift+Delete** ripple delete, **[ ]** move in/out to the playhead,
  **Alt+[ / Alt+]** trim to the playhead.
* Right-click a clip for speed/duration, reverse, freeze frame, transitions, compound clip,
  label colour, 2D/3D, arrange.
* **Compound clips**: select layers → Ctrl+G (or Ctrl+Shift+C). The clip keeps its contents'
  animation; transform/effect/mask/animate it like any layer; right-click → Unpack to restore.
* Layer switches: visibility, solo, mute, lock, 3D, motion blur, shy, blend mode, track matte,
  parent.
* Work area: drag the bar under the ruler or press I / O. Markers: M.
* **Render preview** (toolbar) pre-renders the work area into the cache (green bar).

## 6. Keyframes, graph editor and expressions

Every animatable property shows a diamond in the Inspector: click it to add/remove a key at
the playhead (Alt-click removes all keys). With **auto-key** on, changing a value creates a
key. In the timeline, expand a layer (U) to see animated properties; drag keys to retime,
Alt+drag to duplicate, right-click for linear/bezier/hold, Easy Ease (F9), ease in/out,
copy/paste and reverse.

The **Graph Editor** shows value or speed curves; drag keys and bezier handles, use the
tangent buttons, fit to selection or composition.

**Expressions**: click `=` next to a property. Examples:

```
wiggle(2, 30)                         // random motion
value + [0, sin(time * 2) * 14, 0]    // float
loopOut("cycle")                      // repeat keyframes (cycle, pingpong, offset, continue)
linear(time, 0, 2, 0, 360)            // map time to a value
layer("Null 1", "position")           // follow another layer
let s = 1 + sin(time * 6) * 0.04; value * s
```

Errors are shown inline and the keyframed value is used until fixed.

## 7. Layers, shapes, text, masks

* **Shapes**: rectangle, rounded rectangle, ellipse, polygon, star, triangle, line, arrow,
  pen paths — with multiple fills/strokes, gradients, dashes, caps/joins, stroke alignment,
  repeaters (linear/radial), trim paths and boolean combine modes.
* **Text**: font, weight, size, tracking, line height, fill/gradient, stroke, background box,
  wrap width, alignment, text-on-path, 3D extrusion and range **animators** by character,
  word or line (opacity, position, scale, rotation, tracking, fill). Presets: Typewriter,
  Stagger Up, Character Pop, Tracking In.
* **Masks**: rectangle, ellipse or pen masks on any layer; add/subtract/intersect/
  difference/lighten/darken, invert, feather, expansion, opacity; paths and parameters are
  keyframeable.
* **Track mattes**: alpha, alpha inverted, luma, luma inverted. Blend modes: 16 modes.
* **Null objects** control children through parenting (multi-level, cycle-protected);
  unparenting keeps the child where it is.

## 8. Effects and colour

70 GPU effects across Blur & Sharpen, Light, Stylize, Distort, Color, Keying and Generate,
plus 13 audio effects. All parameters are keyframeable. The effect stack can be reordered,
toggled, duplicated, reset, copied/pasted and saved as presets. **Adjustment layers** apply
their effects to everything beneath. The **Color Grade** effect provides lift/gamma/gain/
offset wheels, exposure, contrast, pivot, saturation, temperature/tint, highlights/shadows,
whites/blacks, vibrance and hue-vs-hue/sat/lum and lum-vs-sat curves; **Curves**, **Levels**
and **Apply LUT** (.cube) complete the toolkit. Use the Colour Grading workspace for scopes.

## 9. 3D

Toggle **3D** on any layer to place it in 3D space (X/Y/Z position, rotation, scale).
Add cameras (perspective/orthographic, zoom, point of interest, depth of field) and lights
(point, spot, directional, area, ambient, environment). Mesh primitives (cube, sphere,
cylinder, cone, torus, plane, pyramid, circle, grid) and imported glTF/GLB/OBJ models use a
PBR material (base colour/texture, metallic, roughness, specular, emission). Text and shapes
can be extruded into real 3D geometry.

**Blender**: import a .blend file and Directory runs your installed Blender in the background to
convert the scene to glTF (geometry, materials, hierarchy, cameras, lights). Anything that
cannot be transferred is listed in a report.

## 10. Audio

Volume (dB) and pan are keyframeable; fades in/out; audio effects (EQ, compressor, limiter,
reverb, delay, distortion, noise reduction, noise gate, stereo widening, pitch shift, time
stretch, high/low pass). The mixer shows levels from the analysed waveform and flags clipping.

## 11. Tracking

Select a video layer, choose the **Track** tool, click a feature, then **Track Forward**.
Apply the result to a new **Null** (attach text or graphics to it) or **Stabilize** the layer.

## 12. Exporting

Choose a preset (YouTube, Shorts, TikTok, Reels, Instagram, Facebook, ProRes master, DNxHR,
web, transparent formats) or set container, codec, resolution, frame rate, range, quality or
bitrate, bit depth, colour space, alpha, hardware encoding and audio. Exports run in the
**Render Queue**, can be paused, resumed, cancelled and retried, and every finished file is
read back and verified (size, duration, audio, and alpha when requested).

**Transparent video**: make the composition background transparent (or simply leave areas
empty with Transparent on) and use ProRes 4444/4444 XQ, WebM VP9 with alpha, PNG/TIFF/EXR
sequences, FFV1, QuickTime Animation or PNG-in-MOV. Directory refuses alpha for codecs that
cannot store it and warns when a transparent composition is exported without alpha.
