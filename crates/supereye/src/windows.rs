//! 窗口枚举、查找、置前

use crate::profile;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    ShowWindow, SW_RESTORE,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub hwnd: i32,
    pub process_id: u32,
    pub name: String,
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let results = lparam.0 as *mut Vec<WindowInfo>;
    if results.is_null() {
        return BOOL::from(true);
    }
    if hwnd.0.is_null() {
        return BOOL::from(true);
    }
    if IsWindowVisible(hwnd).as_bool() {
        if let Ok(info) = get_window_info(hwnd) {
            if !info.name.trim().is_empty() {
                (*results).push(info);
            }
        }
    }
    BOOL::from(true)
}

fn get_window_info(hwnd: HWND) -> Result<WindowInfo, String> {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(std::ptr::addr_of_mut!(pid)));

        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        let name = OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .trim()
            .to_string();

        Ok(WindowInfo {
            hwnd: hwnd.0 as i32,
            process_id: pid,
            name,
        })
    }
}

/// 枚举所有顶级窗口，返回可见且非空标题的窗口列表
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut collected = Vec::new();
    unsafe {
        let ptr = &mut collected as *mut Vec<WindowInfo>;
        EnumWindows(Some(enum_callback), LPARAM(ptr as isize)).map_err(|e| e.to_string())?;
    }
    Ok(collected)
}

/// 按名称/PID 查找窗口；name 为模糊包含匹配
pub fn find_window(
    name: &str,
    process_id: Option<u32>,
    exclude_pids: &[u32],
) -> Result<Option<WindowInfo>, String> {
    let name_lower = name.to_lowercase();
    let windows = list_windows()?;

    for w in windows {
        if exclude_pids.contains(&w.process_id) {
            continue;
        }
        if let Some(pid) = process_id {
            if w.process_id != pid {
                continue;
            }
        }
        if w.name.to_lowercase().contains(&name_lower) {
            return Ok(Some(w));
        }
    }
    Ok(None)
}

/// 按 Profile 查找窗口：尝试 profile 内所有 window_names，带重试（open_wait_ms 后首次，retry_interval_ms 间隔）
pub fn find_window_by_profile(app: &str, exclude_pids: &[u32]) -> Result<Option<WindowInfo>, String> {
    let p = match profile::get_profile(app) {
        Some(x) => x,
        None => return find_window(app, None, exclude_pids),
    };
    std::thread::sleep(std::time::Duration::from_millis(p.open_wait_ms));
    let mut exclude = p.exclude_pids.clone();
    exclude.extend(exclude_pids.iter().copied());
    for attempt in 0..p.retry_attempts {
        for name in &p.window_names {
            if let Ok(Some(w)) = find_window(name, None, &exclude) {
                return Ok(Some(w));
            }
        }
        if attempt + 1 < p.retry_attempts {
            std::thread::sleep(std::time::Duration::from_millis(p.retry_interval_ms));
        }
    }
    Ok(None)
}

/// 将窗口置前
pub fn bring_to_front(hwnd: i32) -> Result<(), String> {
    let h = HWND(hwnd as *mut _);
    unsafe {
        ShowWindow(h, SW_RESTORE).ok();
        if !SetForegroundWindow(h).as_bool() {
            return Err("SetForegroundWindow failed".to_string());
        }
    }
    Ok(())
}
