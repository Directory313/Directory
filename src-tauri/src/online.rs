//! Online asset libraries: search Pixabay, Pexels, Sketchfab, Poly Haven and Openverse, and
//! download a chosen asset so it can be imported like any local file.
//!
//! Requests run here (not in the WebView) so API keys never touch page scripts and no extra
//! hosts need to be allowed by the content security policy. Results are normalised into
//! `OnlineItem`. Downloads go to Documents\Directory Projects\Downloaded Assets\<provider>.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

type R<T> = Result<T, String>;

const UA: &str = concat!("Directory/", env!("CARGO_PKG_VERSION"), " (desktop video editor)");

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        // reqwest is built without a bundled crypto provider (shared with the updater): use ring.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder().user_agent(UA).timeout(std::time::Duration::from_secs(30)).build().expect("http client")
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OnlineItem {
    pub provider: String,
    pub id: String,
    /// video | image | audio | model | hdri
    pub kind: String,
    pub title: String,
    pub author: String,
    pub license: String,
    pub license_url: String,
    pub thumb: String,
    pub page_url: String,
    /// Free to download and use (paid / non-downloadable items open the website instead).
    pub free: bool,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    /// Direct file URL when the search result already has it.
    pub download: String,
    pub ext: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub items: Vec<OnlineItem>,
    pub total: u64,
    /// Set when the provider needs an API key / token the user hasn't added yet.
    pub needs_key: Option<String>,
    /// Next page cursor (Sketchfab) or page number as text; empty when there is no more.
    pub next: String,
}

fn url_with(base: &str, params: &[(&str, &str)]) -> R<String> {
    reqwest::Url::parse_with_params(base, params).map(|u| u.to_string()).map_err(|e| e.to_string())
}

async fn get_json(url: &str, headers: &[(&str, &str)]) -> R<Value> {
    let mut req = client().get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| format!("Couldn't reach the server: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("The service refused the request: check the API key / token in Settings → Online Assets.".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Too many requests to this service: wait a minute and try again.".into());
    }
    if !status.is_success() {
        return Err(format!("The service answered {status}"));
    }
    resp.json::<Value>().await.map_err(|e| format!("Unexpected answer from the service: {e}"))
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn u(v: &Value, k: &str) -> u32 {
    v[k].as_u64().unwrap_or(0) as u32
}
fn ext_of(url: &str, fallback: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let file = path.rsplit('/').next().unwrap_or("");
    match file.rsplit_once('.') {
        Some((_, e)) if (1..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()) => e.to_ascii_lowercase(),
        _ => fallback.into(),
    }
}

// ------------------------------------------------------------------ providers

async fn pixabay(key: &str, kind: &str, query: &str, page: u32, id: Option<&str>) -> R<SearchResult> {
    if key.is_empty() {
        return Ok(SearchResult { needs_key: Some("pixabay".into()), ..Default::default() });
    }
    let video = kind == "video";
    let base = if video { "https://pixabay.com/api/videos/" } else { "https://pixabay.com/api/" };
    let page_s = page.to_string();
    let mut params = vec![("key", key), ("per_page", "30"), ("page", page_s.as_str()), ("safesearch", "true")];
    if let Some(id) = id { params.push(("id", id)); } else { params.push(("q", query)); }
    if !video { params.push(("image_type", "photo")); }
    let v = get_json(&url_with(base, &params)?, &[]).await?;
    let items = v["hits"].as_array().cloned().unwrap_or_default().iter().map(|h| {
        if video {
            let vids = &h["videos"];
            let pick = ["large", "medium", "small", "tiny"].iter().map(|q| &vids[*q]).find(|x| !s(x, "url").is_empty()).cloned().unwrap_or(Value::Null);
            OnlineItem {
                provider: "pixabay".into(), id: s(h, "id"), kind: "video".into(),
                title: s(h, "tags"), author: s(h, "user"), license: "Pixabay Content License".into(), license_url: "https://pixabay.com/service/license-summary/".into(),
                thumb: { let t = s(&vids["medium"], "thumbnail"); if t.is_empty() { s(&vids["tiny"], "thumbnail") } else { t } },
                page_url: s(h, "pageURL"), free: true, width: u(&pick, "width"), height: u(&pick, "height"), duration: h["duration"].as_f64().unwrap_or(0.0),
                download: s(&pick, "url"), ext: "mp4".into(),
            }
        } else {
            let full = s(h, "largeImageURL");
            OnlineItem {
                provider: "pixabay".into(), id: s(h, "id"), kind: "image".into(),
                title: s(h, "tags"), author: s(h, "user"), license: "Pixabay Content License".into(), license_url: "https://pixabay.com/service/license-summary/".into(),
                thumb: s(h, "webformatURL"), page_url: s(h, "pageURL"), free: true, width: u(h, "imageWidth"), height: u(h, "imageHeight"), duration: 0.0,
                ext: ext_of(&full, "jpg"), download: full,
            }
        }
    }).collect::<Vec<_>>();
    let total = v["totalHits"].as_u64().unwrap_or(0);
    let next = if (page as u64) * 30 < total { (page + 1).to_string() } else { String::new() };
    Ok(SearchResult { items, total, needs_key: None, next })
}

