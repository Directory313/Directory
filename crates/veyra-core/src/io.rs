//! Project persistence: atomic saves, rotating backups, schema migration and media relinking.

use crate::model::*;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("could not read project: {0}")]
    Read(std::io::Error),
    #[error("could not write project: {0}")]
    Write(std::io::Error),
    #[error("project file is corrupt or not a VEYRA project: {0}")]
    Parse(serde_json::Error),
    #[error("project was saved by a newer VEYRA (schema {0}); please update")]
    TooNew(u32),
    #[error("project failed validation: {0}")]
    Invalid(String),
}

/// Relative path from `base` dir to `target`, if both are on the same drive.
pub fn relative_to(target: &Path, base: &Path) -> Option<String> {
    let t: Vec<Component> = target.components().collect();
    let b: Vec<Component> = base.components().collect();
    if t.first() != b.first() {
        return None;
    }
    let common = t.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let mut out = PathBuf::new();
    for _ in common..b.len() {
        out.push("..");
    }
    for c in &t[common..] {
        out.push(c.as_os_str());
    }
    Some(out.to_string_lossy().replace('\\', "/"))
}

pub fn validate(p: &Project) -> Result<(), String> {
    if p.compositions.is_empty() {
        return Err("project has no compositions".into());
    }
    if p.comp(&p.active_comp).is_none() {
        return Err("active composition does not exist".into());
    }
    p.check_nesting()?;
    for c in &p.compositions {
        if c.width == 0 || c.height == 0 || c.width > 16384 || c.height > 16384 {
            return Err(format!("composition '{}' has an invalid size", c.name));
        }
        if !(c.fps > 0.0 && c.fps <= 1000.0) {
            return Err(format!("composition '{}' has an invalid frame rate", c.name));
        }
        for l in &c.layers {
            if !(l.duration.is_finite() && l.start.is_finite() && l.duration > 0.0) {
                return Err(format!("layer '{}' has invalid timing", l.name));
            }
        }
    }
    Ok(())
}

/// Serialise and write atomically: write to a temp file in the same directory, flush to disk,
/// rotate the previous version into `Backups/`, then rename over the target. A crash at any
/// point leaves either the old or the new file intact, never a truncated one.
pub fn save(project: &Project, path: &Path, keep_backups: usize) -> Result<(), IoError> {
    validate(project).map_err(IoError::Invalid)?;
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(IoError::Write)?;
    let mut p = project.clone();
    p.schema_version = SCHEMA_VERSION;
    for a in &mut p.assets {
        a.relative_path = relative_to(Path::new(&a.path), dir);
        a.missing = false;
    }
    let json = serde_json::to_vec_pretty(&p).map_err(|e| IoError::Write(std::io::Error::other(e)))?;
    // Round-trip check: never write something we cannot read back.
    serde_json::from_slice::<Project>(&json).map_err(IoError::Parse)?;

    let tmp = path.with_extension("veyra.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(IoError::Write)?;
        f.write_all(&json).map_err(IoError::Write)?;
        f.sync_all().map_err(IoError::Write)?;
    }
    if path.exists() && keep_backups > 0 {
        let bdir = dir.join("Backups");
        if fs::create_dir_all(&bdir).is_ok() {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = fs::copy(path, bdir.join(format!("{stem}.{stamp}.veyra")));
            prune_backups(&bdir, &stem, keep_backups);
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        IoError::Write(e)
    })?;
    Ok(())
}

fn prune_backups(dir: &Path, stem: &str, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&format!("{stem}.")))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort();
    while files.len() > keep {
        let (_, p) = files.remove(0);
        let _ = fs::remove_file(p);
    }
}

/// Upgrade older documents in place. Version 1 is the first public schema.
fn migrate(v: &mut serde_json::Value) -> Result<(), IoError> {
    let ver = v.get("schemaVersion").and_then(|x| x.as_u64()).unwrap_or(1) as u32;
    if ver > SCHEMA_VERSION {
        return Err(IoError::TooNew(ver));
    }
    // Future migrations: `if ver < 2 { ... }`
    v["schemaVersion"] = SCHEMA_VERSION.into();
    Ok(())
}

pub fn parse(bytes: &[u8]) -> Result<Project, IoError> {
    let mut v: serde_json::Value = serde_json::from_slice(bytes).map_err(IoError::Parse)?;
    migrate(&mut v)?;
    let p: Project = serde_json::from_value(v).map_err(IoError::Parse)?;
    validate(&p).map_err(IoError::Invalid)?;
    Ok(p)
}

/// Load a project and resolve media: relative path first (portable projects), then the
/// absolute path; anything not found is flagged `missing` for the relink UI.
pub fn load(path: &Path) -> Result<Project, IoError> {
    let bytes = fs::read(path).map_err(IoError::Read)?;
    let mut p = parse(&bytes)?;
    let dir = path.parent().unwrap_or(Path::new("."));
    resolve_media(&mut p, dir);
    Ok(p)
}

