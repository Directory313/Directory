# Export Format Reference

All encoders ship with VEYRA (bundled FFmpeg 9.1 full build). "HW" = hardware encoder used
when available and enabled (NVIDIA NVENC, Intel Quick Sync, AMD AMF); otherwise software.

| Codec | Containers | Alpha | Bit depth | Encoder | Notes |
|-------|-----------|:-----:|-----------|---------|-------|
| H.264 | mp4, mov, mkv, avi | – | 8 | libx264 / HW | Most compatible; social presets |
| H.265 / HEVC | mp4, mov, mkv | – | 8 / 10 | libx265 / HW | `hvc1` tag in MP4/MOV |
| AV1 | mp4, mkv, webm | – | 8 / 10 | SVT-AV1 / HW | |
| VP9 | webm, mkv | ✓ | 8 | libvpx-vp9 | Alpha as `yuva420p` |
| ProRes 422 / 422 HQ | mov | – | 10 | prores_ks | Masters |
| ProRes 4444 / 4444 XQ | mov | ✓ | 10 (+16-bit alpha) | prores_ks | Transparent masters |
| DNxHR HQ / HQX / 444 | mov, mxf | – | 8 / 10 | dnxhd | Any resolution |
| DNxHD | mov, mxf | – | 8 | dnxhd | 1920×1080 only |
| FFV1 | mkv, avi | ✓ | 8 | ffv1 | Lossless archive |
| QuickTime Animation | mov | ✓ | 8 | qtrle | Lossless RLE |
| PNG in MOV | mov | ✓ | 8 | png | |
| MPEG-2 | mpg, mpeg, mxf, ts | – | 8 | mpeg2video | Broadcast legacy |
| Motion JPEG | avi, mov | – | 8 | mjpeg | |
| Uncompressed RGBA | mov, avi, mkv | ✓ | 8 | rawvideo | Very large |
| Animated GIF | gif | – | 8 | gif (palette) | |
| PNG sequence | png | ✓ | 8 | png | Audio written as `audio.wav` beside frames |
| JPEG sequence | jpg | – | 8 | mjpeg | |
| TIFF sequence | tif | ✓ | 8 | tiff (LZW) | |
| OpenEXR sequence | exr | ✓ | half float | exr (ZIP) | Values come from the 8-bit output stage |

Audio: AAC, Opus (WebM), MP3, PCM 16/24-bit, FLAC; MP2 for MPEG containers; PCM for MXF/AVI.

## Alpha rules

* Requesting alpha with a codec that cannot store it is a **validation error**.
* Exporting a transparent composition without alpha shows a **warning**; transparent areas
  are flattened onto black (premultiplied composite), never silently left undefined.
* After export, the file is probed and an alpha export only reports success if the written
  pixel format actually carries alpha. The automated test suite additionally decodes
  ProRes 4444 and PNG outputs and checks transparent pixels are alpha 0.
* Straight alpha is the default; **Premultiplied** can be selected for alpha exports.

## Presets

YouTube 1080p/4K, YouTube Shorts, TikTok, Instagram Reels / Post 4:5 / Square / Stories,
Facebook, Professional Master (ProRes 422 HQ), High Quality HEVC, DNxHR HQ (MXF), Web
Optimised (720p), WebM VP9, Transparent ProRes 4444, Transparent WebM VP9, Transparent PNG
sequence, 4K Master, 1080p, Custom. Your own presets can be saved from the Export dialog.

## Colour

Outputs are tagged Rec. 709 by default (Rec. 2020 and sRGB tagging available). The internal
compositing pipeline is 16-bit float; the final output stage is 8-bit RGBA before encoding,
so 10-bit codecs receive 8-bit source precision (see Known Limitations).