async fn pexels(key: &str, kind: &str, query: &str, page: u32, id: Option<&str>) -> R<SearchResult> {
    if key.is_empty() {
        return Ok(SearchResult { needs_key: Some("pexels".into()), ..Default::default() });
    }
    let video = kind == "video";
    let page_s = page.to_string();
    let url = match (video, id) {
        (true, Some(id)) => format!("https://api.pexels.com/videos/videos/{}", id.trim()),
        (false, Some(id)) => format!("https://api.pexels.com/v1/photos/{}", id.trim()),
        (true, None) => url_with("https://api.pexels.com/videos/search", &[("query", query), ("per_page", "30"), ("page", &page_s)])?,
        (false, None) => url_with("https://api.pexels.com/v1/search", &[("query", query), ("per_page", "30"), ("page", &page_s)])?,
    };
    let v = get_json(&url, &[("Authorization", key)]).await?;
    let list: Vec<Value> = if id.is_some() { vec![v.clone()] } else { v[if video { "videos" } else { "photos" }].as_array().cloned().unwrap_or_default() };
    let items = list.iter().map(|h| {
        if video {
            // Largest MP4 up to 1080p (4K files are huge to download for a preview edit).
            let mut files: Vec<Value> = h["video_files"].as_array().cloned().unwrap_or_default().into_iter().filter(|f| s(f, "file_type") == "video/mp4").collect();
            files.sort_by_key(|f| u(f, "height"));
            let pick = files.iter().rev().find(|f| u(f, "height") <= 1080).or(files.first()).cloned().unwrap_or(Value::Null);
            OnlineItem {
                provider: "pexels".into(), id: s(h, "id"), kind: "video".into(),
                title: s(h, "url").trim_end_matches('/').rsplit('/').next().unwrap_or("").rsplit_once('-').map(|x| x.0.replace('-', " ")).unwrap_or_default(),
                author: s(&h["user"], "name"), license: "Pexels License".into(), license_url: "https://www.pexels.com/license/".into(),
                thumb: s(h, "image"), page_url: s(h, "url"), free: true, width: u(&pick, "width"), height: u(&pick, "height"), duration: h["duration"].as_f64().unwrap_or(0.0),
                download: s(&pick, "link"), ext: "mp4".into(),
            }
        } else {
            let src = &h["src"];
            OnlineItem {
                provider: "pexels".into(), id: s(h, "id"), kind: "image".into(),
                title: { let a = s(h, "alt"); if a.is_empty() { "Photo".into() } else { a } }, author: s(h, "photographer"),
                license: "Pexels License".into(), license_url: "https://www.pexels.com/license/".into(),
                thumb: s(src, "medium"), page_url: s(h, "url"), free: true, width: u(h, "width"), height: u(h, "height"), duration: 0.0,
                download: s(src, "original"), ext: ext_of(&s(src, "original"), "jpg"),
            }
        }
    }).collect::<Vec<_>>();
    let total = v["total_results"].as_u64().unwrap_or(items.len() as u64);
    let next = if !v["next_page"].is_null() && id.is_none() { (page + 1).to_string() } else { String::new() };
    Ok(SearchResult { items, total, needs_key: None, next })
}

