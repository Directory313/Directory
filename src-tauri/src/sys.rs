//! Windows system queries: memory, disk space, Blender discovery.

use std::path::{Path, PathBuf};

#[cfg(windows)]
#[allow(non_snake_case)]
mod win {
    #[repr(C)]
    pub struct MEMORYSTATUSEX {
        pub dwLength: u32,
        pub dwMemoryLoad: u32,
        pub ullTotalPhys: u64,
        pub ullAvailPhys: u64,
        pub ullTotalPageFile: u64,
        pub ullAvailPageFile: u64,
        pub ullTotalVirtual: u64,
        pub ullAvailVirtual: u64,
        pub ullAvailExtendedVirtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
        pub fn GetDiskFreeSpaceExW(dir: *const u16, free_to_caller: *mut u64, total: *mut u64, total_free: *mut u64) -> i32;
    }
}

/// (total RAM GB, free disk GB at `path`).
pub fn memory_and_disk(path: &Path) -> (f64, f64) {
    #[cfg(windows)]
    unsafe {
        let mut m: win::MEMORYSTATUSEX = std::mem::zeroed();
        m.dwLength = std::mem::size_of::<win::MEMORYSTATUSEX>() as u32;
        let ram = if win::GlobalMemoryStatusEx(&mut m) != 0 { m.ullTotalPhys as f64 / 1073741824.0 } else { 0.0 };
        use std::os::windows::ffi::OsStrExt;
        let root: Vec<u16> = path.ancestors().last().unwrap_or(path).as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let (mut free, mut total, mut tfree) = (0u64, 0u64, 0u64);
        let disk = if win::GetDiskFreeSpaceExW(root.as_ptr(), &mut free, &mut total, &mut tfree) != 0 { free as f64 / 1073741824.0 } else { 0.0 };
        (ram, disk)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        (0.0, 0.0)
    }
}

/// Free bytes on the drive holding `path` (the frame cache's low-space guard).
pub fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let root: Vec<u16> = path.ancestors().last().unwrap_or(path).as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let (mut free, mut total, mut tfree) = (0u64, 0u64, 0u64);
        (win::GetDiskFreeSpaceExW(root.as_ptr(), &mut free, &mut total, &mut tfree) != 0).then_some(free)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

pub fn find_blender(configured: &str) -> Option<String> {
    if !configured.is_empty() && Path::new(configured).is_file() {
        return Some(configured.to_string());
    }
    let mut cands: Vec<PathBuf> = vec![];
    for base in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramFiles(x86)").ok()].into_iter().flatten() {
        let bf = Path::new(&base).join("Blender Foundation");
        if let Ok(rd) = std::fs::read_dir(&bf) {
            let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            dirs.sort();
            dirs.reverse();
            cands.extend(dirs.into_iter().map(|d| d.join("blender.exe")));
        }
    }
    if let Some(p) = std::env::var_os("PATH") {
        cands.extend(std::env::split_paths(&p).map(|d| d.join("blender.exe")));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        cands.push(Path::new(&la).join("Programs").join("Blender Foundation").join("Blender").join("blender.exe"));
    }
    cands.into_iter().find(|p| p.is_file()).map(|p| p.to_string_lossy().to_string())
}