pub fn resolve_media(p: &mut Project, project_dir: &Path) {
    for a in &mut p.assets {
        if let Some(rel) = &a.relative_path {
            let cand = project_dir.join(rel);
            if cand.exists() {
                a.path = cand.canonicalize().map(|c| strip_unc(&c)).unwrap_or_else(|_| cand.to_string_lossy().to_string());
                a.missing = false;
                continue;
            }
        }
        a.missing = !asset_exists(a);
    }
}

fn asset_exists(a: &Asset) -> bool {
    if a.sequence_pattern.is_some() {
        return Path::new(&a.path).parent().map(|d| d.exists()).unwrap_or(false);
    }
    Path::new(&a.path).exists()
}

pub fn strip_unc(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

/// Relink: point every missing asset whose file name exists under `search_dir` at that file.
/// Returns the number of assets relinked.
pub fn relink_in_dir(p: &mut Project, search_dir: &Path) -> usize {
    let mut found = 0;
    let mut index = std::collections::HashMap::new();
    let mut stack = vec![search_dir.to_path_buf()];
    let mut visited = 0;
    while let Some(d) = stack.pop() {
        visited += 1;
        if visited > 20000 {
            break;
        }
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(n) = path.file_name() {
                index.entry(n.to_string_lossy().to_lowercase()).or_insert(path);
            }
        }
    }
    for a in p.assets.iter_mut().filter(|a| a.missing) {
        let name = Path::new(&a.path).file_name().map(|n| n.to_string_lossy().to_lowercase());
        if let Some(hit) = name.and_then(|n| index.get(&n)) {
            a.path = hit.to_string_lossy().to_string();
            a.missing = false;
            found += 1;
        }
    }
    found
}

/// Copy all media into `<project dir>/Media` and repoint assets (Collect Files / Consolidate).
pub fn collect_media(p: &mut Project, project_dir: &Path) -> Result<usize, std::io::Error> {
    let media = project_dir.join("Media");
    fs::create_dir_all(&media)?;
    let mut n = 0;
    for a in p.assets.iter_mut().filter(|a| !a.missing && a.sequence_pattern.is_none()) {
        let src = PathBuf::from(&a.path);
        if src.starts_with(&media) {
            continue;
        }
        let Some(fname) = src.file_name() else { continue };
        let mut dst = media.join(fname);
        let mut i = 1;
        while dst.exists() && fs::metadata(&dst).map(|m| m.len()).ok() != fs::metadata(&src).map(|m| m.len()).ok() {
            dst = media.join(format!("{}_{i}.{}", src.file_stem().unwrap_or_default().to_string_lossy(), src.extension().unwrap_or_default().to_string_lossy()));
            i += 1;
        }
        if !dst.exists() {
            fs::copy(&src, &dst)?;
        }
        a.path = dst.to_string_lossy().to_string();
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        let r = relative_to(Path::new("C:/a/b/media/x.mp4"), Path::new("C:/a/b/proj")).unwrap();
        assert_eq!(r, "../media/x.mp4");
        assert_eq!(relative_to(Path::new("D:/x.mp4"), Path::new("C:/a")), None);
    }

    #[test]
    fn save_load_round_trip_and_backup() {
        let dir = std::env::temp_dir().join(format!("veyra-io-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.veyra");
        let mut p = Project::new("Round trip");
        let comp = p.compositions[0].clone();
        let mut l = crate::factory::text_layer(&comp, "Hello", 0.0);
        l.transform.position.set_key(0.0, [0.0, 0.0, 0.0]);
        l.transform.position.set_key(1.0, [100.0, 50.0, 0.0]);
        l.effects.push(crate::registry::instantiate("gaussianBlur").unwrap());
        l.masks.push(crate::factory::mask("ellipse", 100.0, 100.0));
        p.compositions[0].layers.push(l);
        save(&p, &path, 3).unwrap();
        save(&p, &path, 3).unwrap();
        let q = load(&path).unwrap();
        assert_eq!(p.compositions, q.compositions);
        assert!(dir.join("Backups").read_dir().unwrap().count() >= 1);
        // Corrupt input is rejected, not panicked on.
        assert!(parse(b"{not json").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_newer_schema_and_cycles() {
        let mut p = Project::new("x");
        let mut v = serde_json::to_value(&p).unwrap();
        v["schemaVersion"] = 999.into();
        assert!(matches!(parse(&serde_json::to_vec(&v).unwrap()), Err(IoError::TooNew(999))));
        let cid = p.compositions[0].id.clone();
        let comp = p.compositions[0].clone();
        let l = crate::factory::comp_layer(&comp, &comp, 0.0);
        p.compositions[0].layers.push(l);
        assert!(validate(&p).is_err(), "self-nesting must be rejected ({cid})");
    }
}