fn sketchfab_item(m: &Value) -> OnlineItem {
    let mut thumbs: Vec<Value> = m["thumbnails"]["images"].as_array().cloned().unwrap_or_default();
    thumbs.sort_by_key(|t| u(t, "width"));
    let thumb = thumbs.iter().find(|t| u(t, "width") >= 256).or(thumbs.last()).map(|t| s(t, "url")).unwrap_or_default();
    let downloadable = m["isDownloadable"].as_bool().unwrap_or(false);
    let paid = !m["price"].is_null() && m["price"].as_f64().unwrap_or(0.0) > 0.0;
    let license = m["license"]["label"].as_str().or(m["license"].as_str()).unwrap_or("").to_string();
    OnlineItem {
        provider: "sketchfab".into(), id: s(m, "uid"), kind: "model".into(), title: s(m, "name"), author: s(&m["user"], "displayName"),
        license: if license.is_empty() { if downloadable { "Creative Commons (see the model page)".into() } else { String::new() } } else { license },
        license_url: s(&m["license"], "url"),
        thumb, page_url: s(m, "viewerUrl"), free: downloadable && !paid, ext: "glb".into(), ..Default::default()
    }
}

async fn sketchfab(free_only: bool, query: &str, cursor: &str, id: Option<&str>) -> R<SearchResult> {
    if let Some(id) = id {
        let v = get_json(&format!("https://api.sketchfab.com/v3/models/{}", id.trim()), &[]).await?;
        return Ok(SearchResult { items: vec![sketchfab_item(&v)], total: 1, ..Default::default() });
    }
    let mut params = vec![("type", "models"), ("q", query), ("count", "24")];
    if free_only { params.push(("downloadable", "true")); }
    if !cursor.is_empty() { params.push(("cursor", cursor)); }
    let v = get_json(&url_with("https://api.sketchfab.com/v3/search", &params)?, &[]).await?;
    let items = v["results"].as_array().cloned().unwrap_or_default().iter().map(sketchfab_item).collect::<Vec<_>>();
    let next = v["cursors"]["next"].as_str().unwrap_or("").to_string();
    Ok(SearchResult { total: items.len() as u64, items, needs_key: None, next })
}

