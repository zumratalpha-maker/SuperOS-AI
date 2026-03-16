//! JSON-RPC IPC 协议

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};

use crate::actions;
use crate::uia::{self, ElementInfo, Locator};
use crate::windows::{self, WindowInfo};

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcSuccess {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub result: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub error: JsonRpcErrorBody,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorBody {
    pub code: i32,
    pub message: String,
}

fn success(id: serde_json::Value, result: serde_json::Value) -> String {
    serde_json::to_string(&JsonRpcSuccess {
        jsonrpc: "2.0".into(),
        id,
        result,
    })
    .unwrap()
}

fn error(id: serde_json::Value, code: i32, message: String) -> String {
    serde_json::to_string(&JsonRpcError {
        jsonrpc: "2.0".into(),
        id,
        error: JsonRpcErrorBody { code, message },
    })
    .unwrap()
}

/// 处理单条 JSON-RPC 请求，返回 JSON 字符串
pub fn handle_request(req: &JsonRpcRequest) -> String {
    let id = req.id.clone();
    let method = &req.method;
    let params = &req.params;

    let result = match method.as_str() {
        "windows.list" => {
            match windows::list_windows() {
                Ok(list) => success(id, serde_json::to_value(list).unwrap()),
                Err(e) => error(id, -32603, e),
            }
        }
        "window.find" => {
            let app = params.get("app").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let process_id = params.get("processId").and_then(|v| v.as_u64()).map(|u| u as u32);
            let exclude_pids: Vec<u32> = params
                .get("excludePids")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_u64().map(|u| u as u32)).collect())
                .unwrap_or_default();
            let result = if let Some(app_name) = app {
                windows::find_window_by_profile(app_name, &exclude_pids)
            } else {
                windows::find_window(name, process_id, &exclude_pids)
            };
            match result {
                Ok(Some(w)) => success(id, serde_json::to_value(w).unwrap()),
                Ok(None) => error(id, -32602, "window not found".into()),
                Err(e) => error(id, -32603, e),
            }
        }
        "window.bringFront" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            match windows::bring_to_front(hwnd) {
                Ok(()) => success(id, serde_json::json!({ "ok": true })),
                Err(e) => error(id, -32603, e),
            }
        }
        "action.type" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Err(e) = windows::bring_to_front(hwnd) {
                return error(id, -32603, e);
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
            match actions::type_via_clipboard(text) {
                Ok(()) => success(id, serde_json::json!({ "ok": true })),
                Err(e) => error(id, -32603, e),
            }
        }
        "action.keys" => {
            let keys = params.get("keys").and_then(|v| v.as_str()).unwrap_or("");
            match actions::send_keys(keys) {
                Ok(()) => success(id, serde_json::json!({ "ok": true })),
                Err(e) => error(id, -32603, e),
            }
        }
        "action.click" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let x = params.get("x").and_then(|v| v.as_i64()).map(|i| i as i32);
            let y = params.get("y").and_then(|v| v.as_i64()).map(|i| i as i32);
            let locator = params.get("locator").and_then(|v| serde_json::from_value(v.clone()).ok());
            if let Err(e) = windows::bring_to_front(hwnd) {
                return error(id, -32603, e);
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
            if let (Some(x), Some(y)) = (x, y) {
                match actions::click_at(x, y) {
                    Ok(()) => success(id, serde_json::json!({ "ok": true })),
                    Err(e) => error(id, -32603, e),
                }
            } else if let Some(ref loc) = locator {
                match uia::find_element(hwnd, loc) {
                    Ok(Some(elem)) => {
                        if let Some(ref rect) = elem.rect {
                            let cx = ((rect.left + rect.right) / 2.0) as i32;
                            let cy = ((rect.top + rect.bottom) / 2.0) as i32;
                            match actions::click_at(cx, cy) {
                                Ok(()) => success(id, serde_json::json!({ "ok": true })),
                                Err(e) => error(id, -32603, e),
                            }
                        } else {
                            error(id, -32602, "element has no rect".into())
                        }
                    }
                    Ok(None) => error(id, -32602, "element not found".into()),
                    Err(e) => error(id, -32603, e),
                }
            } else {
                error(id, -32602, "locator or x,y required".into())
            }
        }
        "element.tree" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let max_depth = params.get("maxDepth").and_then(|v| v.as_u64()).map(|u| u as u32);
            match uia::get_element_tree(hwnd, max_depth) {
                Ok(tree) => success(id, serde_json::to_value(tree).unwrap()),
                Err(e) => error(id, -32603, e),
            }
        }
        "element.find" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let locator = params.get("locator").and_then(|v| serde_json::from_value(v.clone()).ok());
            match locator {
                Some(loc) => match uia::find_element(hwnd, &loc) {
                    Ok(Some(e)) => success(id, serde_json::to_value(e).unwrap()),
                    Ok(None) => error(id, -32602, "element not found".into()),
                    Err(e) => error(id, -32603, e),
                },
                None => error(id, -32602, "locator required".into()),
            }
        }
        "element.waitFor" => {
            let hwnd = params.get("hwnd").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let locator = params.get("locator").and_then(|v| serde_json::from_value(v.clone()).ok());
            let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(5000);
            let interval_ms = params.get("intervalMs").and_then(|v| v.as_u64()).unwrap_or(200);
            match locator {
                Some(loc) => match uia::wait_for_element(hwnd, &loc, timeout_ms, interval_ms) {
                    Ok(Some(e)) => success(id, serde_json::to_value(e).unwrap()),
                    Ok(None) => error(id, -32602, "element wait timeout".into()),
                    Err(e) => error(id, -32603, e),
                },
                None => error(id, -32602, "locator required".into()),
            }
        }
        _ => error(id, -32601, format!("method not found: {}", method)),
    };

    result
}

/// 从 stdin 读取 JSON-RPC 行，写入 stdout
pub fn run_stdio_loop() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let reader = BufReader::new(stdin);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err = error(serde_json::Value::Null, -32700, e.to_string());
                writeln!(stdout, "{}", err).ok();
                continue;
            }
        };
        let resp = handle_request(&req);
        writeln!(stdout, "{}", resp).ok();
        stdout.flush().ok();
    }
}
