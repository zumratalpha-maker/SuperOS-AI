/**
 * DirectShellBridge 共享类型定义
 * 所有子模块共用的 interface / type / constant
 */

import type { A11yState, A11yNode } from "../trajectoryRecorder.js";

// ─── 窗口与快照类型 ───

export interface WindowInfo {
  processId: number;
  name: string;
  nativeWindowHandle?: number;
}

export interface CompressedA11yNode {
  role?: string;
  name?: string;
  automationId?: string;
  rect?: string;
}

export interface GlobalWindowNode {
  name: string;
  processId: number;
  nativeWindowHandle?: number;
  children: CompressedA11yNode[];
}

export interface GlobalSnapshot {
  timestamp: number;
  windows: GlobalWindowNode[];
}

export interface CacheEntry {
  hwnd: number;
  name: string;
  processId: number;
}

// ─── 执行配置 ───

export interface ExecutionTimingConfig {
  afterBringFrontMs: number;
  noBringMs: number;
  afterSaveShortcutMs: number;
  stepCooldownMs: number;
  afterOpenAppMs: number;
}

export const DEFAULT_TIMING: ExecutionTimingConfig = {
  afterBringFrontMs: 80,
  noBringMs: 60,
  afterSaveShortcutMs: 420,
  stepCooldownMs: 50,
  afterOpenAppMs: 200,
};

export function getExecutionTimingConfig(): ExecutionTimingConfig {
  return { ...DEFAULT_TIMING };
}

export interface DirectShellOptions {
  profilesDir?: string;
  scriptsDir?: string;
  preferUiaSniper?: boolean;
  processId?: number;
}

// ─── 点击相关 ───

export interface ClickResult {
  done: boolean;
  method?: string;
  confidence?: number;
  hwnd?: number;
}

export interface ClickByNameOptions extends DirectShellOptions {
  retryCount?: number;
  targetHwnd?: number;
  skipAliases?: boolean;
}

// ─── 输入相关 ───

export interface TypeTextOptions extends DirectShellOptions {
  targetHwnd?: number;
  processId?: number;
  context?: "save_dialog_filename" | "export_dialog_filename" | "open_dialog_filename";
  skipSetClipboard?: boolean;
}

// ─── Tab 遍历 ───

export interface TabOrderElement {
  index: number;
  name: string;
  role: string;
  automationId: string;
  rect: string;
  isKeyboardFocusable: boolean;
}

// ─── 截屏区域 ───

export interface ScreenshotRegion {
  base64: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

// ─── 前台窗口 ───

export interface ForegroundSnapshot {
  hwnd: number;
  windowName: string;
  processId: number;
  processName: string;
  cursorX: number;
  cursorY: number;
  cursorElementName: string;
  cursorElementRole: string;
  cursorElementRect: string;
}

// Re-export trajectory types for convenience
export type { A11yState, A11yNode };
