//! 应用 Profile 引擎（Phase 2）
//! 内置微信、记事本、剪映等窗口匹配规则，稳定查找与等待策略

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppProfile {
    pub window_names: Vec<String>,
    pub process_name: Option<String>,
    pub open_wait_ms: u64,
    pub exclude_pids: Vec<u32>,
    pub retry_attempts: u32,
    pub retry_interval_ms: u64,
}

/// 内置 Profile（Phase 2）
pub fn get_profile(app: &str) -> Option<AppProfile> {
    let key = app.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    let profile = match key.as_str() {
        "微信" | "wechat" => AppProfile {
            window_names: vec!["微信".into(), "WeChat".into(), "wechat".into()],
            process_name: Some("WeChat.exe".into()),
            open_wait_ms: 2500,
            exclude_pids: vec![],
            retry_attempts: 12,
            retry_interval_ms: 220,
        },
        "记事本" | "notepad" => AppProfile {
            window_names: vec!["记事本".into(), "Notepad".into()],
            process_name: Some("Notepad.exe".into()),
            open_wait_ms: 500,
            exclude_pids: vec![],
            retry_attempts: 8,
            retry_interval_ms: 180,
        },
        "剪映" | "jianying" => AppProfile {
            window_names: vec!["剪映".into(), "JianyingPro".into(), "CapCut".into()],
            process_name: Some("JianyingPro.exe".into()),
            open_wait_ms: 3000,
            exclude_pids: vec![],
            retry_attempts: 15,
            retry_interval_ms: 250,
        },
        _ => return None,
    };
    Some(profile)
}
