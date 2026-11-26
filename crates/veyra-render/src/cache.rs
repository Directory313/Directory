//! Rendered-frame cache: RAM LRU with a byte budget, backed by an optional disk tier.
//! Keys come from `veyra_core::ops::CacheKeys::frame_key`, so edits invalidate only the
//! frames whose contributing layers changed.

use crate::renderer::Image;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

pub struct FrameCache {
    inner: Mutex<Inner>,
}

struct Inner {
    map: HashMap<u64, Arc<Image>>,
    order: VecDeque<u64>,
    bytes: usize,
    budget: usize,
    disk: Option<PathBuf>,
    disk_budget: u64,
    disk_bytes: u64,
    hits: u64,
    misses: u64,
}

#[derive(serde::Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub frames: usize,
    pub ram_bytes: usize,
    pub ram_budget: usize,
    pub disk_bytes: u64,
    pub disk_budget: u64,
    pub hits: u64,
    pub misses: u64,
}

impl FrameCache {
    pub fn new(ram_budget: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
                budget: ram_budget,
                disk: None,
                disk_budget: 0,
                disk_bytes: 0,
                hits: 0,
                misses: 0,
            }),
        }
    }

    pub fn configure(&self, ram_budget: usize, disk: Option<PathBuf>, disk_budget: u64) {
        let mut i = self.inner.lock();
        i.budget = ram_budget;
        if let Some(d) = &disk {
            let _ = std::fs::create_dir_all(d);
            i.disk_bytes = std::fs::read_dir(d).map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
        }
        i.disk = disk;
        i.disk_budget = disk_budget;
        Self::evict(&mut i);
    }

    fn evict(i: &mut Inner) {
        while i.bytes > i.budget {
            let Some(k) = i.order.pop_front() else { break };
            if let Some(img) = i.map.remove(&k) {
                i.bytes -= img.data.len();
                // Spill to disk instead of discarding when a disk tier is configured.
                if let Some(d) = i.disk.clone() {
                    if i.disk_bytes + img.data.len() as u64 <= i.disk_budget {
                        let p = d.join(format!("{k:016x}.rgba"));
                        let mut buf = Vec::with_capacity(img.data.len() + 8);
                        buf.extend_from_slice(&img.width.to_le_bytes());
                        buf.extend_from_slice(&img.height.to_le_bytes());
                        buf.extend_from_slice(&img.data);
                        if std::fs::write(&p, &buf).is_ok() {
                            i.disk_bytes += buf.len() as u64;
                        }
                    }
                }
            }
        }
    }

    pub fn get(&self, key: u64) -> Option<Arc<Image>> {
        let mut i = self.inner.lock();
        if let Some(img) = i.map.get(&key).cloned() {
            i.hits += 1;
            if let Some(pos) = i.order.iter().position(|k| *k == key) {
                i.order.remove(pos);
            }
            i.order.push_back(key);
            return Some(img);
        }
        if let Some(d) = i.disk.clone() {
            let p = d.join(format!("{key:016x}.rgba"));
            if let Ok(buf) = std::fs::read(&p) {
                if buf.len() > 8 {
                    let w = u32::from_le_bytes(buf[0..4].try_into().unwrap());
                    let h = u32::from_le_bytes(buf[4..8].try_into().unwrap());
                    if buf.len() == 8 + (w * h * 4) as usize {
                        i.hits += 1;
                        let img = Arc::new(Image { width: w, height: h, data: buf[8..].to_vec() });
                        drop(i);
                        self.put(key, img.clone());
                        return Some(img);
                    }
                }
            }
        }
        i.misses += 1;
        None
    }

    pub fn contains(&self, key: u64) -> bool {
        let i = self.inner.lock();
        i.map.contains_key(&key) || i.disk.as_ref().is_some_and(|d| d.join(format!("{key:016x}.rgba")).exists())
    }

    pub fn put(&self, key: u64, img: Arc<Image>) {
        let mut i = self.inner.lock();
        if img.data.len() > i.budget {
            return;
        }
        if let Some(old) = i.map.insert(key, img.clone()) {
            i.bytes -= old.data.len();
            if let Some(pos) = i.order.iter().position(|k| *k == key) {
                i.order.remove(pos);
            }
        }
        i.bytes += img.data.len();
        i.order.push_back(key);
        Self::evict(&mut i);
    }

    pub fn clear(&self) {
        let mut i = self.inner.lock();
        i.map.clear();
        i.order.clear();
        i.bytes = 0;
        if let Some(d) = i.disk.clone() {
            let _ = std::fs::remove_dir_all(&d);
            let _ = std::fs::create_dir_all(&d);
            i.disk_bytes = 0;
        }
    }

    pub fn stats(&self) -> CacheStats {
        let i = self.inner.lock();
        CacheStats { frames: i.map.len(), ram_bytes: i.bytes, ram_budget: i.budget, disk_bytes: i.disk_bytes, disk_budget: i.disk_budget, hits: i.hits, misses: i.misses }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_respects_budget_and_spills() {
        let dir = std::env::temp_dir().join(format!("veyra-cache-{}", std::process::id()));
        let c = FrameCache::new(1000);
        c.configure(1000, Some(dir.clone()), 1 << 20);
        for k in 0..5u64 {
            c.put(k, Arc::new(Image { width: 10, height: 10, data: vec![k as u8; 400] }));
        }
        let s = c.stats();
        assert!(s.ram_bytes <= 1000);
        // Evicted frames come back from disk.
        let img = c.get(0).expect("spilled frame should be on disk");
        assert_eq!(img.data[0], 0);
        c.clear();
        assert!(c.get(4).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
