# Troubleshooting

**"GPU unavailable" or slow preview.** VEYRA needs DirectX 12 or Vulkan; otherwise it uses
the WARP software renderer. Update your graphics driver. Lower the preview resolution
(top bar → Half/Quarter), enable Settings → Performance → Adaptive preview, generate proxies
for 4K footage, or press *Render preview* on the timeline to fill the cache. To force
software rendering for diagnosis, set the environment variable `VEYRA_SOFTWARE_RENDER=1`.

**A file will not import.** The error toast shows the media engine's message. Corrupt or
DRM-protected files cannot be read. Unusual image formats can be converted with
File → Import, or exported to PNG first.

**Media shows as Offline.** The file moved or was renamed. Use File → Relink Missing Media
(searches a folder by file name) or right-click the item → Relink.

**Export failed.** Open the Render Queue and click *View log* — it contains the exact
encoder command and its output (logs live in `%APPDATA%\studio.veyra.editor\logs`). Common
causes: not enough disk space, an output folder without write permission, or hardware
encoding unavailable (turn off *Hardware encoding*).

**Transparent export comes out black.** Turn on *Transparent* in Composition Settings and
choose an alpha-capable format (ProRes 4444, WebM VP9, PNG/TIFF/EXR sequence, FFV1,
QuickTime Animation). Players that do not support alpha (e.g. many web players for MOV)
will still display black — check in an editor or compositor.

**VEYRA crashed.** On the next start the home screen offers to recover the latest autosave.
Backups of manual saves are in the `Backups` folder next to the project.

**Expression error.** The error is shown under the property; the keyframed value is used
until it is fixed.

**Where are things stored?** Settings, autosaves, presets and logs:
`%APPDATA%\studio.veyra.editor`. Cache, proxies, waveforms:
`%LOCALAPPDATA%\studio.veyra.editor\cache` (Settings → Performance → Clear cache).

**Blender import says Blender was not found.** Install Blender from blender.org or set its
path in Settings → Media. VEYRA runs it in the background only for conversion.