/// Poly Haven lists everything in one call per type; cached for the session and filtered here.
async fn polyhaven(kind: &str, query: &str, page: u32, id: Option<&str>) -> R<SearchResult> {
    static CACHE: OnceLock<parking_lot::Mutex<std::collections::HashMap<String, Value>>> = OnceLock::new();
    let t = match kind { "hdri" => "hdris", "image" => "textures", _ => "models" };
    let cache = CACHE.get_or_init(Default::default);
    // Take the cached value out first: the lock must not be held across the network wait.
    let cached = cache.lock().get(t).cloned();
    let all = match cached {
        Some(v) => v,
        None => {
            let v = get_json(&format!("https://api.polyhaven.com/assets?t={t}"), &[]).await?;
            cache.lock().insert(t.into(), v.clone());
            v
        }
    };
    let q = query.to_lowercase();
    let mut hits: Vec<(String, Value)> = all.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    hits.retain(|(k, v)| {
        if let Some(id) = id { return k == id; }
        if q.is_empty() { return true; }
        let hay = format!("{} {} {} {}", k, s(v, "name"), v["tags"], v["categories"]).to_lowercase();
        q.split_whitespace().all(|w| hay.contains(w))
    });
    hits.sort_by(|a, b| b.1["download_count"].as_u64().cmp(&a.1["download_count"].as_u64()));
    let total = hits.len() as u64;
    let start = ((page.max(1) - 1) * 30) as usize;
    let items = hits.into_iter().skip(start).take(30).map(|(k, v)| OnlineItem {
        provider: "polyhaven".into(), kind: match t { "hdris" => "hdri", "textures" => "image", _ => "model" }.into(),
        title: s(&v, "name"), author: v["authors"].as_object().map(|a| a.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default(),
        license: "CC0 (public domain)".into(), license_url: "https://polyhaven.com/license".into(),
        thumb: format!("https://cdn.polyhaven.com/asset_img/thumbs/{k}.png?width=256&height=256"),
        page_url: format!("https://polyhaven.com/a/{k}"), free: true, ext: match t { "hdris" => "hdr", "textures" => "jpg", _ => "gltf" }.into(),
        id: k, ..Default::default()
    }).collect::<Vec<_>>();
    let next = if (start + 30) < total as usize { (page.max(1) + 1).to_string() } else { String::new() };
    Ok(SearchResult { items, total, needs_key: None, next })
}

async fn openverse(kind: &str, query: &str, page: u32) -> R<SearchResult> {
    let audio = kind == "audio";
    let base = if audio { "https://api.openverse.org/v1/audio/" } else { "https://api.openverse.org/v1/images/" };
    let page_s = page.to_string();
    let v = get_json(&url_with(base, &[("q", query), ("page_size", "20"), ("page", &page_s)])?, &[]).await?;
    let items = v["results"].as_array().cloned().unwrap_or_default().iter().map(|h| {
        let lic = format!("CC {} {}", s(h, "license").to_uppercase(), s(h, "license_version")).trim().to_string();
        let lic = if s(h, "license") == "cc0" { "CC0 (public domain)".into() } else if s(h, "license") == "pdm" { "Public domain".into() } else { lic };
        let url = s(h, "url");
        OnlineItem {
            provider: "openverse".into(), id: s(h, "id"), kind: if audio { "audio" } else { "image" }.into(),
            title: s(h, "title"), author: s(h, "creator"), license: lic, license_url: s(h, "license_url"),
            thumb: s(h, "thumbnail"), page_url: s(h, "foreign_landing_url"), free: true,
            width: u(h, "width"), height: u(h, "height"), duration: h["duration"].as_f64().unwrap_or(0.0) / 1000.0,
            ext: ext_of(&url, if audio { "mp3" } else { "jpg" }), download: url,
        }
    }).collect::<Vec<_>>();
    let total = v["result_count"].as_u64().unwrap_or(0);
    let next = if (page as u64) < v["page_count"].as_u64().unwrap_or(0) { (page + 1).to_string() } else { String::new() };
    Ok(SearchResult { items, total, needs_key: None, next })
}

/// Search one provider. `page` is the page number or Sketchfab's cursor; `id` looks up one asset.
#[tauri::command]
pub async fn online_search(app: AppHandle, provider: String, kind: String, query: String, page: String, free_only: bool, id: Option<String>) -> R<SearchResult> {
    let (pixabay_key, pexels_key) = {
        let st = app.state::<AppState>();
        let s = st.settings.read();
        (s.pixabay_key.trim().to_string(), s.pexels_key.trim().to_string())
    };
    let n = page.parse::<u32>().unwrap_or(1).max(1);
    let id = id.as_deref().filter(|x| !x.is_empty());
    match provider.as_str() {
        "pixabay" => pixabay(&pixabay_key, &kind, &query, n, id).await,
        "pexels" => pexels(&pexels_key, &kind, &query, n, id).await,
        "sketchfab" => sketchfab(free_only, &query, &page, id).await,
        "polyhaven" => polyhaven(&kind, &query, n, id).await,
        "openverse" => openverse(&kind, &query, n).await,
        _ => Err(format!("Unknown source {provider}")),
    }
}

// ------------------------------------------------------------------ downloading

fn safe_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { ' ' }).collect();
    let n = n.split_whitespace().collect::<Vec<_>>().join(" ");
    let n: String = n.chars().take(60).collect();
    if n.is_empty() { "asset".into() } else { n }
}

async fn fetch_to(app: &AppHandle, key: &str, url: &str, headers: &[(&str, &str)], path: &PathBuf) -> R<()> {
    let mut req = client().get(url).timeout(std::time::Duration::from_secs(60 * 30));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let mut resp = req.send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: the server answered {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let (mut got, mut last) = (0u64, 0u64);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if got - last > 512 * 1024 {
            last = got;
            let _ = app.emit("online-download", serde_json::json!({ "key": key, "got": got, "total": total }));
        }
    }
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    let _ = app.emit("online-download", serde_json::json!({ "key": key, "got": got, "total": total.max(got) }));
    Ok(())
}

