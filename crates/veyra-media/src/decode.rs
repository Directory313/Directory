//! Frame decoding. Each (source, size) pair gets a persistent FFmpeg process that streams
//! RGBA frames sequentially; forward playback reads the pipe, while jumps restart the process
//! with an accurate seek. Stills are decoded once and cached.

use crate::ffmpeg::{self, MediaError, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStdout, Stdio};
use std::sync::Arc;
use std::time::Instant;

/// Straight-alpha RGBA8 frame.
#[derive(Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Arc<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub path: String,
    /// Native frame rate used to conform VFR footage to CFR.
    pub fps: f64,
    pub still: bool,
    pub alpha_codec: Option<String>,
    pub sequence: Option<(u32, f64)>,
}

impl Source {
    pub fn from_asset(a: &veyra_core::model::Asset, use_proxy: bool) -> Self {
        let proxy = a.proxy.as_ref().filter(|p| use_proxy && a.use_proxy && std::path::Path::new(p).exists());
        let path = proxy.cloned().or_else(|| a.sequence_pattern.clone()).unwrap_or_else(|| a.path.clone());
        let still = matches!(a.kind, veyra_core::model::AssetKind::Image) || (a.info.duration <= 0.0 && a.sequence_pattern.is_none());
        let alpha_codec = (proxy.is_none() && a.info.has_alpha).then(|| match a.info.video_codec.as_str() {
            "vp9" => Some("libvpx-vp9".to_string()),
            "vp8" => Some("libvpx".to_string()),
            _ => None,
        }).flatten();
        Self {
            path,
            fps: if a.info.fps > 0.0 { a.info.fps } else { 30.0 },
            still,
            alpha_codec,
            sequence: a.sequence_pattern.as_ref().map(|_| (a.sequence_start, a.info.fps.max(1.0))),
        }
    }
}

struct Stream {
    child: Child,
    out: ChildStdout,
    /// Index of the next frame the pipe will deliver.
    next: i64,
    last: Option<(i64, Frame)>,
    used: Instant,
    eof: bool,
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Decoder {
    src: Source,
    w: u32,
    h: u32,
    stream: Option<Stream>,
}

impl Decoder {
    fn frame_bytes(&self) -> usize {
        self.w as usize * self.h as usize * 4
    }

