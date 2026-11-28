# Directory — bug & feature backlog

From hands-on testing (28 Nov 2026 onward). Priority: **P1** = next release, **P2** = the release
after, **P3** = later. Status: ✅ done · 🔧 in progress · ⏳ planned · ❓ needs a check.

## Directory 0.9.5

| # | Type | Item | Status |
|---|------|------|--------|
| 19 | Bug | **Nothing could be dragged inside the app**: panels (by their tab), media → timeline, Library → timeline, effect reordering, Hierarchy parenting. Cause: on Windows, the setting that lets you drag files in from File Explorer switches off the browser's own drag-and-drop inside the window. All in-app drags now use mouse/pointer events instead (panel library downgraded to flexlayout-react 0.7, which drags that way). | ✅ 0.9.5 |
| 15 | Feature | **Online asset browser** (Library → Online): search or paste a link from Pixabay, Pexels, Sketchfab, Poly Haven or Openverse; drag results onto the timeline/viewer/media (downloaded to Documents › Directory Projects › Downloaded Assets and imported); free-only filter; paid items open the website; non-commercial licences flagged; credits added to the project. Poly Haven and Openverse need no key; Pixabay/Pexels need a free key; Sketchfab needs a token to download. | ✅ 0.9.5 |
| 10 | Feature | **Pie menu (Alt+Z)**: the workspaces (built-in and your own) in a ring around the mouse. Move toward one and click, or let go of Z. | ✅ 0.9.5 |
| 20 | UX | **Align tools hard to find**: now also an *Align* button in the viewer toolbar and an *Align* row at the top of the Inspector's Transform section (besides the floating bar, Layer → Align and the right-click menu). | ✅ 0.9.5 |
| 21 | Feature | **Camera field of view** editable in degrees and keyframeable (shares Zoom's keyframes). | ✅ 0.9.5 |
| 22 | Bug | The *Compositing* workspace listed the Hierarchy panel twice (could fail to load). Fixed, with a test that loads every workspace. | ✅ 0.9.5 |
| 17 | Bug | **No update pop-up at start-up.** The check only ran if everything before it at launch succeeded and gave up silently on a network error. Now it runs on its own, retries (30 s, 2 min, 10 min) and re-checks every 3 hours while Directory is open. | ✅ 0.9.5 |
| 18 | Feature | **Check for updates and Settings on the home screen**, with "Version X is available · Install" / "Couldn't check · Retry" under the version number. | ✅ 0.9.5 |

## P2 — next

| # | Type | Item | Status |
|---|------|------|--------|
| 11 | Feature | **Light / dark theme** switch (Settings → Interface, and the Window menu). | ⏳ |
| 12 | Feature | **Properties in the timeline** (After Effects style twirl-down under each layer), with a setting: Inspector / Timeline / Both. | ⏳ |
| 13 | Feature | **More effects (After Effects parity).** Directory has 74 effects; After Effects ships ~300 (incl. the CC effects such as *CC Light Sweep*). Add them in batches by category. First batch: Light Sweep, Glow variants, Directional/Radial/Camera Lens blur, Turbulent Displace, Bulge, Twirl, Echo, Posterize Time, Linear/Radial Wipe, Gradient Ramp, 4-Colour Gradient, Fractal Noise, Drop Shadow, Bevel Alpha, CC Radial Fast Blur, CC Glass. | ⏳ |
| 14 | Feature | **Export: extra formats.** To add: audio-only export (WAV / MP3 / AAC), animated WebP, GoPro CineForm (with alpha). Make it obvious that ProRes and alpha live under the MOV format. | ⏳ |
| 23 | Feature | Pixabay music / Freesound sound effects in the Online browser (need their own API keys). | ⏳ |

## Released

| # | Item | Version |
|---|------|---------|
| 1 | Clicking inside a mask now moves the clip (outline selects the mask) | 0.9.4 |
| 2 | Snapping in the viewer | 0.9.4 |
| 3 | Align / distribute | 0.9.4 |
| 4 | Auto render toggle + Render preview on the timeline | 0.9.4 |
| 5 | Library items can be added by dragging (made to work in the app in 0.9.5) | 0.9.4 / 0.9.5 |
| 6 | Right-click menu on empty space | 0.9.4 |
| 7 | Save Workspace As… (panel dragging fixed in 0.9.5) | 0.9.4 / 0.9.5 |
| 8 | Optimisation pass 1: no per-frame project copy | 0.9.4 |
| 16 | Render Queue button | 0.9.4 |
| — | Previews no longer fill the drive (RAM-only cache, opt-in disk cache) | 0.9.3 |
| — | In-app updates | 0.9.2 |

## Not bugs (checked)

- ProRes, alpha and premultiplied alpha export: available. Choose Format **QuickTime (MOV)** to see ProRes.
- Duplicating clips, overlaying clips, freeze frame, time remap, reverse, track mattes, masks, Gaussian blur controls: work.
- Camera: position, rotation, target (point of interest), depth of field, focus distance and aperture: work.
