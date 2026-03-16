//! SuperEye Daemon — 万能 AI 无人操作系统的眼睛层
//!
//! 融合 DirectShell 持久化 + Terminator locator，保留语义快捷键与 Profile。

#[cfg(windows)]
pub mod actions;
#[cfg(windows)]
pub mod ipc;
#[cfg(windows)]
pub mod profile;
#[cfg(windows)]
pub mod uia;
#[cfg(windows)]
pub mod windows;
