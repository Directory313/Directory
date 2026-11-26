//! Interchange: SRT / WebVTT subtitles, OpenTimelineIO JSON and CMX3600 EDL export.

use crate::model::*;

#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

fn parse_ts(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, sec) = match parts.len() {
        3 => (parts[0].parse::<f64>().ok()?, parts[1].parse::<f64>().ok()?, parts[2].parse::<f64>().ok()?),
        2 => (0.0, parts[0].parse::<f64>().ok()?, parts[1].parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Parses both SRT and WebVTT.
pub fn parse_subtitles(src: &str) -> Vec<Cue> {
    let src = src.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut cues = Vec::new();
    for block in src.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let mut it = lines[ti].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_ts(a), parse_ts(b)) else { continue };
        let text = lines[ti + 1..].join("\n");
        // strip simple tags like <i>
        let mut clean = String::new();
        let mut in_tag = false;
        for ch in text.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => clean.push(c),
                _ => {}
            }
        }
        if end > start {
            cues.push(Cue { start, end, text: clean });
        }
    }
    cues
}

fn ts(t: f64, sep: char) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}{}{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, sep, ms % 1000)
}

/// Export text layers of a composition as subtitles.
pub fn export_subtitles(comp: &Composition, vtt: bool) -> String {
    let mut cues: Vec<Cue> = comp
        .layers
        .iter()
        .filter_map(|l| match &l.kind {
            LayerKind::Text(t) if l.visible => Some(Cue { start: l.start, end: l.end(), text: t.text.value.clone() }),
            _ => None,
        })
        .collect();
    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    let mut out = String::new();
    if vtt {
        out.push_str("WEBVTT\n\n");
    }
    for (i, c) in cues.iter().enumerate() {
        if !vtt {
            out.push_str(&format!("{}\n", i + 1));
        }
        let sep = if vtt { '.' } else { ',' };
        out.push_str(&format!("{} --> {}\n{}\n\n", ts(c.start, sep), ts(c.end, sep), c.text));
    }
    out
}

/// OpenTimelineIO (schema Timeline.1) with one track per layer that references media.
pub fn export_otio(p: &Project, comp: &Composition) -> serde_json::Value {
    let rate = comp.fps;
    let rt = |t: f64| serde_json::json!({"OTIO_SCHEMA": "RationalTime.1", "rate": rate, "value": (t * rate).round()});
    let mut tracks = vec![];
    for l in comp.layers.iter().rev() {
        let (asset, kind) = match &l.kind {
            LayerKind::Media { asset } => (asset, "Video"),
            LayerKind::Audio { asset } => (asset, "Audio"),
            _ => continue,
        };
        let Some(a) = p.asset(asset) else { continue };
        let mut children = vec![];
        if l.start > 0.0 {
            children.push(serde_json::json!({"OTIO_SCHEMA": "Gap.1", "source_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(0.0), "duration": rt(l.start)}}));
        }
        children.push(serde_json::json!({
            "OTIO_SCHEMA": "Clip.2", "name": l.name,
            "source_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(l.source_in), "duration": rt(l.duration)},
            "media_references": {"DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": format!("file:///{}", a.path.replace('\\', "/"))}},
            "active_media_reference_key": "DEFAULT_MEDIA"
        }));
        tracks.push(serde_json::json!({"OTIO_SCHEMA": "Track.1", "name": l.name, "kind": kind, "children": children}));
    }
    serde_json::json!({
        "OTIO_SCHEMA": "Timeline.1", "name": comp.name,
        "global_start_time": rt(0.0),
        "tracks": {"OTIO_SCHEMA": "Stack.1", "name": "tracks", "children": tracks}
    })
}

fn tc(t: f64, fps: f64) -> String {
    let fr = fps.round().max(1.0) as u64;
    let f = (t.max(0.0) * fps).round() as u64;
    format!("{:02}:{:02}:{:02}:{:02}", f / (3600 * fr), (f / (60 * fr)) % 60, (f / fr) % 60, f % fr)
}

/// CMX3600 EDL of the video media layers, ordered by start time.
pub fn export_edl(p: &Project, comp: &Composition) -> String {
    let mut out = format!("TITLE: {}\nFCM: NON-DROP FRAME\n\n", comp.name);
    let mut ls: Vec<&Layer> = comp.layers.iter().filter(|l| matches!(l.kind, LayerKind::Media { .. })).collect();
    ls.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    for (i, l) in ls.iter().enumerate() {
        let LayerKind::Media { asset } = &l.kind else { continue };
        let name = p.asset(asset).map(|a| a.name.clone()).unwrap_or_default();
        out.push_str(&format!(
            "{:03}  AX       V     C        {} {} {} {}\n* FROM CLIP NAME: {}\n\n",
            i + 1,
            tc(l.source_in, comp.fps),
            tc(l.source_in + l.duration * l.speed, comp.fps),
            tc(l.start, comp.fps),
            tc(l.end(), comp.fps),
            name
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_and_vtt_parse_and_round_trip() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\nHello <i>world</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\nline\n";
        let cues = parse_subtitles(srt);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0], Cue { start: 1.0, end: 2.5, text: "Hello world".into() });
        assert_eq!(cues[1].text, "Second\nline");
        let vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 align:center\nHi\n";
        assert_eq!(parse_subtitles(vtt)[0].start, 1.0);
        assert_eq!(ts(3723.456, ','), "01:02:03,456");
    }
}