    fn spawn(&mut self, frame: i64) -> Result<()> {
        self.stream = None;
        let t = frame.max(0) as f64 / self.src.fps;
        let mut c = ffmpeg::ffmpeg()?;
        if let Some((start, fps)) = self.src.sequence {
            c.args(["-f", "image2", "-start_number", &start.to_string(), "-framerate", &fps.to_string()]);
        }
        if t > 0.0 {
            c.args(["-ss", &format!("{t:.6}")]);
        }
        if let Some(codec) = &self.src.alpha_codec {
            c.args(["-c:v", codec]);
        }
        c.arg("-i").arg(&self.src.path);
        let vf = format!("fps={},scale={}:{}:flags=bicubic", self.src.fps, self.w, self.h);
        c.args(["-an", "-sn", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
        c.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = c.spawn().map_err(MediaError::Spawn)?;
        let out = child.stdout.take().ok_or_else(|| MediaError::Failed("no stdout".into()))?;
        self.stream = Some(Stream { child, out, next: frame.max(0), last: None, used: Instant::now(), eof: false });
        Ok(())
    }

    fn read_one(&mut self) -> Result<Option<Frame>> {
        let n = self.frame_bytes();
        let s = self.stream.as_mut().unwrap();
        if s.eof {
            return Ok(None);
        }
        let mut buf = vec![0u8; n];
        let mut got = 0;
        while got < n {
            match s.out.read(&mut buf[got..]) {
                Ok(0) => {
                    s.eof = true;
                    return Ok(None);
                }
                Ok(k) => got += k,
                Err(e) => return Err(MediaError::Failed(e.to_string())),
            }
        }
        let f = Frame { width: self.w, height: self.h, data: Arc::new(buf) };
        s.last = Some((s.next, f.clone()));
        s.next += 1;
        Ok(Some(f))
    }

    fn get(&mut self, t: f64) -> Result<Option<Frame>> {
        let want = (t * self.src.fps + 1e-4).floor() as i64;
        if let Some(s) = &self.stream {
            if let Some((i, f)) = &s.last {
                if *i == want {
                    return Ok(Some(f.clone()));
                }
            }
        }
        let fwd_ok = self.stream.as_ref().is_some_and(|s| want >= s.next && want - s.next < (self.src.fps * 3.0) as i64 + 2 && !s.eof);
        if !fwd_ok {
            self.spawn(want)?;
        }
        if let Some(s) = self.stream.as_mut() {
            s.used = Instant::now();
        }
        let mut last = None;
        loop {
            let next = self.stream.as_ref().unwrap().next;
            if next > want {
                break;
            }
            match self.read_one()? {
                Some(f) => last = Some(f),
                None => break,
            }
        }
        // Past the end of the media: hold the last decoded frame.
        if last.is_none() {
            last = self.stream.as_ref().and_then(|s| s.last.as_ref().map(|x| x.1.clone()));
        }
        Ok(last)
    }
}

/// Thread-safe decoder pool with LRU eviction of idle processes and a still-image cache.
pub struct DecoderPool {
    decoders: Mutex<HashMap<(String, u32, u32), Arc<Mutex<Decoder>>>>,
    stills: Mutex<HashMap<(String, u32, u32), Frame>>,
    pub max_streams: usize,
}

impl Default for DecoderPool {
    fn default() -> Self {
        Self { decoders: Mutex::new(HashMap::new()), stills: Mutex::new(HashMap::new()), max_streams: 12 }
    }
}

impl DecoderPool {
    /// Decode the frame at source time `t` scaled to `w`×`h`. `None` = no frame (e.g. empty file).
    pub fn frame(&self, src: &Source, t: f64, w: u32, h: u32) -> Result<Option<Frame>> {
        let (w, h) = (w.max(2) & !1, h.max(2) & !1);
        if src.still {
            let key = (src.path.clone(), w, h);
            if let Some(f) = self.stills.lock().get(&key) {
                return Ok(Some(f.clone()));
            }
            let f = decode_still(&src.path, w, h)?;
            let mut st = self.stills.lock();
            if st.len() > 64 {
                st.clear();
            }
            st.insert(key, f.clone());
            return Ok(Some(f));
        }
        let key = (src.path.clone(), w, h);
        let dec = {
            let mut map = self.decoders.lock();
            if map.len() >= self.max_streams && !map.contains_key(&key) {
                // Evict the least recently used idle stream.
                let victim = map
                    .iter()
                    .filter_map(|(k, d)| d.try_lock().map(|d| (k.clone(), d.stream.as_ref().map(|s| s.used).unwrap_or_else(Instant::now))))
                    .min_by_key(|(_, u)| *u)
                    .map(|(k, _)| k);
                if let Some(k) = victim {
                    map.remove(&k);
                }
            }
            map.entry(key).or_insert_with(|| Arc::new(Mutex::new(Decoder { src: src.clone(), w, h, stream: None }))).clone()
        };
        let mut d = dec.lock();
        d.get(t.max(0.0))
    }

    /// Drop all processes (e.g. on project close) and cached stills.
    pub fn clear(&self) {
        self.decoders.lock().clear();
        self.stills.lock().clear();
    }

    pub fn active_streams(&self) -> usize {
        self.decoders.lock().len()
    }
}

/// Decode the first frame of an image (or any media) at the given size.
pub fn decode_still(path: &str, w: u32, h: u32) -> Result<Frame> {
    let mut c = ffmpeg::ffmpeg()?;
    c.arg("-i").arg(path);
    c.args(["-frames:v", "1", "-vf", &format!("scale={w}:{h}:flags=bicubic"), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    let data = ffmpeg::run(c)?;
    if data.len() < (w * h * 4) as usize {
        return Err(MediaError::Unsupported(format!("could not decode image {path}")));
    }
    Ok(Frame { width: w, height: h, data: Arc::new(data[..(w * h * 4) as usize].to_vec()) })
}
