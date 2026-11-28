# Directory — bug & feature backlog

From hands-on testing of 0.9.3 (28 Nov 2026). Priority: **P1** = next release, **P2** = the release
after, **P3** = later. Status: ✅ done · 🔧 in progress · ⏳ planned · ❓ needs a check.

## P1 — Directory 0.9.4 (released)

| # | Type | Item | Status |
|---|------|------|--------|
| 1 | Bug | **Can't drag a clip in the viewer after drawing a mask.** Clicking inside a mask selects the mask instead of moving the clip, and the move/scale handles disappear while a mask is selected. Only the mask outline should select the mask; clicking inside should move the clip. | ✅ 0.9.4 |
| 2 | Feature | **Snapping in the viewer** (toggle): clips snap to the frame centre and edges and to other clips' edges and centres, with guide lines while dragging. | ✅ 0.9.4 |
| 3 | Feature | **Align tools** that appear when clips are selected: align left / centre / right / top / middle / bottom (to the frame, or to each other when several are selected), distribute evenly. | ✅ 0.9.4 |
| 4 | Feature | **Auto-render toggle on the timeline** (no need to open Settings), plus a visible **Render Preview** button. | ✅ 0.9.4 |
| 5 | Feature | **Drag from the Library** (text, shapes, generators, effects) onto the timeline or viewer, not only click or right-click. | ✅ 0.9.4 |
| 6 | Feature | **Right-click anywhere** (empty timeline, empty viewer, media panel, empty panel space) opens a general menu with the tools that aren't on screen: add layers, import, paste, workspace, render, etc. | ✅ 0.9.4 |
| 7 | Feature | **Movable panels / custom workspaces.** Panels can be moved by dragging their **tab title** (e.g. "Inspector") onto another area. Add *Window → Save Workspace As…* for named custom layouts, and make the drag handle obvious. ❓ Check in the installed app whether dragging a tab title works for you. | ✅ 0.9.4 (Save Workspace As…) · ❓ tab dragging in the installed app |
| 8 | Perf | **Optimisation pass** (repeat every 2–3 releases): stop copying the whole project for every preview frame, faster frame-cache lookups, and other per-frame overhead. | ✅ 0.9.4 (first pass: no per-frame project copy) |
| 9 | Check | Confirm 0.9.3's storage fix: Settings → Performance shows background pre-rendering and disk cache off; free space stays flat while editing. | ❓ |

## P2 — Directory 0.9.5

| # | Type | Item | Status |
|---|------|------|--------|
| 10 | Feature | **Pie menu (Alt+Z)**, Blender style: a circular menu at the mouse; move toward a slice to pick it (tools / workspaces / modes). | ⏳ |
| 11 | Feature | **Light / dark theme** switch (Settings → Interface, and the Window menu). | ⏳ |
| 12 | Feature | **Properties in the timeline** (After Effects style twirl-down under each layer), with a setting: Inspector / Timeline / Both. | ⏳ |
| 13 | Feature | **More effects (After Effects parity).** Directory has 74 effects; After Effects ships ~300 (incl. the CC effects such as *CC Light Sweep*). Build the full list, then add them in batches by category (Blur & Sharpen, Distort, Generate, Stylize, Light & Lens, Transition, Time, Keying, Perspective, Simulation…). First batch: Light Sweep, Glow variants, Directional/Radial/Camera Lens blur, Turbulent Displace, Bulge, Twirl, Echo, Posterize Time, Linear/Radial Wipe, Gradient Ramp, 4-Colour Gradient, Fractal Noise, Drop Shadow, Bevel Alpha, CC Radial Fast Blur, CC Glass. | ⏳ |
| 14 | Feature | **Export: extra formats.** Already there (in the Codec list after choosing the matching Format): ProRes 422/HQ/4444/4444 XQ (MOV), DNxHR, VP9 with alpha (WebM), FFV1, QuickTime Animation, PNG-in-MOV, uncompressed, GIF, PNG/JPEG/TIFF/EXR sequences. To add: audio-only export (WAV / MP3 / AAC), animated WebP, GoPro CineForm (with alpha). Make it obvious that ProRes and alpha live under the MOV format. | ⏳ |

## P3 — later

| # | Type | Item | Status |
|---|------|------|--------|
| 15 | Feature | **Online asset libraries in-app**: browse Pixabay and Pexels (photos, video, music) and Sketchfab (3D models) in a Library tab; filter to free; one-click import; paid items open the website. Needs a free API key for each service (you register on each site and paste the key into Settings; no MCP needed). Sketchfab downloads need you to sign in to your Sketchfab account from Directory. Show each asset's licence and attribution. | ⏳ |
| 16 | UX | Render Queue is hard to find: add a button for it next to Export. | ✅ 0.9.4 |

## Not bugs (checked)

- ProRes, alpha and premultiplied alpha export: available. Choose Format **QuickTime (MOV)** to see ProRes.
- Dragging media from the Media panel to the timeline: works.
- Duplicating clips, overlaying clips, freeze frame, time remap, reverse, track mattes, masks, Gaussian blur controls: work.
