# Next Version — Bug Report & To-Do List

Status: **0.9.1 in progress** (go-ahead given 2026-11-27). See "Resolution log" at the end.
Reported: 2026-11-26, from hands-on testing of the installed Beta (0.9.0).
The app stays in **Beta**.

Overall feedback: the UI and layout are good. Dragging video and image files into the
scene works well. The shape tools work very well. The main problem is that most edits
don't visibly update the preview, so the app feels like "nothing actually works" yet.

---

## 1. Bugs

### 1.1 Preview doesn't show property changes — CRITICAL (fix first)
- **What happens:** when you change a property such as **Scale**, the selection border in
  the viewer resizes, but the image itself does not.
- Keyframing seems to record values, but there's no visible result in the preview. You
  can't see whether the animation works or how far it goes.
- The reporter suspects **no parameters visibly work** (position, rotation, opacity,
  effects and so on). Check them all.
- **Expected:** every inspector change and every keyframed value updates the preview
  image immediately.
- **Where to look:** the path from an edit to a new preview frame, including the
  `sync_project` debounce, the cache-key invalidation (`CacheKeys`), the
  one-request-in-flight preview coalescing, and whether the viewer re-requests a frame
  after a sync. The overlay draws from the frontend store, so it updates even when the
  rendered frame doesn't, which matches the symptom.
- **Test to add:** an E2E test that changes the scale, waits for the next preview frame,
  and asserts that the image's pixel bounds changed.

### 1.2 Easing presets add keyframes instead of changing the curve — HIGH
- **What happens:** applying Bounce, Cubic In/Out, Ease In/Out and similar presets
  **inserts extra keyframes** into the layer.
- **Expected:** a preset applied between two keyframes should **change the
  speed/value curve** between them, through the bezier handles in the graph editor. The
  curve then controls how quickly the object moves between the keyframes and how much it
  overshoots. You should be able to see and adjust this in the Graph Editor.
- **Notes:** plain easing (ease in/out, cubic) should only set `outH`/`inH` on the
  existing keys. Overshoot effects (bounce, elastic, back) need a curve type that can
  overshoot without adding keys. Options include a per-segment easing function such as
  `easing: "bounce" | "elastic" | "back"` with amount/frequency parameters, drawn in the
  graph editor, or bezier handles that are allowed to go above 1. The "add keyframes"
  behaviour can stay available only as an explicit "Bake to keyframes" command.

### 1.3 Workspace layout leaks between projects; closed panels can't be recovered — HIGH
- **What happens:** if you close a panel and then open or create another project, the
  panel is still missing. There's no obvious way to get it back.
- **Expected:**
  - Each project saves its **own** layout inside its project folder, for example
    `<Project>/layout.json`. Changes in one project never carry over to another.
  - New projects start from the default workspace.
  - A **Window menu** lists every panel with a checkmark, so a closed panel can be
    reopened. Also add a "Reset workspace" command that is easy to find.
- **Where to look:** the layout is currently stored globally in localStorage
  (`veyra.layout.v2.*` in `EditorShell.tsx`).
- **Related:** a project should be a **folder** that holds everything for that project:
  the project file, layout, autosaves/backups, cache and proxies if possible, and
  presets. Nothing project-specific should be stored globally.

### 1.4 Colour picker doesn't give the exact colour — HIGH
- **What happens:** the colour shown on the object differs from the colour picked.
- **Expected:** the picked hex value appears exactly in the preview and in exports, for
  example #FF0000 renders as #FF0000.
- **Where to look:** probably an sRGB↔linear conversion that is applied twice or
  missing, in the colour picker, the solid/shape/text raster, the import pass, or the
  output pass. Premultiplied alpha could also shift colours. Add a pixel test: a solid
  of a known hex colour must read back as the same hex value.

### 1.5 Layer stacking order looks wrong — MEDIUM
- **What happens:** dragging a layer to the top of the layer list doesn't bring it to the
  front in the viewer.
- **Expected:** the top of the timeline is the front of the image, with clear behaviour
  when dragging layers to reorder them.
- **Where to look:** layer index 0 is the topmost layer in the model. Check that the
  timeline drag reorder, the `Bring to front` commands and the renderer all agree. This
  may also be bug 1.1 (the preview not refreshing after a reorder).

### 1.6 Circle / ellipse tool — MEDIUM (unconfirmed)
- The circle tool may not have worked. The reporter wasn't sure whether it was drawn and
  just not displayed. Re-test it after 1.1 is fixed.

### 1.7 Render caching and live feedback are slow — MEDIUM
- Changes take too long to appear while you edit.
- **Expected:** near-instant feedback while scrubbing or dragging a value, at least at a
  lower preview resolution during interaction, then full quality when you stop.
- **Ideas:** a draft/low-resolution preview while a control is being dragged,
  invalidating only the layers that changed, a shorter sync debounce, and profiling the
  release build on the owner's machine.

### 1.8 App/desktop icon doesn't show — LOW
- The Directory logo isn't visible on the desktop shortcut or window. This will be replaced
  by the new logo anyway (see 2.2). Check that the icon is embedded in the exe and the
  installer shortcut.

### 1.9 Not yet tested by the reporter
- **Export.** The reporter hasn't tried it yet because the preview didn't show changes.
  Test it fully once 1.1 is fixed.

---

## 2. Changes for the next version

