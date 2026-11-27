//! Rendered-frame cache: RAM LRU with a byte budget, backed by an optional disk tier.
//! Keys come from `veyra_core::ops::CacheKeys::frame_key`, so edits invalidate only the
//! frames whose contributing layers changed.
//!
//! The disk tier is opt-in (off by default in the app). When on, it is an LRU with its own
//! byte budget, never writes while the drive is below `min_free` bytes free, and is wiped by
//! `shutdown` when the app closes, so it cannot accumulate across sessions.

use crate::renderer::Image;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Returns free bytes on the drive holding the given path (None when unknown).
pub type FreeSpaceProbe = fn(&Path) -> Option<u64>;

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
    /// Files on disk, oldest first, with their sizes (for LRU eviction).
    disk_order: VecDeque<(u64, u64)>,
    disk_index: HashMap<u64, u64>,
    min_free: u64,
    probe: Option<FreeSpaceProbe>,
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

fn file_for(dir: &Path, key: u64) -> PathBuf {
    dir.join(format!("{key:016x}.rgba"))
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
                disk_order: VecDeque::new(),
                disk_index: HashMap::new(),
                min_free: 0,
                probe: None,
                hits: 0,
                misses: 0,
            }),
        }
    }

    /// Never write cache files while the drive has less than `min_free` bytes free.
    pub fn set_free_space_guard(&self, min_free: u64, probe: FreeSpaceProbe) {
        let mut i = self.inner.lock();
        i.min_free = min_free;
        i.probe = Some(probe);
    }

    /// Sets the RAM budget and the disk tier (`None` = RAM only). Frames already on disk from
    /// an earlier configuration are deleted: their keys may be stale and they are not indexed.
    pub fn configure(&self, ram_budget: usize, disk: Option<PathBuf>, disk_budget: u64) {
        let mut i = self.inner.lock();
        i.budget = ram_budget;
        let old = i.disk.take();
        for d in old.iter().chain(disk.iter()) {
            let _ = std::fs::remove_dir_all(d);
        }
        i.disk_order.clear();
        i.disk_index.clear();
        i.disk_bytes = 0;
        if let Some(d) = &disk {
            let _ = std::fs::create_dir_all(d);
        }
        i.disk = disk.filter(|_| disk_budget > 0);
        i.disk_budget = disk_budget;
        Self::evict(&mut i);
    }

    /// Total bytes the cache can hold (RAM plus disk tier).
    pub fn capacity(&self) -> u64 {
        let i = self.inner.lock();
        i.budget as u64 + if i.disk.is_some() { i.disk_budget } else { 0 }
    }

    fn evict(i: &mut Inner) {
        while i.bytes > i.budget {
            let Some(k) = i.order.pop_front() else { break };
            if let Some(img) = i.map.remove(&k) {
                i.bytes -= img.data.len();
                // Spill to disk instead of discarding when a disk tier is configured.
                Self::spill(i, k, &img);
            }
        }
    }

    fn spill(i: &mut Inner, key: u64, img: &Image) {
        let Some(dir) = i.disk.clone() else { return };
        if i.disk_index.contains_key(&key) {
            return;
        }
        let size = img.data.len() as u64 + 8;
        if size > i.disk_budget {
            return;
        }
        // Make room under the budget by dropping the oldest files.
        while i.disk_bytes + size > i.disk_budget {
            let Some((k, n)) = i.disk_order.pop_front() else { break };
            if i.disk_index.remove(&k).is_some() {
                let _ = std::fs::remove_file(file_for(&dir, k));
                i.disk_bytes = i.disk_bytes.saturating_sub(n);
            }
        }
        if let Some(probe) = i.probe {
            if probe(&dir).is_some_and(|free| free < i.min_free + size) {
                return;
            }
        }
        let mut buf = Vec::with_capacity(size as usize);
        buf.extend_from_slice(&img.width.to_le_bytes());
        buf.extend_from_slice(&img.height.to_le_bytes());
        buf.extend_from_slice(&img.data);
        if std::fs::write(file_for(&dir, key), &buf).is_ok() {
            i.disk_bytes += size;
            i.disk_order.push_back((key, size));
            i.disk_index.insert(key, size);
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
        if let (Some(d), true) = (i.disk.clone(), i.disk_index.contains_key(&key)) {
            if let Ok(buf) = std::fs::read(file_for(&d, key)) {
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
        i.map.contains_key(&key) || i.disk_index.contains_key(&key)
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
        }
        i.disk_order.clear();
        i.disk_index.clear();
        i.disk_bytes = 0;
    }

    /// Frees everything, including the disk tier's folder. Called when the app closes.
    pub fn shutdown(&self) {
        let mut i = self.inner.lock();
        i.map.clear();
        i.order.clear();
        i.bytes = 0;
        if let Some(d) = i.disk.take() {
            let _ = std::fs::remove_dir_all(&d);
        }
        i.disk_order.clear();
        i.disk_index.clear();
        i.disk_bytes = 0;
    }

    pub fn stats(&self) -> CacheStats {
        let i = self.inner.lock();
        CacheStats { frames: i.map.len() + i.disk_index.len(), ram_bytes: i.bytes, ram_budget: i.budget, disk_bytes: i.disk_bytes, disk_budget: i.disk_budget, hits: i.hits, misses: i.misses }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(k: u64) -> Arc<Image> {
        Arc::new(Image { width: 10, height: 10, data: vec![k as u8; 400] })
    }

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veyra-cache-{name}-{}", std::process::id()))
    }

    fn files(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|r| r.count()).unwrap_or(0)
    }

    #[test]
    fn lru_respects_budget_and_spills() {
        let dir = temp("spill");
        let c = FrameCache::new(1000);
        c.configure(1000, Some(dir.clone()), 1 << 20);
        for k in 0..5u64 {
            c.put(k, img(k));
        }
        let s = c.stats();
        assert!(s.ram_bytes <= 1000);
        // Evicted frames come back from disk.
        let got = c.get(0).expect("spilled frame should be on disk");
        assert_eq!(got.data[0], 0);
        c.clear();
        assert!(c.get(4).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ram_only_writes_nothing_to_disk() {
        let dir = temp("ramonly");
        let c = FrameCache::new(1000);
        c.configure(1000, None, 0);
        for k in 0..20u64 {
            c.put(k, img(k));
        }
        assert!(c.stats().ram_bytes <= 1000);
        assert_eq!(c.stats().disk_bytes, 0);
        assert!(!dir.exists());
    }

    #[test]
    fn disk_tier_stays_within_budget() {
        let dir = temp("budget");
        let c = FrameCache::new(400);
        // Room for two 408-byte files on disk.
        c.configure(400, Some(dir.clone()), 900);
        for k in 0..10u64 {
            c.put(k, img(k));
        }
        assert!(c.stats().disk_bytes <= 900);
        assert!(files(&dir) <= 2, "old files must be deleted, found {}", files(&dir));
        // The newest spilled frame is still available, the oldest are gone.
        assert!(c.contains(8));
        assert!(!c.contains(0));
        c.shutdown();
        assert!(!dir.exists(), "shutdown deletes the cache folder");
    }

    #[test]
    fn low_disk_space_stops_writes() {
        let dir = temp("lowfree");
        let c = FrameCache::new(400);
        c.configure(400, Some(dir.clone()), 1 << 20);
        c.set_free_space_guard(5 << 30, |_| Some(1 << 30)); // 1 GB free, 5 GB must stay free
        for k in 0..10u64 {
            c.put(k, img(k));
        }
        assert_eq!(c.stats().disk_bytes, 0);
        assert_eq!(files(&dir), 0);
        c.shutdown();
    }
}