/// Download an asset and return the local file to import (for glTF, the .gltf next to its files).
#[tauri::command]
pub async fn online_download(app: AppHandle, item: OnlineItem) -> R<String> {
    if !item.free {
        return Err("This asset isn't free to download. Open it on the website instead.".into());
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let root = docs.join("Directory Projects").join("Downloaded Assets").join(&item.provider);
    let base = format!("{} {}", safe_name(&item.title), safe_name(&item.id));
    let key = format!("{}:{}", item.provider, item.id);
    let token = app.state::<AppState>().settings.read().sketchfab_token.trim().to_string();

    match item.provider.as_str() {
        "sketchfab" => {
            if token.is_empty() {
                return Err("NEEDS_KEY:sketchfab".into());
            }
            let auth = format!("Token {token}");
            let v = get_json(&format!("https://api.sketchfab.com/v3/models/{}/download", item.id), &[("Authorization", &auth)]).await?;
            let url = s(&v["glb"], "url");
            if url.is_empty() {
                return Err("Sketchfab didn't offer a GLB download for this model.".into());
            }
            let path = root.join(format!("{base}.glb"));
            if !path.exists() {
                fetch_to(&app, &key, &url, &[], &path).await?;
            }
            Ok(path.to_string_lossy().into())
        }
        "polyhaven" => {
            let v = get_json(&format!("https://api.polyhaven.com/files/{}", item.id), &[]).await?;
            match item.kind.as_str() {
                "hdri" => {
                    let url = ["2k", "1k", "4k"].iter().map(|r| s(&v["hdri"][*r]["hdr"], "url")).find(|u| !u.is_empty()).ok_or("No HDR file found")?;
                    let path = root.join(format!("{base}.hdr"));
                    if !path.exists() { fetch_to(&app, &key, &url, &[], &path).await?; }
                    Ok(path.to_string_lossy().into())
                }
                "image" => {
                    let diff = ["Diffuse", "diffuse", "diff_png", "Color"].iter().map(|k| &v[*k]).find(|x| !x.is_null()).cloned().unwrap_or(Value::Null);
                    let url = ["2k", "1k", "4k"].iter().flat_map(|r| ["jpg", "png"].map(move |e| (r, e))).map(|(r, e)| s(&diff[*r][e], "url")).find(|u| !u.is_empty()).ok_or("No texture image found")?;
                    let path = root.join(format!("{base}.{}", ext_of(&url, "jpg")));
                    if !path.exists() { fetch_to(&app, &key, &url, &[], &path).await?; }
                    Ok(path.to_string_lossy().into())
                }
                _ => {
                    // glTF: the .gltf plus its buffers and textures, kept at their relative paths.
                    let g = ["2k", "1k", "4k"].iter().map(|r| &v["gltf"][*r]["gltf"]).find(|x| !s(x, "url").is_empty()).cloned().ok_or("No glTF download found")?;
                    let dir = root.join(&base);
                    let main = dir.join(format!("{}.gltf", safe_name(&item.id)));
                    if !main.exists() {
                        if let Some(inc) = g["include"].as_object() {
                            for (rel, f) in inc {
                                if rel.contains("..") { continue; }
                                fetch_to(&app, &key, &s(f, "url"), &[], &dir.join(rel)).await?;
                            }
                        }
                        fetch_to(&app, &key, &s(&g, "url"), &[], &main).await?;
                    }
                    Ok(main.to_string_lossy().into())
                }
            }
        }
        _ => {
            if item.download.is_empty() {
                return Err("No downloadable file for this asset.".into());
            }
            let path = root.join(format!("{base}.{}", if item.ext.is_empty() { ext_of(&item.download, "bin") } else { item.ext.clone() }));
            if !path.exists() {
                fetch_to(&app, &key, &item.download, &[], &path).await?;
            }
            Ok(path.to_string_lossy().into())
        }
    }
}

/// Open a web page in the default browser (https links only).
#[tauri::command]
pub fn open_url(url: String) -> R<()> {
    let ok = reqwest::Url::parse(&url).map(|u| u.scheme() == "https").unwrap_or(false);
    if !ok {
        return Err("Only https links can be opened".into());
    }
    std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The folder downloaded assets are saved in (to show or clean up).
#[tauri::command]
pub fn online_folder(app: AppHandle) -> R<String> {
    let p = app.path().document_dir().map_err(|e| e.to_string())?.join("Directory Projects").join("Downloaded Assets");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check against the no-key services (network). Run with:
    /// cargo test -p veyra --lib online -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_search_no_key_sources() {
        tauri::async_runtime::block_on(async {
            let ph = polyhaven("model", "chair", 1, None).await.expect("poly haven");
            assert!(!ph.items.is_empty(), "poly haven returned no chairs");
            println!("poly haven: {} chairs, first {:?} {}", ph.total, ph.items[0].title, ph.items[0].thumb);
            let ov = openverse("image", "city night", 1).await.expect("openverse");
            assert!(!ov.items.is_empty());
            println!("openverse: {} results, first licence {:?}", ov.total, ov.items[0].license);
            let sf = sketchfab(true, "chair", "", None).await.expect("sketchfab");
            assert!(sf.items.iter().all(|i| i.free));
            println!("sketchfab: {} free models, next cursor {}", sf.items.len(), !sf.next.is_empty());
        });
    }
}