### 2.1 Rename the app
- The new name is **"Directory"**, as transcribed from the owner's voice note. **Confirm
  the exact spelling before renaming.**
- Rename everywhere: window title, home screen, installer, product name, exe name, file
  extension, the app data folder (`studio.veyra.editor`), docs, and code identifiers.
  Plan a migration so existing settings and projects still load.

### 2.2 New logo
- The owner will design the logo. When it's supplied, regenerate all icon sizes, update
  the installer, the shortcut, the in-app logo and the favicon.

### 2.3 White (light) colour scheme
- Switch the default theme to a white/light scheme. Possibly keep dark as an option in
  Settings → Interface. All colours are tokens in `ui/src/styles/tokens.css`.

### 2.4 GitHub repository
- Create a GitHub repository for the project. Private is recommended while GPL licensing
  questions are open, because the bundled FFmpeg is GPL-3.0.
- Push all the source. Publish each built installer as a **GitHub Release**, so a full,
  ready-to-run version can be downloaded without keeping build files on the PC.
- Needs: install the GitHub CLI, and the owner signs in.
- Owner asked to **wait** on this for now.

### 2.5 Auto-update
- Make the app check the GitHub Releases for a newer version at start-up. Show an
  "Update available" prompt, and let the user choose to update now or later.
- Implementation: the Tauri updater plugin (`tauri-plugin-updater`), with signed update
  bundles published to GitHub Releases.
- Depends on 2.4.

---

## 3. Suggested order of work
1. 1.1 Preview not updating, then re-check every parameter, then 1.5 and 1.6.
2. 1.4 Exact colours.
3. 1.2 Easing presets that change the graph instead of adding keys.
4. 1.3 Per-project layout, project folder, Window menu.
5. 1.7 Performance pass.
6. Full export test.
7. 2.1–2.3 Rename, logo and light theme (once the name and logo are final).
8. 2.4–2.5 GitHub repository, then auto-update.

Every fix gets an automated test where possible. The installer is rebuilt and re-verified
at the end.

---

## Resolution log — 0.9.1 (2026-11-27)

Root causes were reproduced in the real app (including the installed 0.9.0 build) before
fixing, and each fix was re-checked in the running app.

| # | Item | Root cause | Status |
|---|---|---|---|
| 1.1 | Preview not following edits ("border scales, image doesn't") | Two bugs. (a) The editor→engine sync could cancel a pending sync the preview was waiting on during fast drags, freezing the preview for the rest of the session while the overlay kept moving. Reproduced: after a burst of edits, the old code showed 116 px / 288 px instead of 72 px. (b) Typed numbers were evaluated with `Function()`, which the release build's security policy blocks, so **every typed value was silently discarded** in the installed app (dev mode has no such policy, which is why tests missed it). | ✅ Fixed: serialised syncs that always resolve, and a safe arithmetic parser for number fields. Verified: stress test (8×80 edits) gives the correct result every time; typed scale/rotation/opacity/position/keyframes all show in the preview. |
| 3D | Changing a 3D layer's/object's orientation did nothing | The inspector's Material section (shown for every 3D layer) crashed in an infinite re-render loop, replacing the inspector with an error, so the rotation controls were unusable. The same unsafe pattern existed in 5 other panels. | ✅ Fixed. Verified in app: X/Y/Z rotation changes a 3D solid and a cube. GPU test added. |
| 1.2 | Easing presets added keyframes | Presets wrote extra keys instead of editing the curve. | ✅ New Easing library (Library → Animate, and Graph Editor "Easing curve…"): Linear, Ease, Sine, Quad, Cubic, Quart, Quint, Expo, Circ, Back (overshoot), Elastic, Bounce. Applies to the segment between existing keys only; elastic/bounce have an Amount (%). Physics presets now use 2 keys + a curve. Verified: still 2 keys after applying. |
| 1.3 | Layout leaked between projects; closed panels unrecoverable | Layout was stored globally in browser storage. | ✅ Layout saved per project in `<Project folder>/layout.json`; new projects start from the default; saving creates a project folder; Window menu shows panels with checkmarks and toggles them. Verified in app. |
| 1.4 | Colour not exact | Engine was already exact (now covered by a GPU test for solids, rectangles, ellipses, text). The picker's hex box only applied on Enter, so a typed hex was lost when clicking away; also affected by 1.1. | ✅ Hex applies as you type. Verified in app: #3A7BD5 renders as (58,123,213). Note: lit 3D materials are shaded by lights, so they won't match the swatch exactly; turn off "Lit" for a flat colour. |
| 1.5 | Layer order | Ordering logic was correct; symptom came from 1.1 (stale preview). | ✅ Verified in app: dragging a layer to the top brings it to the front. 3D layers are depth-sorted by distance from the camera, like After Effects. |
| 1.6 | Circle tool | Works; symptom came from 1.1. | ✅ Verified in app. |
| 1.7 | Slow feedback | While editing, the preview renders a fast draft and refines ~0.2 s after you stop. | ✅ |
| 1.8 / 2.1–2.3 | Name, logo, theme | | ✅ Renamed **Directory** (window, installer, file type `.directory`, app data folder with automatic migration of settings from VEYRA). New logo and icons from the owner's design. Dark theme with a white accent. New shapes and 3D objects default to white. |
| 1.9 | Export | | Re-tested with the release build (see STATUS.md). |
| 2.4–2.5 | GitHub repository + auto-update | | ⏸ Waiting for the owner's go-ahead. |
