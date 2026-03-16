//! UIA 元素树、locator 查找

use serde::{Deserialize, Serialize};
use uiautomation::core::{UIAutomation, UIElement};
use uiautomation::types::Handle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementInfo {
    pub hwnd: i32,
    pub name: Option<String>,
    pub role: Option<String>,
    pub automation_id: Option<String>,
    pub rect: Option<Rect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Locator {
    pub name: Option<String>,
    pub role: Option<String>,
    pub automation_id: Option<String>,
    pub index: Option<u32>,
}

fn to_handle(hwnd: i32) -> Handle {
    Handle::from(hwnd as isize)
}

/// 获取窗口内 UIA 树（简化，仅顶级可交互元素）
pub fn get_element_tree(hwnd: i32, max_depth: Option<u32>) -> Result<Vec<ElementInfo>, String> {
    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let elem = automation
        .element_from_handle(to_handle(hwnd))
        .map_err(|e| e.to_string())?;

    let walker = automation.get_control_view_walker().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    collect_elements(&walker, &elem, 0, max_depth.unwrap_or(10), &mut out);
    Ok(out)
}

fn collect_elements(
    walker: &uiautomation::core::UITreeWalker,
    elem: &UIElement,
    depth: u32,
    max: u32,
    out: &mut Vec<ElementInfo>,
) {
    if depth >= max {
        return;
    }
    if let Some(children) = walker.get_children(elem) {
        for child in children {
            if let Ok(info) = element_to_info(&child) {
                out.push(info);
            }
            collect_elements(walker, &child, depth + 1, max, out);
        }
    }
}

fn element_to_info(elem: &UIElement) -> Result<ElementInfo, String> {
    let hwnd = elem
        .get_native_window_handle()
        .map(|h: Handle| <Handle as Into<isize>>::into(h) as i32)
        .unwrap_or(0);
    let name = elem.get_name().ok();
    let role = elem.get_control_type().map(|c| format!("{:?}", c)).ok();
    let automation_id = elem.get_automation_id().ok();
    let rect = elem.get_bounding_rectangle().ok().map(|r| Rect {
        left: r.get_left() as f64,
        top: r.get_top() as f64,
        right: r.get_right() as f64,
        bottom: r.get_bottom() as f64,
    });
    Ok(ElementInfo {
        hwnd,
        name,
        role,
        automation_id,
        rect,
    })
}

/// 在窗口内按 locator 查找元素（多条件 AND：name、role、automation_id、index）
pub fn find_element(hwnd: i32, locator: &Locator) -> Result<Option<ElementInfo>, String> {
    let tree = get_element_tree(hwnd, Some(15))?;
    let mut match_count = 0u32;
    for e in &tree {
        if matches_locator(e, locator, &mut match_count) {
            return Ok(Some(e.clone()));
        }
    }
    Ok(None)
}

/// 轮询等待元素出现，超时返回 None
pub fn wait_for_element(
    hwnd: i32,
    locator: &Locator,
    timeout_ms: u64,
    interval_ms: u64,
) -> Result<Option<ElementInfo>, String> {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Ok(Some(e)) = find_element(hwnd, locator) {
            return Ok(Some(e));
        }
        std::thread::sleep(std::time::Duration::from_millis(interval_ms));
    }
    Ok(None)
}

/// 多条件 AND：name/role/automation_id 均需匹配；index 表示「匹配元素中的第几个」（0-based）
fn matches_locator(e: &ElementInfo, loc: &Locator, match_count: &mut u32) -> bool {
    if let Some(ref name) = loc.name {
        let n = match e.name.as_ref() {
            None => return false,
            Some(n) => n.to_lowercase(),
        };
        if !n.contains(&name.to_lowercase()) {
            return false;
        }
    }
    if let Some(ref role) = loc.role {
        let r = match e.role.as_ref() {
            None => return false,
            Some(r) => r.to_lowercase(),
        };
        if !r.contains(&role.to_lowercase()) {
            return false;
        }
    }
    if let Some(ref aid) = loc.automation_id {
        match e.automation_id.as_ref() {
            None => return false,
            Some(a) => {
                if a != aid {
                    return false;
                }
            }
        }
    }
    match loc.index {
        None => true,
        Some(i) => {
            let cur = *match_count;
            *match_count += 1;
            cur == i
        }
    }
}
