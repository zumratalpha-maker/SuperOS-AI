//! 动作执行：click、type（剪贴板+^v）、keys（快捷键）

use uiautomation::inputs::Keyboard;
use uiautomation::types::Point;

/// 发送快捷键（如 ^s, ^a, ^v）
/// 格式：^=Ctrl %=Alt +=Shift，如 {ctrl}v 或 ^v
pub fn send_keys(keys: &str) -> Result<(), String> {
    // 将 ^v 转为 {ctrl}v 格式
    let keys_norm = keys
        .replace("^", "{ctrl}")
        .replace("%", "{alt}")
        .replace("+", "{shift}");
    Keyboard::new().send_keys(&keys_norm).map_err(|e| e.to_string())
}

/// 剪贴板写入 text 后发送 Ctrl+V
pub fn type_via_clipboard(text: &str) -> Result<(), String> {
    uiautomation::clipboards::Clipboard::open()
        .map_err(|e| e.to_string())?
        .set_text(text)
        .map_err(|e| e.to_string())?;
    send_keys("{ctrl}v")
}

/// 点击指定坐标（屏幕坐标）
pub fn click_at(x: i32, y: i32) -> Result<(), String> {
    let pos = Point::new(x, y);
    uiautomation::inputs::Mouse::new()
        .click(pos)
        .map_err(|e| e.to_string())
}
