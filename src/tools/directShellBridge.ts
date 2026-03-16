/**
 * 全域上帝视角 — DirectShell 桥接层
 *
 * 1) UiaSniper / inject 优先
 * 2) 强焦点盲打兜底：SetForegroundWindow + PowerShell SendKeys（无 robotjs/Java）
 * 3) 菜单点击兜底：常见菜单名 → 快捷键（Alt+F / Ctrl+S 等）
 * 4) 子进程 stderr/stdout 与超时均记录，不静默
 */

import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { A11yState, A11yNode } from "./trajectoryRecorder.js";
import * as supereyeClient from "./supereyeClient.js";
import { getCachedSuccess, recordSuccess } from "./automationSuccessCache.js";
import { appendLearnedAction, deleteLearnedAction, getLearnedClick } from "./learnedActions.js";
import { getUiaFailureRate, recordUiaResult } from "./uiaFailureStats.js";
import * as ocrBridge from "./ocrBridge.js";
import { visionChatCompletion } from "../llm/apiClient.js";
import { VISION_LLM } from "../config/llmConfig.js";

/** 是否启用 SuperEye daemon（环境变量 USE_SUPEREYE=1） */
export function useSuperEye(): boolean {
  return process.env.USE_SUPEREYE === "1";
}

// ---------- 全域感知层：Root 根节点、多窗口扫描（不依赖单窗口附着） ----------

/** 从 Root 查到的顶级窗口信息，支持按 PID 精准匹配 */
export interface WindowInfo {
  processId: number;
  name: string;
  nativeWindowHandle?: number;
}

/** 极致压缩后的单节点（仅关键交互点） */
export interface CompressedA11yNode {
  role?: string;
  name?: string;
  automationId?: string;
  rect?: string;
}

/** 全局快照中的单个顶级窗口及其压缩子树 */
export interface GlobalWindowNode {
  name: string;
  processId: number;
  nativeWindowHandle?: number;
  children: CompressedA11yNode[];
}

/** 全屏可见窗口的精简树（从 RootElement 一次抓取） */
export interface GlobalSnapshot {
  timestamp: number;
  windows: GlobalWindowNode[];
}

/** 句柄缓存项：用于在未失效时跳过全屏 Root 扫描 */
export interface CacheEntry {
  hwnd: number;
  name: string;
  processId: number;
}

/** 在 GlobalSnapshot 中按窗口名/PID 定位窗口后，再按元素名查找压缩节点 */
export function findElementInSnapshot(
  snapshot: GlobalSnapshot,
  windowNameOrPid: string | number,
  elementName: string
): CompressedA11yNode | null {
  const win = typeof windowNameOrPid === "number"
    ? snapshot.windows.find((w) => w.processId === windowNameOrPid)
    : snapshot.windows.find((w) => w.name && w.name.includes(String(windowNameOrPid)));
  if (!win || !win.children) return null;
  const key = (elementName ?? "").trim().toLowerCase();
  if (!key) return null;
  const node = win.children.find(
    (c) => (c.name && c.name.toLowerCase().includes(key)) || (c.automationId && c.automationId.toLowerCase().includes(key))
  );
  return node ?? null;
}

/** 全局执行时序配置（单一时序权威，bridge 与编排层共用） */
export interface ExecutionTimingConfig {
  afterBringFrontMs: number;
  noBringMs: number;
  afterSaveShortcutMs: number;
  stepCooldownMs: number;
  /** open_app 启动后额外等待，给 WinUI3 等慢启动应用时间出现在 UIA 树 */
  afterOpenAppMs: number;
}

/** 人类操作逻辑：窗口出现即输入、输入完立即保存，步骤间无多余等待；机器慢可调大 */
const DEFAULT_TIMING: ExecutionTimingConfig = {
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
  /** 双屏/多窗同名时锁定进程，供 findWindowByName 与 directshell /pid:N 使用 */
  processId?: number;
}

const DEFAULT_PROFILES_DIR = "D:\\DirectShell\\ds_profiles";

function getProfilesDir(options?: DirectShellOptions): string {
  if (options?.profilesDir) return options.profilesDir;
  const env = process.env.DS_PROFILES;
  if (env && env.length > 0) return env;
  return DEFAULT_PROFILES_DIR;
}

function getScriptsDir(options?: DirectShellOptions): string {
  if (options?.scriptsDir) return options.scriptsDir;
  return join(process.cwd(), "scripts");
}

/** 菜单/按钮名 → SendKeys 快捷键（% = Alt, ^ = Ctrl） */
const MENU_SHORTCUTS: Record<string, string> = {
  文件: "%f",
  编辑: "%e",
  查看: "%v",
  保存: "^s",
  另存为: "%fa",
  打开: "^o",
  新建: "^n",
  退出: "%{F4}",
  "保存(S)": "^s",
  "Save (S)": "^s",
  File: "%f",
  Edit: "%e",
  View: "%v",
  Save: "^s",
  "Save As": "%fa",
  Open: "^o",
  New: "^n",
};

/** 高频动作强映射：name 包含关键字即直接返回快捷键，不依赖菜单点击 */
const STRONG_SHORTCUT_MAP: { keyword: string; shortcut: string }[] = [
  { keyword: "保存", shortcut: "^s" },
  { keyword: "Save", shortcut: "^s" },
  { keyword: "全选", shortcut: "^a" },
  { keyword: "Select All", shortcut: "^a" },
];

/** UiaSniper 主名失败时的备选名称（剪映等 UIA 名称可能带符号或中英混合；网页创作工具改版兜底） */
const CLICK_NAME_ALIASES: Record<string, string[]> = {
  "开始创作": ["+ 开始创作", "Start Creating", "开始创作"],
  导出: ["导出视频", "Export", "导出"],
  导入: ["+ 导入", "添加素材", "Import", "导入"],
  // 通义万相、豆包等文生图
  输入框: ["输入框", "请输入", "描述", "输入描述", "描述你的画作", "Describe"],
  生成创意画作: ["生成创意画作", "生成", "立即生成", "生成画作", "Generate"],
  下载原图: ["下载原图", "下载", "Download", "保存"],
  图片生成: ["图片生成", "生成图片", "Image Generation"],
  生成: ["生成", "Generate", "立即生成"],
  下载: ["下载", "Download", "保存", "保存图片"],
  // Gemini、豆包文案输入
  输入: ["输入", "请输入", "输入消息", "Message", "输入内容"],
  // 可灵、即梦图生视频
  上传: ["上传", "选择图片", "上传图片", "选择文件", "Upload"],
  参考导入: ["参考导入", "导入", "上传", "选择图片"],
  运动描述: ["运动描述", "描述", "请输入运动描述"],
  关键词: ["关键词", "请输入关键词", "描述"],
  生成视频: ["生成视频", "生成", "创建视频"],
  // Word 新建文档（Start 界面）
  空白文档: ["空白文档", "新建", "Blank document", "新建空白文档"],
  新建: ["新建", "空白文档", "New", "Blank document"],
};

/** 根据按钮/菜单名解析快捷键：先强映射（保存/全选），再精确与包含匹配 */
function resolveShortcut(keyword: string): string | undefined {
  const k = keyword.trim();
  if (!k) return undefined;
  for (const { keyword: kw, shortcut } of STRONG_SHORTCUT_MAP) {
    if (k.includes(kw)) return shortcut;
  }
  if (MENU_SHORTCUTS[k] !== undefined) return MENU_SHORTCUTS[k];
  const normalized = k.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (MENU_SHORTCUTS[normalized] !== undefined) return MENU_SHORTCUTS[normalized];
  const keys = Object.keys(MENU_SHORTCUTS).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (k.includes(key)) return MENU_SHORTCUTS[key];
  }
  return undefined;
}

/** SendKeys 特殊字符转义：+ ^ % ~ { } 需写成 {+} {^} {%} {~} {{} }} */
function escapeSendKeys(text: string): string {
  return text
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}")
    .replace(/\+/g, "{+}")
    .replace(/\^/g, "{^}")
    .replace(/%/g, "{%}")
    .replace(/~/g, "{~}");
}

/** 供 PowerShell 单引号字符串安全使用：单引号改为 '' */
function escapeForPsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

/** 将 PowerShell 脚本编码为 UTF-16LE Base64，供 -EncodedCommand 使用，彻底避免引号/转义问题 */
function toEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** 单次激活：ShowWindow(SW_RESTORE) + SetForegroundWindow，脚本内 DllImport 用 `" 避免 here-string 截断 */
function runSingleActivateScript(hwnd: number): Promise<boolean> {
  const script = [
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class Win32Activate {`,
    `  public const int SW_RESTORE = 9;`,
    `  [DllImport(\`"user32.dll\`")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);`,
    `  [DllImport(\`"user32.dll\`")] public static extern IntPtr GetForegroundWindow();`,
    `  [DllImport(\`"user32.dll\`")] public static extern bool SetForegroundWindow(IntPtr h);`,
    `}`,
    `"@`,
    `$h = [IntPtr]::new(${hwnd})`,
    `[Win32Activate]::ShowWindow($h, [Win32Activate]::SW_RESTORE) | Out-Null`,
    `[Win32Activate]::SetForegroundWindow($h) | Out-Null`,
    `exit 0`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  return new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 8000,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      console.error("[directShellBridge] activate script error:", err);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.error("[directShellBridge] activate script stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
}

/** 检查当前前台窗口是否为指定句柄（Base64 + here-string 内 `" 转义） */
async function runGetForegroundWindowEquals(targetHwnd: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const outPath = join(tmpdir(), `ds_fg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class W { [DllImport(\`"user32.dll\`")] public static extern IntPtr GetForegroundWindow(); }`,
    `"@`,
    `$fg = [int][W]::GetForegroundWindow()`,
    `($fg -eq ${targetHwnd}) | Out-File -LiteralPath $outPath -Encoding ascii`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = (await readFile(outPath, "utf8")).trim().toLowerCase();
    return raw === "true";
  } catch {
    return false;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

const ACTIVATE_MAX_RETRIES = 2;

/**
 * 强力窗口激活（hwnd 精准）：ShowWindow(SW_RESTORE) + SetForegroundWindow，Base64 执行；
 * 动作前置校验 GetForegroundWindow === hwnd，失败则重试最多 2 次；成功后强制 afterBringFrontMs 延迟。
 */
export async function bringWindowToFront(hwnd: number): Promise<boolean> {
  const h =
    typeof hwnd === "object" && hwnd != null && "nativeWindowHandle" in hwnd
      ? Number((hwnd as { nativeWindowHandle: number }).nativeWindowHandle)
      : Number(hwnd);
  if (process.platform !== "win32" || !Number.isFinite(h) || h === 0) return false;
  if (useSuperEye()) {
    try {
      const ok = await supereyeClient.bringFront(h);
      if (ok) {
        const timing = getExecutionTimingConfig();
        await new Promise((r) => setTimeout(r, timing.afterBringFrontMs));
        return true;
      }
    } catch (e) {
      console.warn("[directShellBridge] SuperEye bringFront 失败，回退 PowerShell:", String(e));
    }
  }
  const timing = getExecutionTimingConfig();
  let lastExecOk = false;
  for (let attempt = 0; attempt <= ACTIVATE_MAX_RETRIES; attempt++) {
    lastExecOk = await runSingleActivateScript(h);
    if (!lastExecOk) continue;
    const verifyOk = await runGetForegroundWindowEquals(h);
    if (verifyOk) {
      await new Promise((r) => setTimeout(r, timing.afterBringFrontMs));
      return true;
    }
    if (attempt < ACTIVATE_MAX_RETRIES) {
      console.warn("[directShellBridge] 焦点锁定未通过，重试激活 hwnd=" + h);
    }
  }
  if (lastExecOk) {
    await new Promise((r) => setTimeout(r, timing.afterBringFrontMs));
  }
  if (!(await runGetForegroundWindowEquals(h))) {
    console.warn("[directShellBridge] 焦点锁定检查未通过，当前前台与目标句柄不一致");
  }
  return lastExecOk;
}

/**
 * 窗口最大化（hwnd 精准）：ShowWindow(SW_MAXIMIZE)，Win32 标准最大化
 */
export async function maximizeWindow(hwnd: number): Promise<boolean> {
  const h = Number(hwnd);
  if (process.platform !== "win32" || !Number.isFinite(h) || h === 0) return false;
  const script = [
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class Win32Max {`,
    `  public const int SW_MAXIMIZE = 3;`,
    `  [DllImport(\`"user32.dll\`")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);`,
    `}`,
    `"@`,
    `$h = [IntPtr]::new(${h})`,
    `[Win32Max]::ShowWindow($h, [Win32Max]::SW_MAXIMIZE) | Out-Null`,
    `exit 0`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  return new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.warn("[directShellBridge] maximizeWindow stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
}

/** 按句柄激活（别名，与 bringWindowToFront 一致） */
export async function bringWindowToFrontByHandle(hwnd: number): Promise<boolean> {
  return bringWindowToFront(hwnd);
}

/**
 * 按进程 ID 激活该进程主窗口（先取 MainWindowHandle，再走句柄激活逻辑）
 */
export async function bringWindowToFrontByPid(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || pid <= 0) return false;
  const outPath = join(tmpdir(), `ds_hwnd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if (-not $p -or $p.MainWindowHandle -eq 0) { exit 1 }`,
    `[int]$p.MainWindowHandle | Out-File -LiteralPath $outPath -Encoding ascii`,
    `exit 0`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const execOk = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  try {
    const hwnd = parseInt((await readFile(outPath, "utf8")).trim(), 10);
    if (!Number.isFinite(hwnd) || hwnd === 0) return false;
    return bringWindowToFront(hwnd);
  } catch {
    return false;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/**
 * 置前窗口（按标题，兼容）：先解析出 hwnd，再走 bringWindowToFront(hwnd)
 */
async function runBringWindowToFront(titlePart: string): Promise<boolean> {
  if (process.platform !== "win32" || !titlePart.trim()) return false;
  const safe = escapeForPsSingleQuoted(titlePart.trim());
  const outPath = join(tmpdir(), `ds_hwnd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$titlePart = '${safe}'`,
    `$outPath = '${safePath}'`,
    `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$titlePart*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    `if (-not $p) { exit 1 }`,
    `[int]$p.MainWindowHandle | Out-File -LiteralPath $outPath -Encoding ascii`,
    `exit 0`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const execOk = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 8000,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      console.error("[directShellBridge] bringWindowToFront resolve error:", err);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.error("[directShellBridge] bringWindowToFront resolve stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
  if (!execOk) return false;
  try {
    const hwnd = parseInt((await readFile(outPath, "utf8")).trim(), 10);
    if (!Number.isFinite(hwnd) || hwnd === 0) return false;
    return bringWindowToFront(hwnd);
  } catch (e) {
    console.error("[directShellBridge] bringWindowToFront read hwnd:", e);
    return false;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/**
 * 内联 PowerShell：SendKeys::SendWait 向当前焦点窗口发送按键，不依赖 .ps1。
 * 注意：keys 必须已是 SendKeys 格式（% = Alt, ^ = Ctrl），不要对快捷键做 escapeSendKeys，否则会打成字面符号。
 */
async function runSendKeys(keys: string): Promise<boolean> {
  if (process.platform !== "win32" || keys === "") return false;
  const safeText = escapeForPsSingleQuoted(keys);
  const cmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${safeText}')`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", cmd], {
      cwd: process.cwd(),
      timeout: 15000,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      console.error("[directShellBridge] sendKeys error:", err);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.error("[directShellBridge] sendKeys stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
}

/**
 * 剪贴板秒贴 — 工程标准：废弃逐字 SendKeys(文字)。
 * 逻辑严格为：Set-Clipboard -> [HWND 置顶] -> 发送 Ctrl+V。
 * 由 typeText 先调 setClipboardOnly，再 bringWindowToFront + delay，再 sendCtrlVOnly。
 */

/** 仅设置剪贴板，不发送按键；供预填或 typeText 内部使用 */
export function setClipboardOnly(text: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const safe = escapeForPsSingleQuoted(text);
  const cmd = `Set-Clipboard -Value '${safe}'`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", cmd], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function sendCtrlVOnly(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const cmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", cmd], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** 一步完成：Set-Clipboard + SendWait('^v')（调用方已保证目标窗置顶后调用） */
async function runPasteFromClipboard(text: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const okSet = await setClipboardOnly(text);
  if (!okSet) return false;
  return sendCtrlVOnly();
}

export function parseTarget(target: string): { window: string; element: string } {
  const t = (target ?? "").trim();
  const pipe = t.indexOf("|");
  if (pipe >= 0) {
    return { window: t.slice(0, pipe).trim(), element: t.slice(pipe + 1).trim() };
  }
  return { window: "", element: t };
}

export function formatTarget(windowOrFull: string, element?: string): string {
  if (element !== undefined && element !== "") {
    return windowOrFull ? `${windowOrFull}|${element}` : element;
  }
  return windowOrFull;
}

// ---------- 全域感知：从 RootElement 扫描，句柄缓存，不依赖 is_active 附着 ----------

const UIA_SCRIPT_TIMEOUT_MS = 12000;
const MAX_HANDLE_CACHE_SIZE = 64;

/** 句柄缓存：key = normalize(name) 或 "name|pid"，命中且 IsWindow 有效则跳过全屏扫描 */
const handleCache = new Map<string, CacheEntry>();

function cacheKey(name: string, pid?: number): string {
  const n = (name ?? "").trim().toLowerCase();
  return pid != null && pid > 0 ? `${n}|${pid}` : n;
}

/** 检查句柄是否仍为有效窗口（IsWindow），避免缓存失效后误用 */
async function isWindowValid(hwnd: number): Promise<boolean> {
  if (process.platform !== "win32" || hwnd == null || Number(hwnd) === 0) return false;
  const outPath = join(tmpdir(), `ds_iswin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class W { [DllImport(\`"user32.dll\`")] public static extern bool IsWindow(IntPtr h); }`,
    `"@`,
    `$h = [IntPtr]::new(${hwnd})`,
    `([W]::IsWindow($h)) | Out-File -LiteralPath $outPath -Encoding ascii`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = (await readFile(outPath, "utf8")).trim().toLowerCase();
    return raw === "true";
  } catch {
    return false;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/** 获取指定进程名的所有 PID（用于 open_app 前记录已有窗口，以便优先匹配新启动的） */
export async function getProcessIdsByProcessName(processName: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const safe = escapeForPsSingleQuoted((processName ?? "").trim());
  const outPath = join(tmpdir(), `ds_pids_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$procs = Get-Process -Name '${safe}' -ErrorAction SilentlyContinue`,
    `$ids = @($procs | ForEach-Object { $_.Id })`,
    `$ids | ConvertTo-Json -Compress | Out-File -LiteralPath '${safePath}' -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = (await readFile(outPath, "utf8")).trim();
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((n: unknown) => typeof n === "number" && n > 0) : [];
  } catch {
    return [];
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/** 快速查窗：Get-Process MainWindowTitle + MainWindowHandle，不依赖 UIA，通常 <2s；仅支持标题包含匹配 */
async function runFindWindowByGetProcess(
  namePart: string,
  filterPid: number,
  excludePids: number[] = []
): Promise<WindowInfo | null> {
  if (process.platform !== "win32" || (filterPid !== 0) || excludePids.length > 0) return null;
  const safeTitle = escapeForPsSingleQuoted((namePart ?? "").trim());
  if (!safeTitle) return null;
  const outPath = join(tmpdir(), `ds_getproc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$titlePart = '${safeTitle}'`,
    `$outPath = '${safePath}'`,
    `$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$titlePart*" }`,
    `$first = $procs | Select-Object -First 1`,
    `if ($first) { @{ processId=$first.Id; name=$first.MainWindowTitle; nativeWindowHandle=[int]$first.MainWindowHandle } | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8 } else { '{}' | Out-File -LiteralPath $outPath -Encoding utf8 }`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const obj = JSON.parse(raw.trim()) as { processId?: number; name?: string; nativeWindowHandle?: number };
    if (obj && typeof obj.processId === "number" && obj.name != null && typeof obj.nativeWindowHandle === "number" && obj.nativeWindowHandle > 0) {
      return {
        processId: obj.processId,
        name: String(obj.name),
        nativeWindowHandle: obj.nativeWindowHandle,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/** 从 Root 第一层子节点（顶级窗口）扫描，模糊匹配标题；若提供 pid 则强制匹配 PID；excludePids 排除启动前已有的（优先新窗） */
async function runFindWindowFromRoot(
  namePart: string,
  filterPid: number,
  excludePids: number[] = []
): Promise<WindowInfo | null> {
  const safeTitle = escapeForPsSingleQuoted((namePart ?? "").trim());
  const excludeStr = excludePids.length ? excludePids.join(",") : "";
  const outPath = join(tmpdir(), `ds_findwin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$titlePart = '${safeTitle}'`,
    `$filterPid = ${filterPid}`,
    `$excludeStr = '${excludeStr}'`,
    `$excludeArr = @()`,
    `if ($excludeStr) { $excludeArr = $excludeStr -split ',' | ForEach-Object { [int]$_.Trim() } }`,
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$coll = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)`,
    `$result = $null`,
    `foreach ($w in $coll) {`,
    `  try {`,
    `    $name = $w.Current.Name`,
    `    $pid = $w.Current.ProcessId`,
    `    $h = $w.Current.NativeWindowHandle`,
    `    if ([string]::IsNullOrEmpty($titlePart) -eq $false -and $name -notlike "*$titlePart*") { continue }`,
    `    if ($filterPid -ne 0 -and $pid -ne $filterPid) { continue }`,
    `    if ($excludeArr.Count -gt 0 -and $excludeArr -contains $pid) { continue }`,
    `    $result = @{ processId = $pid; name = $name; nativeWindowHandle = [int]$h }`,
    `    break`,
    `  } catch {}`,
    `}`,
    `if ($result) { $result | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8 } else { '{}' | Out-File -LiteralPath $outPath -Encoding utf8 }`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: UIA_SCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.error("[directShellBridge] findWindowFromRoot stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const obj = JSON.parse(raw.trim()) as { processId?: number; name?: string; nativeWindowHandle?: number };
    if (obj && typeof obj.processId === "number" && obj.name != null) {
      return {
        processId: obj.processId,
        name: String(obj.name),
        nativeWindowHandle: typeof obj.nativeWindowHandle === "number" ? obj.nativeWindowHandle : undefined,
      };
    }
    return null;
  } catch (e) {
    if (ok === false) console.error("[directShellBridge] findWindowFromRoot 未读到有效 JSON:", e);
    return null;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/** 应用显示名 → 进程名（用于 UIA 名称异常时按进程查找） */
const PROCESS_NAME_FALLBACK: Record<string, string> = {
  记事本: "Notepad",
  Notepad: "Notepad",
  微信: "WeChat",
  WeChat: "WeChat",
  wechat: "WeChat",
  Excel: "EXCEL",
  WPS: "wps",
  wps: "wps",
  剪映: "JianyingPro",
  JianyingPro: "JianyingPro",
  CapCut: "CapCut",
  capcut: "CapCut",
};

/** 微信可能进程名：WeChat.exe 为官方，Weixin.exe 为部分安装/绿色版 */
const WECHAT_PROCESS_NAMES = ["WeChat", "Weixin"];

/** 按进程名查找窗口：UIA 名称异常（空/不含关键字）时的兜底；excludePids 排除启动前已有的 */
async function runFindWindowByProcessName(
  processName: string,
  filterPid: number,
  excludePids: number[] = []
): Promise<WindowInfo | null> {
  const safeProc = escapeForPsSingleQuoted((processName ?? "").trim());
  const excludeStr = excludePids.length ? excludePids.join(",") : "";
  const outPath = join(tmpdir(), `ds_findproc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$procName = '${safeProc}'`,
    `$filterPid = ${filterPid}`,
    `$excludeStr = '${excludeStr}'`,
    `$excludeArr = @()`,
    `if ($excludeStr) { $excludeArr = $excludeStr -split ',' | ForEach-Object { [int]$_.Trim() } }`,
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$coll = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)`,
    `$result = $null`,
    `foreach ($w in $coll) {`,
    `  try {`,
    `    $wndPid = $w.Current.ProcessId`,
    `    if ($filterPid -ne 0 -and $wndPid -ne $filterPid) { continue }`,
    `    if ($excludeArr.Count -gt 0 -and $excludeArr -contains $wndPid) { continue }`,
    `    $p = Get-Process -Id $wndPid -ErrorAction SilentlyContinue`,
    `    if (-not $p -or $p.ProcessName -notlike "*$procName*") { continue }`,
    `    $result = @{ processId = $wndPid; name = $w.Current.Name; nativeWindowHandle = [int]$w.Current.NativeWindowHandle }`,
    `    break`,
    `  } catch {}`,
    `}`,
    `if ($result) { $result | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8 } else { '{}' | Out-File -LiteralPath $outPath -Encoding utf8 }`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: UIA_SCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const obj = JSON.parse(raw.trim()) as { processId?: number; name?: string; nativeWindowHandle?: number };
    if (obj && typeof obj.processId === "number") {
      return {
        processId: obj.processId,
        name: obj.name != null ? String(obj.name) : "",
        nativeWindowHandle: typeof obj.nativeWindowHandle === "number" ? obj.nativeWindowHandle : undefined,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/**
 * 高鲁棒性按名称查窗：先查句柄缓存（IsWindow 有效则直接返回），未命中再从 Root 第一层扫描并更新缓存。
 * 支持模糊匹配标题；若传 pid 则强制匹配 PID（双屏/多窗口防干扰）。缓存有容量上限，避免内存堆积。
 */
export async function findWindowByName(
  name: string,
  options?: DirectShellOptions & { processId?: number; excludePids?: number[]; app?: string }
): Promise<WindowInfo | null> {
  if (process.platform !== "win32") return null;
  const namePart = (name ?? "").trim();
  const pid = options?.processId;
  const excludePids = options?.excludePids ?? [];
  const app = options?.app?.trim();
  const key = cacheKey(namePart, pid);

  if (useSuperEye()) {
    try {
      const info = app
        ? await supereyeClient.findWindow(namePart, { app, excludePids })
        : await supereyeClient.findWindow(namePart, {
            processId: pid ?? undefined,
            excludePids,
          });
      if (info) {
        const processId = info.process_id;
        if (excludePids.length === 0 && info.hwnd) {
          const entry: CacheEntry = { hwnd: info.hwnd, name: info.name, processId };
          if (handleCache.size >= MAX_HANDLE_CACHE_SIZE) {
            const firstKey = handleCache.keys().next().value;
            if (firstKey != null) handleCache.delete(firstKey);
          }
          handleCache.set(key, entry);
        }
        return {
          processId,
          name: info.name,
          nativeWindowHandle: info.hwnd,
        };
      }
    } catch (e) {
      console.warn("[directShellBridge] SuperEye findWindow 失败，回退 PowerShell:", String(e));
    }
  }

  if (excludePids.length === 0) {
    const cached = handleCache.get(key);
    if (cached && cached.hwnd) {
      const valid = await isWindowValid(cached.hwnd);
      if (valid) {
        return {
          processId: cached.processId,
          name: cached.name,
          nativeWindowHandle: cached.hwnd,
        };
      }
      handleCache.delete(key);
    }
  }

  const filterPid = pid != null && pid > 0 ? pid : 0;
  const procName = PROCESS_NAME_FALLBACK[namePart];
  // 微信/WeChat 优先按进程名查找；Weixin.exe 进程名为 Weixin，需兜底尝试
  let info: WindowInfo | null = null;
  if (procName && /^微信|WeChat|wechat$/i.test(namePart)) {
    for (const p of WECHAT_PROCESS_NAMES) {
      info = await runFindWindowByProcessName(p, filterPid, excludePids);
      if (info) {
        console.log("[directShellBridge] findWindowByName 微信进程名成功:", namePart, "->", p);
        break;
      }
    }
  }
  if (!info || !info.nativeWindowHandle) {
    if (filterPid === 0 && excludePids.length === 0) {
      info = await runFindWindowByGetProcess(namePart, filterPid, excludePids);
      if (info) console.log("[directShellBridge] findWindowByName Get-Process 成功:", namePart);
    }
    if (!info || !info.nativeWindowHandle) {
      info = await runFindWindowFromRoot(namePart, filterPid, excludePids);
    }
  }
  // 微信：UIA 名称异常时按进程名兜底
  if ((!info || info.nativeWindowHandle == null) && /^微信|WeChat|wechat$/i.test(namePart)) {
    for (const p of WECHAT_PROCESS_NAMES) {
      info = await runFindWindowByProcessName(p, filterPid, excludePids);
      if (info) {
        console.log("[directShellBridge] findWindowByName 微信进程名兜底成功:", namePart, "->", p);
        break;
      }
    }
  }
  // 记事本：Win11 新记事本窗口标题可能仅「无标题」不含「记事本」，按进程名兜底
  if ((!info || info.nativeWindowHandle == null) && /^记事本|Notepad$/i.test(namePart)) {
    info = await runFindWindowByProcessName("Notepad", filterPid, excludePids);
    if (info) {
      console.log("[directShellBridge] findWindowByName 记事本进程名兜底成功:", namePart);
    }
  }
  // Excel / WPS / 剪映 / CapCut：窗口标题异常时按进程名兜底
  const procFallback = PROCESS_NAME_FALLBACK[namePart];
  if ((!info || info.nativeWindowHandle == null) && procFallback && /^Excel|WPS|wps|剪映|JianyingPro|CapCut|capcut$/i.test(namePart)) {
    info = await runFindWindowByProcessName(procFallback, filterPid, excludePids);
    if (info) {
      console.log("[directShellBridge] findWindowByName 进程名兜底成功:", namePart, "->", procFallback);
    }
  }
  if (!info || info.nativeWindowHandle == null) return null;

  if (excludePids.length === 0) {
    const entry: CacheEntry = {
      hwnd: info.nativeWindowHandle,
      name: info.name,
      processId: info.processId,
    };
    if (handleCache.size >= MAX_HANDLE_CACHE_SIZE) {
      const firstKey = handleCache.keys().next().value;
      if (firstKey != null) handleCache.delete(firstKey);
    }
    handleCache.set(key, entry);
  }
  return info;
}

/** 从 Root 第一层按 Name 包含 title 查找，可选 pid；保留兼容别名 */
export async function findWindowByTitle(
  title: string,
  options?: DirectShellOptions & { processId?: number }
): Promise<WindowInfo | null> {
  return findWindowByName(title, options);
}

/** 另存为对话框标题关键字（供 findSaveDialogHwnd 使用） */
const SAVE_DIALOG_NAMES = ["另存为", "Save As", "保存为"];

/** 打开/导入对话框标题关键字（供 findOpenDialogHwnd 使用，含浏览器文件选择） */
const OPEN_DIALOG_NAMES = ["打开", "Open", "选择", "选择要导入", "选择文件", "选择要上载", "选择要上传"];

/** 剪映导出对话框标题关键字（供 findExportDialogHwnd 使用） */
const EXPORT_DIALOG_NAMES = ["导出", "导出视频", "导出设置", "Export", "导出 - CapCut", "导出 - 剪映"];

/**
 * 定位剪映「导出」对话框 hwnd；
 * 策略：1) 按标题关键字查找 2) 子窗口兜底 3) 主窗同标题时排除主窗取另一窗口（剪映专业版导出框与主窗同名）
 * @param excludeHwnd 主窗口 hwnd，标题无法区分时排除此窗口，取进程内另一窗口为导出框
 */
export async function findExportDialogHwnd(
  parentPid?: number,
  excludeHwnd?: number
): Promise<number | null> {
  if (process.platform !== "win32") return null;
  for (const name of EXPORT_DIALOG_NAMES) {
    const info = await findWindowByName(name, parentPid ? { processId: parentPid } : undefined);
    if (info?.nativeWindowHandle) return info.nativeWindowHandle;
  }
  for (const name of EXPORT_DIALOG_NAMES) {
    const info = await findWindowByName(name);
    if (info?.nativeWindowHandle) return info.nativeWindowHandle;
  }
  // 剪映专业版：主窗与导出框标题均为「剪映专业版」，排除主窗取另一窗口
  if (parentPid != null && parentPid > 0 && excludeHwnd != null && excludeHwnd !== 0) {
    const windows = await getWindowsByProcessId(parentPid);
    for (const w of windows) {
      if (w.hwnd !== excludeHwnd && w.hwnd > 0) {
        console.log("[directShellBridge] findExportDialogHwnd 排除主窗取另一窗口: hwnd=" + w.hwnd);
        return w.hwnd;
      }
    }
  }
  if (parentPid == null || parentPid <= 0) return null;
  const outPath = join(tmpdir(), `ds_find_export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$filterPid = ${parentPid}`,
    `$outPath = '${safePath}'`,
    `$keywords = @('导出','导出视频','导出设置','Export')`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)`,
    `$result = $null`,
    `foreach ($w in $top) {`,
    `  try { if ($w.Current.ProcessId -ne $filterPid) { continue } } catch { continue }`,
    `  $n = $w.Current.Name`,
    `  if ($n) { foreach ($k in $keywords) { if ($n -like "*$k*") { $result = @{ hwnd = [int]$w.Current.NativeWindowHandle }; break } } }`,
    `  if ($result) { break }`,
    `  $sub = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)`,
    `  foreach ($s in $sub) {`,
    `    try {`,
    `      $n = $s.Current.Name`,
    `      if ($n) { foreach ($k in $keywords) { if ($n -like "*$k*") { $result = @{ hwnd = [int]$s.Current.NativeWindowHandle }; break } } }`,
    `    } catch {}`,
    `    if ($result) { break }`,
    `  }`,
    `  if ($result) { break }`,
    `}`,
    `if ($result) { $result | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8 } else { '{}' | Out-File -LiteralPath $outPath -Encoding utf8 }`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: UIA_SCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const obj = JSON.parse(raw.trim()) as { hwnd?: number };
    if (obj && typeof obj.hwnd === "number" && obj.hwnd > 0) {
      console.log("[directShellBridge] findExportDialogHwnd 子窗口兜底成功, parentPid=", parentPid);
      return obj.hwnd;
    }
  } catch {
    // ignore
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
  // 调试：未找到时枚举剪映所有窗口标题，供定位实际窗口名
  await debugListJianyingWindows(parentPid);
  return null;
}

/** 调试：枚举剪映进程所有窗口的标题与 hwnd，输出到控制台，供 findExportDialogHwnd 定位失败时排查 */
async function debugListJianyingWindows(pid?: number): Promise<void> {
  if (process.platform !== "win32" || pid == null || pid <= 0) return;
  const outPath = join(tmpdir(), `ds_debug_windows_${Date.now()}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$filterPid = ${pid}`,
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)`,
    `$list = @()`,
    `foreach ($w in $top) {`,
    `  try {`,
    `    if ($w.Current.ProcessId -ne $filterPid) { continue }`,
    `    $n = $w.Current.Name`,
    `    $h = [int]$w.Current.NativeWindowHandle`,
    `    $list += @{ hwnd = $h; name = [string]$n }`,
    `  } catch {}`,
    `}`,
    `$list | ConvertTo-Json -Depth 2 -Compress | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 15000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const arr = JSON.parse(raw.trim()) as Array<{ hwnd?: number; name?: string }>;
    if (Array.isArray(arr) && arr.length > 0) {
      console.log("[directShellBridge] [调试] 剪映进程 PID=" + pid + " 的窗口列表（请将导出对话框标题加入 EXPORT_DIALOG_NAMES）：");
      for (const item of arr) {
        console.log("  hwnd=" + item.hwnd + " name=\"" + (item.name ?? "") + "\"");
      }
    }
  } catch {
    // ignore
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/**
 * 定位「另存为」对话框 hwnd；先 Root 级查找，若未找到且提供 notepadPid 则在其子窗口树中查找
 * Win11 记事本另存为可能是 Notepad 的子窗口，非 Root 直接子节点
 */
export async function findSaveDialogHwnd(notepadPid?: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  for (const name of SAVE_DIALOG_NAMES) {
    const info = await findWindowByName(name);
    if (info?.nativeWindowHandle) return info.nativeWindowHandle;
  }
  if (notepadPid == null || notepadPid <= 0) return null;
  const outPath = join(tmpdir(), `ds_find_save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$filterPid = ${notepadPid}`,
    `$outPath = '${safePath}'`,
    `$keywords = @('另存为','Save As','保存为')`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)`,
    `$result = $null`,
    `foreach ($w in $top) {`,
    `  try { if ($w.Current.ProcessId -ne $filterPid) { continue } } catch { continue }`,
    `  $sub = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)`,
    `  foreach ($s in $sub) {`,
    `    try {`,
    `      $n = $s.Current.Name`,
    `      if ($n) { foreach ($k in $keywords) { if ($n -like "*$k*") { $result = @{ hwnd = [int]$s.Current.NativeWindowHandle }; break } } }`,
    `    } catch {}`,
    `    if ($result) { break }`,
    `  }`,
    `  if ($result) { break }`,
    `}`,
    `if ($result) { $result | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8 } else { '{}' | Out-File -LiteralPath $outPath -Encoding utf8 }`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: UIA_SCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const obj = JSON.parse(raw.trim()) as { hwnd?: number };
    if (obj && typeof obj.hwnd === "number" && obj.hwnd > 0) {
      console.log("[directShellBridge] findSaveDialogHwnd 子窗口兜底成功, notepadPid=", notepadPid);
      return obj.hwnd;
    }
  } catch {
    // ignore
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
  return null;
}

/**
 * 定位「打开」文件对话框 hwnd；剪映点击导入后弹出的选文件窗口
 */
export async function findOpenDialogHwnd(parentPid?: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  for (const name of OPEN_DIALOG_NAMES) {
    const info = await findWindowByName(name, parentPid ? { processId: parentPid } : undefined);
    if (info?.nativeWindowHandle) return info.nativeWindowHandle;
  }
  for (const name of OPEN_DIALOG_NAMES) {
    const info = await findWindowByName(name);
    if (info?.nativeWindowHandle) return info.nativeWindowHandle;
  }
  return null;
}

/** 枚举指定进程的顶级窗口（hwnd + 标题），供弹窗定位等使用 */
export async function getWindowsByProcessId(pid: number): Promise<Array<{ hwnd: number; name: string }>> {
  if (process.platform !== "win32" || pid == null || pid <= 0) return [];
  const outPath = join(tmpdir(), `ds_windows_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$filterPid = ${pid}`,
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)`,
    `$list = @()`,
    `foreach ($w in $top) {`,
    `  try {`,
    `    if ($w.Current.ProcessId -ne $filterPid) { continue }`,
    `    $n = $w.Current.Name`,
    `    $h = [int]$w.Current.NativeWindowHandle`,
    `    $list += @{ hwnd = $h; name = [string]$n }`,
    `  } catch {}`,
    `}`,
    `$list | ConvertTo-Json -Depth 2 -Compress | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 15000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const arr = JSON.parse(raw.trim()) as Array<{ hwnd?: number; name?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a != null && typeof a.hwnd === "number")
      .map((a) => ({ hwnd: a.hwnd!, name: String(a.name ?? "") }));
  } catch {
    return [];
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/**
 * 定位剪映「项目选择」弹窗 hwnd（点击开始创作后弹出的新建/本地草稿模态框）
 * 策略：枚举进程窗口，排除主窗，返回第一个其他窗口（通常为弹窗）
 */
export async function findJianyingProjectModalHwnd(pid: number, mainHwnd: number): Promise<number | null> {
  const windows = await getWindowsByProcessId(pid);
  for (const w of windows) {
    if (w.hwnd !== mainHwnd && w.hwnd > 0) return w.hwnd;
  }
  return null;
}

/**
 * 关闭剪映项目选择弹窗（小窗口2）：在「大窗口」坐标系内点击 (0.5, 0.12)
 * 剪映窗口流程：打开→小窗口1(欢迎)→点开始创作→大窗口+小窗口2(项目选择)出现→点小窗口2的开始创作→关闭弹窗
 * 此时 lastWindowHwnd 可能仍是已关闭的小窗口1，故用面积最大窗口作为大窗口，点击其中心偏上（小窗口2覆盖处）
 * @returns 成功时返回大窗口 hwnd（供后续 导入/导出 使用），失败返回 null
 */
export async function dismissJianyingProjectModal(pid: number, _mainHwnd?: number): Promise<number | null> {
  const windows = await getWindowsByProcessId(pid);
  if (windows.length === 0) return null;
  // 取面积最大的窗口为大窗口（编辑主界面），小窗口2（项目选择弹窗）居中覆盖在其上
  let bestHwnd = windows[0].hwnd;
  let bestArea = 0;
  for (const w of windows) {
    const rect = (await getWindowClientRect(w.hwnd)) ?? (await getWindowRect(w.hwnd));
    const area = (rect?.width ?? 0) * (rect?.height ?? 0);
    if (area > bestArea && area > 0) {
      bestArea = area;
      bestHwnd = w.hwnd;
    }
  }
  const rect = (await getWindowClientRect(bestHwnd)) ?? (await getWindowRect(bestHwnd));
  const w = rect?.width ?? 800;
  const h = rect?.height ?? 600;
  const x0 = Math.round(w * 0.5);
  const y0 = Math.round(h * 0.12);
  const ok = useSuperEye()
    ? await supereyeClient.click(bestHwnd, x0, y0).then(() => true).catch(() => false)
    : await clickAtClientCoords(bestHwnd, x0, y0);
  if (ok) {
    console.log("[directShellBridge] 剪映大页面内点击 开始创作(弹窗) 坐标 (" + x0 + "," + y0 + ") hwnd=" + bestHwnd);
    return bestHwnd;
  }
  return null;
}

/** 全屏可见窗口的精简树：Root 第一层 Window，每窗仅保留按钮/输入框等关键交互点 */
export async function getGlobalSnapshot(
  options?: DirectShellOptions
): Promise<GlobalSnapshot> {
  const outPath = join(tmpdir(), `ds_global_snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)`,
    `$keepTypes = @('Button','Edit','ListItem','MenuItem','TabItem','Hyperlink','CheckBox','RadioButton','ComboBox','Window','Text','Dialog')`,
    `function Get-CompressedChildren { param($scope, $depth)`,
    `  if ($depth -gt 15) { return @() }`,
    `  $list = @()`,
    `  $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker`,
    `  $node = $walker.GetFirstChild($scope)`,
    `  while ($node) {`,
    `    try {`,
    `      if (-not $node.Current.IsOffscreen -and $node.Current.IsEnabled) {`,
    `        $ctrl = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''`,
    `        if ($keepTypes -contains $ctrl) {`,
    `          $r = $node.Current.BoundingRectangle`,
    `          $rect = "$([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height)"`,
    `          $list += @{ role=$ctrl; name=$node.Current.Name; automationId=$node.Current.AutomationId; rect=$rect }`,
    `        }`,
    `        $list += Get-CompressedChildren -scope $node -depth ($depth+1)`,
    `      }`,
    `    } catch {}`,
    `    $node = $walker.GetNextSibling($node)`,
    `  }`,
    `  return $list`,
    `}`,
    `$all = @()`,
    `foreach ($w in $windows) {`,
    `  try {`,
    `    if ($w.Current.IsOffscreen) { continue }`,
    `    $name = $w.Current.Name`,
    `    $pid = $w.Current.ProcessId`,
    `    $h = $w.Current.NativeWindowHandle`,
    `    $children = Get-CompressedChildren -scope $w -depth 0`,
    `    $all += @{ name=$name; processId=$pid; nativeWindowHandle=[int]$h; children=$children }`,
    `  } catch {}`,
    `}`,
    `$json = $all | ConvertTo-Json -Depth 6 -Compress`,
    `$json | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: UIA_SCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0 && stderr) console.error("[directShellBridge] getGlobalSnapshot stderr:", stderr.trim());
      resolve(code === 0);
    });
  });
  const timestamp = Date.now();
  try {
    const raw = await readFile(outPath, "utf8");
    const arr = JSON.parse(raw.trim()) as Array<{
      name?: string;
      processId?: number;
      nativeWindowHandle?: number;
      children?: Array<{ role?: string; name?: string; automationId?: string; rect?: string }>;
    }>;
    const windows: GlobalWindowNode[] = (Array.isArray(arr) ? arr : []).map((w) => ({
      name: String(w.name ?? ""),
      processId: typeof w.processId === "number" ? w.processId : 0,
      nativeWindowHandle: typeof w.nativeWindowHandle === "number" ? w.nativeWindowHandle : undefined,
      children: (Array.isArray(w.children) ? w.children : []).map((c) => ({
        role: c.role,
        name: c.name,
        automationId: c.automationId,
        rect: c.rect,
      })),
    }));
    return { timestamp, windows };
  } catch (e) {
    if (ok === false) console.error("[directShellBridge] getGlobalSnapshot 未读到有效 JSON:", e);
    return { timestamp, windows: [] };
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

/** Tab 顺序扫描得到的可交互元素（视障用户原理：Tab 移动焦点，反馈当前元素） */
export interface TabOrderElement {
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  controlType: string;
  tabIndex: number;
}

/**
 * 视障用户原理：模拟 Tab 导航，每次 Tab 后读取 FocusedElement，获得「反馈」— 即当前可交互元素列表
 * 用于当 UIA 树查找失败时，用 Tab 顺序扫描作为「眼睛」的兜底策略
 */
export async function enumerateElementsByTabOrder(
  targetHwnd: number,
  options?: { maxTabs?: number; tabDelayMs?: number }
): Promise<TabOrderElement[]> {
  if (process.platform !== "win32" || targetHwnd == null || targetHwnd <= 0) return [];
  const maxTabs = options?.maxTabs ?? 40;
  const tabDelayMs = options?.tabDelayMs ?? 100;
  await bringWindowToFront(targetHwnd);
  await new Promise((r) => setTimeout(r, 150));
  const outPath = join(tmpdir(), `ds_taborder_${Date.now()}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$hwnd = ${targetHwnd}`,
    `$maxTabs = ${maxTabs}`,
    `$delayMs = ${tabDelayMs}`,
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'`,
    `$typ = Add-Type -MemberDefinition $sig -Name Win32SFW -PassThru`,
    `$typ::SetForegroundWindow([IntPtr]$hwnd) | Out-Null`,
    `Start-Sleep -Milliseconds 120`,
    `$list = @()`,
    `$seen = @{}`,
    `for ($i = 0; $i -lt $maxTabs; $i++) {`,
    `  try {`,
    `    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")`,
    `    Start-Sleep -Milliseconds $delayMs`,
    `    $el = [System.Windows.Automation.AutomationElement]::FocusedElement`,
    `    $h = [int]$el.Current.NativeWindowHandle`,
    `    if ($seen[$h] -eq $true) { break }`,
    `    $seen[$h] = $true`,
    `    $r = $el.Current.BoundingRectangle`,
    `    $ctrl = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.',''`,
    `    $list += @{ name=[string]$el.Current.Name; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height; controlType=$ctrl; tabIndex=($i+1) }`,
    `  } catch { break }`,
    `}`,
    `$list | ConvertTo-Json -Depth 3 -Compress | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 20000,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  try {
    const raw = await readFile(outPath, "utf8");
    const arr = JSON.parse(raw.trim()) as Array<{ name?: string; x?: number; y?: number; w?: number; h?: number; controlType?: string; tabIndex?: number }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a != null && (a.name != null || a.controlType != null))
      .map((a) => ({
        name: String(a.name ?? ""),
        rect: {
          x: a.x ?? 0,
          y: a.y ?? 0,
          width: a.w ?? 0,
          height: a.h ?? 0,
        },
        controlType: String(a.controlType ?? ""),
        tabIndex: a.tabIndex ?? 0,
      }));
  } catch {
    return [];
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
}

async function readIsActive(
  options?: DirectShellOptions
): Promise<{ app: string; a11yPath: string | null }> {
  const dir = getProfilesDir(options);
  const activePath = join(dir, "is_active");
  try {
    const text = await readFile(activePath, "utf8");
    const lines = text.trim().split(/\r?\n/);
    const app = lines[0] ?? "none";
    if (app === "none") return { app, a11yPath: null };
    const rel = lines[1] ?? `${app}.a11y`;
    const parts = rel.split(/[/\\]/);
    const fileName = (parts[parts.length - 1] || `${app}.a11y`).trim();
    const a11yFile = fileName.endsWith(".a11y") ? fileName : `${fileName}.a11y`;
    return { app, a11yPath: join(dir, a11yFile) };
  } catch (err) {
    console.error("[directShellBridge] readIsActive 失败:", err);
    return { app: "none", a11yPath: null };
  }
}

export async function readCurrentA11ySnapshot(
  options?: DirectShellOptions
): Promise<A11yState> {
  const dir = getProfilesDir(options);
  const { app, a11yPath } = await readIsActive(options);
  const candidates: string[] = [];
  if (a11yPath) candidates.push(a11yPath);
  const appName = app && app !== "none" ? app : "cursor";
  candidates.push(join(dir, `${appName}.a11y`));
  candidates.push(join(dir, "cursor.a11y"));
  try {
    let content: string | null = null;
    let usedPath = "";
    for (const p of candidates) {
      try {
        content = await readFile(p, "utf8");
        usedPath = p;
        break;
      } catch (_) {}
    }
    if (content == null) return { timestamp: Date.now(), nodes: [] };
    const nodes: A11yNode[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("# ")) continue;
      nodes.push({ raw: line });
    }
    return { timestamp: Date.now(), app, sourcePath: usedPath, nodes } as A11yState & { app?: string; sourcePath?: string };
  } catch (err) {
    console.error("[directShellBridge] readCurrentA11ySnapshot:", err);
    return { timestamp: Date.now(), nodes: [] };
  }
}

export function findNodeByName(
  snapshot: A11yState,
  keyword: string
): A11yNode | undefined {
  try {
    const lower = keyword.toLowerCase();
    return snapshot.nodes.find((n) => {
      const raw = typeof n.raw === "string" ? n.raw : "";
      return raw.toLowerCase().includes(lower);
    });
  } catch (err) {
    console.error("[directShellBridge] findNodeByName:", err);
    return undefined;
  }
}

const SNIPER_TIMEOUT_MS = 7000;
const INJECT_TIMEOUT_MS = 3500;
const WAIT_FOR_TARGET_POLL_MS = 300;
const WAIT_FOR_TARGET_MAX_MS = 1800;

export async function waitForTarget(
  nameOrTarget: string,
  options?: DirectShellOptions & { maxWaitMs?: number; intervalMs?: number }
): Promise<boolean> {
  const maxWait = options?.maxWaitMs ?? WAIT_FOR_TARGET_MAX_MS;
  const interval = options?.intervalMs ?? WAIT_FOR_TARGET_POLL_MS;
  const keyword = nameOrTarget.includes("|") ? nameOrTarget.split("|")[1]?.trim() || nameOrTarget : nameOrTarget;
  if (!keyword) return true;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const snapshot = await readCurrentA11ySnapshot(options);
    if (findNodeByName(snapshot, keyword)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/** 优先 directshell.exe（release → debug 兜底），否则 UiaSniper.exe；与 supereyeClient 查找逻辑一致 */
function getSniperExePath(options?: DirectShellOptions): string | null {
  const cwd = process.cwd();
  const release = join(cwd, "target", "release", "directshell.exe");
  const debug = join(cwd, "target", "debug", "directshell.exe");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  const scriptsDir = getScriptsDir(options);
  const uiaSniper = join(scriptsDir, "uia_sniper", "UiaSniper.exe");
  return existsSync(uiaSniper) ? uiaSniper : null;
}

const HWND_STDOUT_REGEX = /HWND:\s*(\d+)/;

/** 检测字符串是否含非 ASCII（中文等），需要临时文件传参避免编码乱码 */
function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

/** 调用 directshell.exe / UiaSniper.exe，完整捕获 stderr/stdout，解析 "HWND: XXXXX" 返回 hwnd
 *  中文参数通过临时 UTF-8 文件传递，避免 Windows 子进程 GBK 编码导致乱码 */
function runUiaSniper(
  action: string,
  target: string,
  extra: string,
  options?: DirectShellOptions
): Promise<{ ok: boolean; hwnd?: number }> {
  return new Promise(async (resolve) => {
    const exePath = getSniperExePath(options);
    if (!exePath) {
      resolve({ ok: false });
      return;
    }
    const pid = options?.processId;
    const needsFileArg = hasNonAscii(target) || hasNonAscii(extra);
    let argFilePath: string | null = null;

    if (needsFileArg) {
      argFilePath = join(tmpdir(), `ds_sniper_args_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
      const lines = [action, target];
      if (extra) lines.push(extra);
      if (pid != null && pid > 0) lines.push(`/pid:${pid}`);
      try {
        await writeFile(argFilePath, lines.join("\n"), "utf8");
      } catch (e) {
        console.error("[directShellBridge] UiaSniper 参数文件写入失败:", e);
        resolve({ ok: false });
        return;
      }
    }

    const args = needsFileArg && argFilePath
      ? [`/argfile:${argFilePath}`]
      : (() => {
          const a = [action, target];
          if (extra) a.push(extra);
          if (pid != null && pid > 0) a.push(`/pid:${pid}`);
          return a;
        })();

    let stdout = "";
    let stderr = "";
    const child = spawn(exePath, args, {
      cwd: process.cwd(),
      timeout: SNIPER_TIMEOUT_MS,
      windowsHide: true,
    });
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      console.error("[directShellBridge] UiaSniper/directshell spawn error:", err);
      if (argFilePath) unlink(argFilePath).catch(() => {});
      resolve({ ok: false });
    });
    child.on("close", (code, signal) => {
      if (argFilePath) unlink(argFilePath).catch(() => {});
      if (signal === "SIGTERM") {
        console.error("[directShellBridge] UiaSniper/directshell 超时(", SNIPER_TIMEOUT_MS, "ms) 被终止，stderr:", stderr.trim(), "stdout:", stdout.trim());
      } else if (code !== 0) {
        console.error("[directShellBridge] UiaSniper/directshell exit", code, "signal", signal, "stderr:", stderr.trim(), "stdout:", stdout.trim());
      }
      const ok = code === 0;
      const m = stdout.match(HWND_STDOUT_REGEX);
      const hwnd = m && Number.isFinite(parseInt(m[1], 10)) ? parseInt(m[1], 10) : undefined;
      resolve({ ok, hwnd });
    });
  });
}

/** 调用 ds_inject.py，完整捕获 stderr，超时也记录 */
function runInject(
  action: string,
  args: string[],
  options?: DirectShellOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    const scriptsDir = getScriptsDir(options);
    const pyScript = join(scriptsDir, "ds_inject.py");
    const py = process.platform === "win32" ? "py" : "python3";
    let stdout = "";
    let stderr = "";
    const child = spawn(py, [pyScript, action, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DS_PROFILES: getProfilesDir(options) },
      timeout: INJECT_TIMEOUT_MS,
    });
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      console.warn("[directShellBridge] inject 不可用（Python/脚本未找到），快速降级至快捷键/剪贴板:", (err as Error)?.message ?? err);
      resolve(false);
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        console.warn("[directShellBridge] inject 超时不可用，快速降级至快捷键/剪贴板，stderr:", stderr.trim().slice(0, 200));
      } else if (code !== 0) {
        console.warn("[directShellBridge] inject 业务失败 exit", code, "，快速降级，stderr:", stderr.trim().slice(0, 200));
      }
      resolve(code === 0);
    });
  });
}

/** click 结果：供编排层做保存/导入后对话框延迟 */
export interface ClickResult {
  done: boolean;
  triggeredSave?: boolean;
  /** 剪映点击 导入 后打开文件选择对话框 */
  triggeredImport?: boolean;
}

export interface ClickByNameOptions extends DirectShellOptions {
  /** 若提供，则精准按句柄置顶后再发键，顺序：bringWindowToFront(targetHwnd) -> delay -> 快捷键 */
  targetHwnd?: number;
  /** 多窗同名时传入 lastWindowPid，供 exe /pid:N 与 findWindowByName 精准锁定 */
  processId?: number;
  /** 主窗口菜单操作时优先用快捷键（减少对 UIA 依赖，跨应用稳定） */
  preferShortcutFirst?: boolean;
  /** 另存为对话框内的「保存」按钮：用 Enter/Alt+S 替代 Ctrl+S（^s 在对话框无效） */
  saveDialogButton?: boolean;
  /** 另存为对话框内的「桌面」：UiaSniper 失败时用 Alt+D + 粘贴路径兜底 */
  saveDialogDesktop?: boolean;
  /** 剪映导出对话框内的「导出」确认按钮：UIA 常失败，用 Enter 激活默认按钮 */
  exportDialogConfirm?: boolean;
  /** 有 targetHwnd 时可跳过 waitForTarget 轮询（节省 0~1.8s） */
  skipWaitForTarget?: boolean;
}

/** 解析 target 得到窗口名并解析 targetHwnd：若 opts 未提供则 findWindowByName（供 click/typeText/scroll 共用）；支持 processId 多窗精准匹配 */
async function resolveTargetHwnd(
  nameOrTarget: string,
  opts: DirectShellOptions & { targetHwnd?: number; processId?: number }
): Promise<number | undefined> {
  if (opts.targetHwnd != null && opts.targetHwnd !== 0) return opts.targetHwnd;
  const windowPart = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : nameOrTarget.trim();
  if (!windowPart) return undefined;
  const info = await findWindowByName(windowPart, { ...opts, processId: opts.processId });
  return info?.nativeWindowHandle;
}

/** 获取桌面路径（供另存为对话框 Alt+D 兜底） */
function getDesktopPath(): string {
  const up = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!up) return "";
  return up + "\\Desktop";
}

/** 执行 click：先 resolve targetHwnd → bring 置前 → directshell/UiaSniper → inject → 语义快捷键兜底；保留 1.5s 保存延迟 */
export async function clickByName(
  nameOrTarget: string,
  options?: ClickByNameOptions
): Promise<ClickResult> {
  const opts = options ?? {};
  if (!opts.skipWaitForTarget) {
    await waitForTarget(nameOrTarget, options);
  }
  const timing = getExecutionTimingConfig();
  let targetHwnd = opts.targetHwnd;
  if (targetHwnd == null || targetHwnd === 0) {
    const resolved = await resolveTargetHwnd(nameOrTarget, opts);
    if (resolved != null) targetHwnd = resolved;
  }
  if (targetHwnd != null && targetHwnd !== 0) {
    await bringWindowToFront(targetHwnd);
    // bringWindowToFront 内已含 afterBringFrontMs 延迟（单一权威时序）
  }

  const keyword = nameOrTarget.includes("|") ? nameOrTarget.split("|")[1]?.trim() || nameOrTarget : nameOrTarget;
  const shortcut = resolveShortcut(keyword);

  // 另存为对话框内的「保存」按钮：Enter 确认默认按钮，或 Alt+S（保存(S)），^s 在对话框中无效
  /** 点击后是否会打开保存/另存为对话框（下一步需 findSaveDialogHwnd） */
  const opensSaveDialog =
    shortcut === "^s" || shortcut === "%fa" || /^(另存为|Save As|保存为)$/i.test(keyword.trim());
  /** 剪映点击 导入 后会打开文件选择对话框（下一步需 findOpenDialogHwnd） */
  const opensImportDialog =
    /^(导入|添加素材|\+)$/i.test(keyword.trim()) && /剪映|JianyingPro|CapCut/i.test(nameOrTarget);

  if (opts.saveDialogButton && /^(保存|Save)$/i.test(keyword.trim()) && targetHwnd != null && targetHwnd !== 0) {
    const sent = await runSendKeys("{ENTER}");
    if (sent) {
      console.log("[directShellBridge] click 另存为对话框保存按钮: Enter");
      return { done: true, triggeredImport: false };
    }
    const altS = await runSendKeys("%s");
    if (altS) {
      console.log("[directShellBridge] click 另存为对话框保存按钮: Alt+S");
      return { done: true, triggeredImport: false };
    }
  }

  // 剪映导出对话框「导出/确定」：UIA 常失败，Enter 确认默认按钮兜底
  if (opts.exportDialogConfirm && /^(导出|确定|Export|OK)$/i.test(keyword.trim()) && targetHwnd != null && targetHwnd !== 0) {
    await bringWindowToFront(targetHwnd);
    const sent = await runSendKeys("{ENTER}");
    if (sent) {
      console.log("[directShellBridge] click 导出对话框确认按钮: Enter");
      return { done: true, triggeredImport: false };
    }
  }

  // 自主学习优先：用户演示记录的坐标 > 自动化成功缓存
  if (targetHwnd != null && targetHwnd !== 0) {
    const learned = await getLearnedClick(nameOrTarget);
    if (learned?.xRel != null && learned?.yRel != null) {
      try {
        const rect = await getWindowClientRect(targetHwnd) ?? await getWindowRect(targetHwnd);
        const w = rect?.width ?? 800;
        const h = rect?.height ?? 600;
        const x0 = Math.round(w * learned.xRel);
        const y0 = Math.round(h * learned.yRel);
        const ok = useSuperEye()
          ? await supereyeClient.click(targetHwnd, x0, y0).then(() => true).catch(() => false)
          : await clickAtClientCoords(targetHwnd, x0, y0);
        if (ok) {
          const isInputBox =
            /微信|WeChat/i.test(nameOrTarget) && /输入|请输入|输入框|消息/i.test(keyword);
          if (isInputBox) {
            await new Promise((r) => setTimeout(r, 150));
            const focused = await verifyInputBoxFocused();
            if (!focused) {
              console.warn("[directShellBridge] 记忆执行后校验失败（焦点非 Edit），删除记忆:", nameOrTarget);
              await deleteLearnedAction(nameOrTarget);
              /* 不 return，继续后续策略（OCR 等） */
            } else {
              console.log("[directShellBridge] click 自主学习命中:", nameOrTarget, "->", x0 + "," + y0);
              return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
            }
          } else {
            console.log("[directShellBridge] click 自主学习命中:", nameOrTarget, "->", x0 + "," + y0);
            return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
          }
        }
      } catch (_) {
        /* learned 策略失败，继续后续 */
      }
    }
    const cached = await getCachedSuccess(nameOrTarget);
    if (cached?.strategy && cached?.data) {
      try {
        if (cached.strategy === "coordinate" && cached.data.xRel != null && cached.data.yRel != null) {
          const rect = await getWindowClientRect(targetHwnd) ?? await getWindowRect(targetHwnd);
          const w = rect?.width ?? 800;
          const h = rect?.height ?? 600;
          const x0 = Math.round(w * cached.data.xRel);
          const y0 = Math.round(h * cached.data.yRel);
          const ok = useSuperEye()
            ? await supereyeClient.click(targetHwnd, x0, y0).then(() => true).catch(() => false)
            : await clickAtClientCoords(targetHwnd, x0, y0);
          if (ok) {
            console.log("[directShellBridge] click 缓存策略命中(coordinate):", nameOrTarget, "->", x0 + "," + y0);
            return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
          }
        } else if (cached.strategy === "tab_order" && cached.data.screenX != null && cached.data.screenY != null) {
          const ok = await clickAtScreenCoords(cached.data.screenX, cached.data.screenY);
          if (ok) {
            console.log("[directShellBridge] click 缓存策略命中(tab_order):", nameOrTarget);
            return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
          }
        } else if (cached.strategy === "shortcut" && cached.data.keys) {
          const sent = await runSendKeys(cached.data.keys);
          if (sent) {
            console.log("[directShellBridge] click 缓存策略命中(shortcut):", nameOrTarget, "->", cached.data.keys);
            if (opensSaveDialog) await new Promise((r) => setTimeout(r, timing.afterSaveShortcutMs));
            return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
          }
        }
      } catch (_) {
        // 缓存策略失败，继续后续流程
      }
    }
  }

  // 剪映「开始创作」：DirectShell UIA 不完善，优先用自研坐标点击（不依赖 UiaSniper 元素查找）
  const isJianyingStartCreating =
    targetHwnd != null &&
    targetHwnd !== 0 &&
    /剪映|JianyingPro|CapCut/i.test(nameOrTarget) &&
    /^(\+?\s*)?开始创作|Start\s*Creating$/i.test(keyword.trim());
  if (isJianyingStartCreating && targetHwnd != null) {
    const hwnd = targetHwnd;
    const rect = await getWindowClientRect(hwnd) ?? await getWindowRect(hwnd);
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    // 开始创作：往上、靠右、比导出按钮(0.06)稍往下一点
    const x0 = Math.round(w * 0.68);
    const y0 = Math.round(h * 0.14);
    const coordOk = useSuperEye()
      ? await supereyeClient.click(hwnd, x0, y0).then(() => true).catch(() => false)
      : await clickAtClientCoords(hwnd, x0, y0);
    if (coordOk) {
      console.log("[directShellBridge] 剪映 开始创作：自研坐标点击优先 (" + x0 + "," + y0 + ")");
      recordSuccess(nameOrTarget, "coordinate", { xRel: 0.68, yRel: 0.14 }).catch(() => {});
      return { done: true };
    }
  }

  // 剪映编辑界面「导出」：UIA 常失败，优先用自研坐标点击（右上角按钮）
  const isJianyingExportMain =
    targetHwnd != null &&
    targetHwnd !== 0 &&
    /剪映|JianyingPro|CapCut/i.test(nameOrTarget) &&
    /^(导出|导出视频|Export)$/i.test(keyword.trim());
  if (isJianyingExportMain && targetHwnd != null) {
    const hwnd = targetHwnd;
    const rect = await getWindowClientRect(hwnd) ?? await getWindowRect(hwnd);
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    const x0 = Math.round(w * 0.92);
    const y0 = Math.round(h * 0.06);
    const coordOk = useSuperEye()
      ? await supereyeClient.click(hwnd, x0, y0).then(() => true).catch(() => false)
      : await clickAtClientCoords(hwnd, x0, y0);
    if (coordOk) {
      console.log("[directShellBridge] 剪映 导出：自研坐标点击优先 (" + x0 + "," + y0 + ")");
      recordSuccess(nameOrTarget, "coordinate", { xRel: 0.92, yRel: 0.06 }).catch(() => {});
      return { done: true, triggeredSave: false, triggeredImport: opensImportDialog };
    }
  }

  // 剪映编辑界面「导入」：左下素材区，UIA 常失败，坐标兜底
  const isJianyingImport =
    targetHwnd != null &&
    targetHwnd !== 0 &&
    /剪映|JianyingPro|CapCut/i.test(nameOrTarget) &&
    /^(导入|添加素材|\+)$/i.test(keyword.trim());
  if (isJianyingImport && targetHwnd != null) {
    const hwnd = targetHwnd;
    const rect = await getWindowClientRect(hwnd) ?? await getWindowRect(hwnd);
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    const x0 = Math.round(w * 0.06);
    const y0 = Math.round(h * 0.4);
    const coordOk = useSuperEye()
      ? await supereyeClient.click(hwnd, x0, y0).then(() => true).catch(() => false)
      : await clickAtClientCoords(hwnd, x0, y0);
    if (coordOk) {
      console.log("[directShellBridge] 剪映 导入：自研坐标点击优先 (" + x0 + "," + y0 + ")");
      recordSuccess(nameOrTarget, "coordinate", { xRel: 0.06, yRel: 0.4 }).catch(() => {});
      return { done: true, triggeredImport: true };
    }
  }

  // 网页应用 OCR 优先：通义万相/豆包/可灵/即梦/Gemini 等 UIA 常因编码失效，按 UIA_OCR_终极蓝图「首探靠 OCR」
  const windowPartForOcr = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : nameOrTarget.trim();
  const WEB_APPS_OCR_FIRST = ["通义万相", "万相", "豆包", "可灵", "即梦", "Gemini"];
  const isWebAppOcrFirst =
    windowPartForOcr &&
    WEB_APPS_OCR_FIRST.some((a) => nameOrTarget.includes(a)) &&
    targetHwnd != null &&
    targetHwnd !== 0 &&
    keyword.trim();
  if (isWebAppOcrFirst && targetHwnd!) {
    const ocrFirst = await tryOcrClickByName(targetHwnd, nameOrTarget, keyword);
    if (ocrFirst) {
      console.log("[directShellBridge] click 网页应用 OCR 优先成功:", nameOrTarget);
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
    // OCR 失败（常因双屏 getWindowRect 问题）：尝试 FromHandle + 元素名查找，绕过 UiaSniper 窗口名编码
    const hwndClick = await tryClickByHwndAndElement(targetHwnd, keyword);
    if (hwndClick) {
      console.log("[directShellBridge] click 网页应用 FromHandle+元素名成功:", nameOrTarget);
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
  }

  // 语义快捷键前置：主窗口菜单（文件/保存等）优先用快捷键，减少对 UIA 的依赖，跨应用稳定
  if (opts.preferShortcutFirst && shortcut && targetHwnd != null && targetHwnd !== 0) {
    const sent = await runSendKeys(shortcut);
    if (sent) {
      console.log("[directShellBridge] click 语义快捷键优先:", keyword, "->", shortcut);
      if (shortcut) recordSuccess(nameOrTarget, "shortcut", { keys: shortcut }).catch(() => {});
      if (opensSaveDialog) {
        await new Promise((r) => setTimeout(r, timing.afterSaveShortcutMs));
      }
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
  }

  const appName = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : nameOrTarget;
  const UIA_FAILURE_THRESHOLD = 0.5;
  const uiaFailureRate = appName ? await getUiaFailureRate(appName) : 0;
  if (
    appName &&
    targetHwnd != null &&
    targetHwnd !== 0 &&
    keyword.trim() &&
    uiaFailureRate >= UIA_FAILURE_THRESHOLD
  ) {
    const ocrFirst = await tryOcrClickByName(targetHwnd, nameOrTarget, keyword);
    if (ocrFirst) {
      console.log("[directShellBridge] click UIA 失败率高，OCR 优先成功:", nameOrTarget);
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
  }

  const preferSniper = opts.preferUiaSniper ?? true;
  let ok = false;
  if (preferSniper && process.platform === "win32") {
    const targetsToTry = [nameOrTarget];
    const aliases = CLICK_NAME_ALIASES[keyword.trim()];
    if (aliases && aliases.length > 0) {
      const windowPart = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : "";
      for (const alt of aliases) {
        if (alt !== keyword.trim()) {
          targetsToTry.push(windowPart ? `${windowPart}|${alt}` : alt);
        }
      }
    }
    for (const target of targetsToTry) {
      const result = await runUiaSniper("click", target, "", opts);
      if (result.ok) {
        ok = true;
        if (target !== nameOrTarget) console.log("[directShellBridge] click 别名成功:", keyword, "->", target);
        break;
      }
    }
    if (appName) recordUiaResult(appName, ok).catch(() => {});
    if (ok) return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
  }
  // UiaSniper 失败时，SuperEye locator 兜底（UTF-8 友好，解决中文编码问题）
  if (!ok && useSuperEye() && targetHwnd != null && targetHwnd !== 0 && keyword.trim()) {
    try {
      await supereyeClient.clickByLocator(targetHwnd, { name: keyword.trim() });
      console.log("[directShellBridge] click SuperEye locator 兜底成功:", keyword);
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    } catch (e) {
      console.warn("[directShellBridge] SuperEye clickByLocator 失败:", String(e));
    }
  }
  const injectTargets = [nameOrTarget];
  const injectAliases = CLICK_NAME_ALIASES[keyword.trim()];
  if (injectAliases && injectAliases.length > 0) {
    const winPart = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : "";
    for (const alt of injectAliases) {
      if (alt !== keyword.trim()) injectTargets.push(winPart ? `${winPart}|${alt}` : alt);
    }
  }
  for (const t of injectTargets) {
    ok = await runInject("click", [t], opts);
    if (ok) {
      if (t !== nameOrTarget) console.log("[directShellBridge] inject 别名成功:", keyword, "->", t);
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
  }

  // 剪映首页「开始创作」：UIA 常失败，Enter 可能激活默认按钮
  if (
    !ok &&
    targetHwnd != null &&
    targetHwnd !== 0 &&
    /^(开始创作|\+ 开始创作)$/i.test(keyword.trim()) &&
    /剪映|JianyingPro|CapCut/i.test(nameOrTarget)
  ) {
    const sent = await runSendKeys("{ENTER}");
    if (sent) {
      console.log("[directShellBridge] click 剪映开始创作: Enter 兜底");
      return { done: true };
    }
  }

  // 视障用户原理兜底：Tab 顺序扫描 → 找到名称匹配元素 → 点击其中心
  if (!ok && targetHwnd != null && targetHwnd !== 0 && keyword.trim()) {
    const key = keyword.trim().toLowerCase();
    const aliases = CLICK_NAME_ALIASES[keyword.trim()];
    const keysToMatch = [key, ...(aliases ?? []).map((a) => a.toLowerCase())];
    try {
      const elements = await enumerateElementsByTabOrder(targetHwnd, { maxTabs: 35, tabDelayMs: 90 });
      const match = elements.find(
        (e) => e.name && keysToMatch.some((k) => e.name!.toLowerCase().includes(k) || k.includes(e.name!.toLowerCase()))
      );
      if (match && match.rect.width > 0 && match.rect.height > 0) {
        const cx = match.rect.x + Math.round(match.rect.width / 2);
        const cy = match.rect.y + Math.round(match.rect.height / 2);
        const coordOk = await clickAtScreenCoords(cx, cy);
        if (coordOk) {
          console.log("[directShellBridge] click Tab顺序扫描兜底成功:", keyword, "->", match.name);
          recordSuccess(nameOrTarget, "tab_order", { screenX: cx, screenY: cy }).catch(() => {});
          return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
        }
      }
    } catch (e) {
      console.warn("[directShellBridge] Tab顺序扫描兜底失败:", String(e));
    }
  }

  if (shortcut) {
    if (targetHwnd != null && targetHwnd !== 0) {
      const sent = await runSendKeys(shortcut);
      if (sent) {
        console.log("[directShellBridge] click 已用快捷键兜底:", keyword, "->", shortcut);
        recordSuccess(nameOrTarget, "shortcut", { keys: shortcut }).catch(() => {});
        if (opensSaveDialog) {
          await new Promise((r) => setTimeout(r, timing.afterSaveShortcutMs));
        }
        return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
      }
    } else {
      const windowPart = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0].trim() : "";
      const didBring = !!windowPart && (await runBringWindowToFront(windowPart));
      const delayMs = didBring ? 0 : timing.noBringMs;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const sent = await runSendKeys(shortcut);
      if (sent) {
        console.log("[directShellBridge] click 已用快捷键兜底:", keyword, "->", shortcut);
        recordSuccess(nameOrTarget, "shortcut", { keys: shortcut }).catch(() => {});
        if (opensSaveDialog) {
          await new Promise((r) => setTimeout(r, timing.afterSaveShortcutMs));
        }
        return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
      }
    }
  }

  // 另存为对话框「桌面」键盘兜底：Alt+D 聚焦路径栏 → 粘贴桌面路径 → Enter
  if (opts.saveDialogDesktop && /^(桌面|Desktop)$/i.test(keyword.trim()) && targetHwnd != null && targetHwnd !== 0) {
    const desktopPath = getDesktopPath();
    if (desktopPath) {
      const okSet = await setClipboardOnly(desktopPath);
      if (okSet) {
        await runSendKeys("%d");
        await new Promise((r) => setTimeout(r, 150));
        await runSendKeys("^a^v");
        await new Promise((r) => setTimeout(r, 80));
        const sent = await runSendKeys("{ENTER}");
        if (sent) {
          console.log("[directShellBridge] click 另存为桌面: Alt+D + 路径栏粘贴");
          return { done: true };
        }
      }
    }
  }
  // OCR 兜底：0 Token，首探定位 → 写入记忆库供后续复用
  if (targetHwnd != null && targetHwnd !== 0 && keyword.trim()) {
    const ocrOk = await tryOcrClickByName(targetHwnd, nameOrTarget, keyword);
    if (ocrOk) {
      return { done: true, triggeredSave: opensSaveDialog, triggeredImport: opensImportDialog };
    }
  }
  console.warn("[directShellBridge] clickByName 未完成且无快捷键兜底，请确认 UiaSniper/directshell 已就绪");
  return { done: false };
}

/** FromHandle + 元素名查找点击：绕过 UiaSniper 窗口名编码，元素名通过 UTF-8 文件传入；自动包含别名 */
async function tryClickByHwndAndElement(hwnd: number, keyword: string): Promise<boolean> {
  if (process.platform !== "win32" || !keyword.trim()) return false;
  const kwPath = join(tmpdir(), `ds_hwnd_kw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    const allKeywords = [keyword.trim(), ...(CLICK_NAME_ALIASES[keyword.trim()] ?? [])];
    const unique = [...new Set(allKeywords)];
    await writeFile(kwPath, unique.join("\n"), "utf8");
    const safePath = escapeForPsSingleQuoted(kwPath);
    const script = [
      `$kwPath = '${safePath}'`,
      `$keywords = (Get-Content -LiteralPath $kwPath -Encoding UTF8) -split "\\r?\\n" | Where-Object { $_.Trim() }`,
      `if (-not $keywords) { exit 1 }`,
      `Add-Type -AssemblyName UIAutomationClient`,
      `Add-Type -AssemblyName UIAutomationTypes`,
      `$h = [IntPtr]${hwnd}`,
      `$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)`,
      `if (-not $root) { exit 2 }`,
      `$found = $null`,
      `$walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker`,
      `function Find-ByName { param($scope, $depth)`,
      `  if ($depth -gt 20 -or $found) { return }`,
      `  $node = $walker.GetFirstChild($scope)`,
      `  while ($node) {`,
      `    try {`,
      `      if (-not $node.Current.IsOffscreen -and $node.Current.IsEnabled) {`,
      `        $n = [string]$node.Current.Name`,
      `        foreach ($kw in $keywords) {`,
      `          if ($n -and $n.IndexOf($kw, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $script:found = $node; return }`,
      `        }`,
      `        Find-ByName -scope $node -depth ($depth+1)`,
      `        if ($found) { return }`,
      `      }`,
      `    } catch {}`,
      `    $node = $walker.GetNextSibling($node)`,
      `  }`,
      `}`,
      `Find-ByName -scope $root -depth 0`,
      `if (-not $found) { exit 3 }`,
      `$r = $found.Current.BoundingRectangle`,
      `$cx = [int]($r.X + $r.Width/2)`,
      `$cy = [int]($r.Y + $r.Height/2)`,
      `Write-Output ($cx.ToString() + "," + $cy.ToString())`,
    ].join("\r\n");
    const encoded = toEncodedCommand(script);
    const out = await new Promise<string>((res) => {
      const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
        cwd: process.cwd(),
        timeout: 8000,
        windowsHide: true,
      });
      let buf = "";
      child.stdout?.on("data", (d) => { buf += String(d); });
      child.stderr?.on("data", (d) => { console.warn("[tryClickByHwndAndElement] stderr:", String(d).trim()); });
      child.on("close", () => res(buf.trim()));
    });
    const m = out.match(/^(\d+),(\d+)$/);
    if (!m) {
      if (out) console.warn("[directShellBridge] tryClickByHwndAndElement 未找到元素或解析失败:", keyword);
      return false;
    }
    const screenX = parseInt(m[1], 10);
    const screenY = parseInt(m[2], 10);
    const ok = await clickAtScreenCoords(screenX, screenY);
    if (ok) console.log("[directShellBridge] FromHandle+元素名点击成功:", keyword, "->", screenX, screenY);
    return ok;
  } finally {
    try { await unlink(kwPath); } catch (_) {}
  }
}

/** OCR 兜底：区域截图 → 本地 OCR → 模糊匹配 → 点击 → 写入记忆库（source: ocr） */
async function tryOcrClickByName(
  hwnd: number,
  nameOrTarget: string,
  keyword: string
): Promise<boolean> {
  try {
    await bringWindowToFront(hwnd);
    await new Promise((r) => setTimeout(r, 150));
    const rect = await getWindowRectFull(hwnd);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      console.warn("[directShellBridge] OCR 兜底失败：无法获取窗口尺寸，请检查窗口是否有效");
      return false;
    }
    const isWeChatInput =
      /微信|WeChat/i.test(nameOrTarget) && /输入|请输入|输入框|消息/i.test(keyword);
    const isJianyingExport =
      /剪映|JianyingPro|CapCut/i.test(nameOrTarget) && /导出|Export/i.test(keyword);
    const isJianyingImport =
      /剪映|JianyingPro|CapCut/i.test(nameOrTarget) && /^(导入|添加素材|\+)$/i.test(keyword.trim());
    const isBrowserAddress =
      /浏览器|Chrome|Edge|Firefox/i.test(nameOrTarget) && /地址|URL|搜索|search/i.test(keyword);
    const isWebGen =
      /通义万相|万相|豆包|可灵|即梦|Gemini/i.test(nameOrTarget);
    let region: { xRel: number; yRel: number; wRel: number; hRel: number };
    if (isWeChatInput) {
      region = { xRel: 0, yRel: 0.7, wRel: 1, hRel: 0.3 };
    } else if (isJianyingExport) {
      region = { xRel: 0.7, yRel: 0, wRel: 0.3, hRel: 0.15 };
    } else if (isJianyingImport) {
      region = { xRel: 0, yRel: 0.3, wRel: 0.3, hRel: 0.35 };
    } else if (isBrowserAddress) {
      region = { xRel: 0, yRel: 0, wRel: 1, hRel: 0.15 };
    } else if (isWebGen && /输入|描述|请输入/i.test(keyword)) {
      region = { xRel: 0.15, yRel: 0.2, wRel: 0.7, hRel: 0.5 };
    } else if (isWebGen && /生成|创意画作|Generate/i.test(keyword)) {
      region = { xRel: 0.2, yRel: 0.4, wRel: 0.6, hRel: 0.4 };
    } else if (isWebGen && /下载|保存|Download/i.test(keyword)) {
      region = { xRel: 0.3, yRel: 0.5, wRel: 0.4, hRel: 0.4 };
    } else {
      region = { xRel: 0, yRel: 0, wRel: 1, hRel: 1 };
    }
    const b64 = await screenshotRegion(hwnd, region);
    if (!b64) {
      console.warn(
        "[directShellBridge] OCR 兜底失败：区域截图失败，请检查窗口是否在前台或未被遮挡"
      );
      return false;
    }
    const words = await ocrBridge.recognize(b64);
    if (!words.length) {
      console.warn(
        "[directShellBridge] OCR 兜底失败：未识别到文字，请检查窗口是否在前台或尝试手动教学「这是XXX」"
      );
      return false;
    }
    const keywords = [
      keyword.trim(),
      ...(CLICK_NAME_ALIASES[keyword.trim()] ?? []),
      ...(isWeChatInput ? ["输入", "请输入", "输入框", "消息"] : []),
      ...(isJianyingExport ? ["导出", "Export", "导出视频"] : []),
      ...(isJianyingImport ? ["导入", "添加素材", "Import", "+"] : []),
      ...(isBrowserAddress ? ["地址", "URL", "搜索", "search", "输入网址"] : []),
      ...(isWebGen && /输入|描述/i.test(keyword) ? ["输入", "描述", "请输入", "描述你的画作", "Describe"] : []),
      ...(isWebGen && /生成|创意/i.test(keyword) ? ["生成", "创意画作", "立即生成", "Generate"] : []),
      ...(isWebGen && /下载|保存/i.test(keyword) ? ["下载", "原图", "Download", "保存"] : []),
    ].filter(Boolean);
    const match = ocrBridge.findBestMatch(keywords, words);
    if (!match) {
      console.warn(
        "[directShellBridge] OCR 兜底失败：未找到目标文字「" +
          keyword +
          "」，建议手动标记坐标或检查窗口是否在前台"
      );
      return false;
    }
    const imgW = Math.round(region.wRel * rect.width);
    const imgH = Math.round(region.hRel * rect.height);
    const { xRel, yRel } = ocrBridge.imagePointToWindowRel(
      rect,
      region,
      match.centerX,
      match.centerY,
      imgW,
      imgH
    );
    const screenX = Math.round(rect.left + xRel * rect.width);
    const screenY = Math.round(rect.top + yRel * rect.height);
    const ok = await clickAtScreenCoords(screenX, screenY);
    if (!ok) {
      console.warn("[directShellBridge] OCR 兜底失败：点击执行失败，请检查窗口是否被遮挡");
      return false;
    }
    console.log(
      "[directShellBridge] click OCR 兜底成功:",
      nameOrTarget,
      "->",
      match.text,
      "相对坐标",
      xRel.toFixed(3),
      yRel.toFixed(3)
    );
    await appendLearnedAction({
      target: nameOrTarget,
      xRel,
      yRel,
      ts: Date.now(),
      source: "ocr",
    });
    recordSuccess(nameOrTarget, "coordinate", { xRel, yRel }).catch(() => {});
    return true;
  } catch (e) {
    console.warn("[directShellBridge] tryOcrClickByName 失败:", (e as Error)?.message ?? e);
    return false;
  }
}

/** 微信输入框聚焦多策略：优先点击（输入/输入框/请输入），其次坐标点击（聊天区右下 75%,92%），最后 Tab */
export async function focusWeChatInputBox(
  targetHwnd: number,
  windowName: string,
  options?: ClickByNameOptions
): Promise<boolean> {
  await bringWindowToFront(targetHwnd);
  await new Promise((r) => setTimeout(r, 450));
  const opts = { ...options, targetHwnd, skipWaitForTarget: true };
  // 微信 UiaSniper 常失败，优先坐标点击（0.75,0.92）可省 ~1–2s 无效重试
  const rect = await getWindowClientRect(targetHwnd) ?? await getWindowRect(targetHwnd);
  const w = rect?.width ?? 420;
  const h = rect?.height ?? 700;
  const x0 = Math.round(w * 0.75);
  const y0 = Math.round(h * 0.92);
  const coordFirst = useSuperEye()
    ? await supereyeClient.click(targetHwnd, x0, y0).then(() => true).catch(() => false)
    : await clickAtClientCoords(targetHwnd, x0, y0);
  if (coordFirst) {
    console.log("[directShellBridge] 微信输入框：坐标优先点击成功 (" + x0 + "," + y0 + ")");
    return true;
  }
  // SuperEye 优先：waitForElement + clickByLocator（聊天区加载可能较慢）
  if (useSuperEye()) {
    for (const loc of [{ name: "请输入" }, { name: "输入" }, { role: "Edit" }] as const) {
      try {
        const elem = await supereyeClient.waitForElement(targetHwnd, loc, {
          timeoutMs: 2500,
          intervalMs: 180,
        });
        if (elem?.rect) {
          const cx = Math.round((elem.rect.left + elem.rect.right) / 2);
          const cy = Math.round((elem.rect.top + elem.rect.bottom) / 2);
          await supereyeClient.click(targetHwnd, cx, cy);
          console.log("[directShellBridge] 微信输入框：SuperEye waitForElement + 点击成功");
          return true;
        }
      } catch {
        /* 继续尝试下一个 locator */
      }
    }
  }
  // 微信 UiaSniper 常失败，仅试 1 个 keyword 后快速退到坐标点击
  for (const keyword of ["输入"]) {
    const r = await clickByName(`${windowName}|${keyword}`, opts);
    if (r.done) {
      console.log("[directShellBridge] 微信输入框：click " + keyword + " 成功");
      return true;
    }
    break;
  }
  // 坐标点击：多候选位置（rect 已获取）
  const candidates: [number, number][] = [
    [0.75, 0.92], [0.7, 0.9], [0.8, 0.88], [0.72, 0.9],
  ];
  let coordOk = false;
  for (const [px, py] of candidates) {
    const x = Math.round(w * px);
    const y = Math.round(h * py);
    if (useSuperEye()) {
      try {
        await supereyeClient.click(targetHwnd, x, y);
        console.log("[directShellBridge] 微信输入框：SuperEye 坐标点击成功 (" + x + "," + y + ")");
        coordOk = true;
        break;
      } catch {
        coordOk = await clickAtClientCoords(targetHwnd, x, y);
        if (coordOk) {
          console.log("[directShellBridge] 微信输入框：PowerShell 坐标点击成功 (" + x + "," + y + ")");
          break;
        }
      }
    } else {
      coordOk = await clickAtClientCoords(targetHwnd, x, y);
      if (coordOk) {
        console.log("[directShellBridge] 微信输入框：PowerShell 坐标点击成功 (" + x + "," + y + ")");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (coordOk) return true;
  // UIA 树兜底（5s 超时，getGlobalSnapshot 可能较慢）
  const uiaOk = await Promise.race([
    tryClickWeChatInputFromUiaTree(targetHwnd),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (uiaOk) return true;
  // 视觉兜底（需 llava，默认关）：设置 WECHAT_USE_VISION=1 启用
  if (process.env.WECHAT_USE_VISION === "1") {
    const visionOk = await tryVisionClickWeChatInput(targetHwnd);
    if (visionOk) return true;
  }
  console.log("[directShellBridge] 微信输入框：坐标点击未中，兜底 keys Tab");
  for (let i = 0; i < 3; i++) {
    if (await runSendKeys("{TAB}")) await new Promise((r) => setTimeout(r, 80));
  }
  return true;
}

/** 校验当前焦点是否为 Edit 控件（用于记忆执行后判定输入框是否真正激活） */
async function verifyInputBoxFocused(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const code = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (!$el) { exit 1 }
  $ctrl = $el.Current.ControlType.ProgrammaticName
  if ($ctrl -match 'Edit') { exit 0 }
} catch {}
exit 1
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    child.on("close", (c) => resolve(c === 0));
  });
}

/** UIA 树兜底：getGlobalSnapshot 找 Edit 控件，取最下方（消息输入框在底部）→ 点击中心 */
async function tryClickWeChatInputFromUiaTree(targetHwnd: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const snapshot = await getGlobalSnapshot();
    const win = snapshot.windows.find(
      (w) => w.nativeWindowHandle === targetHwnd || w.name?.includes("微信") || w.name?.includes("WeChat")
    );
    if (!win?.children?.length) return false;
    const edits = win.children.filter((c) => /^Edit$/i.test(c.role ?? ""));
    if (edits.length === 0) return false;
    const parseRect = (r?: string) => {
      const m = (r ?? "").match(/^(\d+),(\d+),(\d+),(\d+)$/);
      return m ? { x: parseInt(m[1], 10), y: parseInt(m[2], 10), w: parseInt(m[3], 10), h: parseInt(m[4], 10) } : null;
    };
    const withRect = edits
      .map((e) => ({ node: e, r: parseRect(e.rect) }))
      .filter((x): x is { node: { name?: string }; r: { x: number; y: number; w: number; h: number } } => x.r != null && x.r.h > 10);
    if (withRect.length === 0) return false;
    const bottom = withRect.sort((a, b) => b.r.y + b.r.h - (a.r.y + a.r.h))[0];
    const cx = Math.round(bottom.r.x + bottom.r.w / 2);
    const cy = Math.round(bottom.r.y + bottom.r.h / 2);
    const ok = await clickAtScreenCoords(cx, cy);
    if (ok) console.log("[directShellBridge] 微信输入框：UIA 树 Edit 点击成功 (" + cx + "," + cy + ")");
    return ok;
  } catch (e) {
    console.warn("[directShellBridge] 微信输入框 UIA 树兜底失败:", (e as Error)?.message ?? e);
    return false;
  }
}

/** 在屏幕坐标处点击（UIA BoundingRectangle 为屏幕坐标） */
async function clickAtScreenCoords(screenX: number, screenY: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const code = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int a, int b, int c, int d);
}
'@
[W]::SetCursorPos(` +
    screenX +
    `, ` +
    screenY +
    `)
Start-Sleep -Milliseconds 50
[W]::mouse_event(0x02, 0, 0, 0, 0)
Start-Sleep -Milliseconds 30
[W]::mouse_event(0x04, 0, 0, 0, 0)
exit 0
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("close", (c) => resolve(c === 0));
  });
}

/** 视觉兜底：截图 → Vision LLM 定位消息输入框中心（0-1 相对坐标）→ 点击 */
async function tryVisionClickWeChatInput(targetHwnd: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const b64 = await screenshotWindowToBase64(targetHwnd);
    if (!b64) return false;
    const prompt =
      '这是微信聊天窗口截图。请指出「消息输入框」（打字区域）的中心点，以窗口宽高百分比表示。只输出 JSON：{"x":0.75,"y":0.92}，x 和 y 为 0-1 之间的小数，不要其他文字。';
    const content = await visionChatCompletion({
      ...VISION_LLM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text" as const, text: prompt },
            { type: "image_url" as const, image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
      maxTokens: 128,
      timeoutMs: 15000,
      jsonMode: true,
    });
    const m = content?.match(/\{[^{}]*"x"[^{}]*"y"[^{}]*\}/);
    if (!m) return false;
    const obj = JSON.parse(m[0]) as { x?: number; y?: number };
    const px = typeof obj.x === "number" ? Math.max(0, Math.min(1, obj.x)) : 0.75;
    const py = typeof obj.y === "number" ? Math.max(0, Math.min(1, obj.y)) : 0.92;
    const rect = await getWindowClientRect(targetHwnd) ?? { width: 420, height: 700 };
    const x = Math.round(rect.width * px);
    const y = Math.round(rect.height * py);
    const ok = await clickAtClientCoords(targetHwnd, x, y);
    if (ok) console.log("[directShellBridge] 微信输入框：Vision 定位点击成功 (" + x + "," + y + ")");
    return ok;
  } catch (e) {
    console.warn("[directShellBridge] 微信输入框 Vision 兜底失败:", (e as Error)?.message ?? e);
    return false;
  }
}

/** 截取窗口客户区为 PNG base64（PowerShell + System.Drawing） */
export async function screenshotWindowToBase64(hwnd: number): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const code = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WR {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
}
'@
$h = [IntPtr]` +
    hwnd +
    `
$r = New-Object WR+R
if -not ([WR]::GetWindowRect($h, [ref]$r)) { exit 1 }
$w = $r.R - $r.L
$ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, [System.Drawing.Size]::new($w, $ht))
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 10000,
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { console.warn("[screenshot] stderr:", String(d).trim()); });
    child.on("close", (code) => {
      const b64 = out.trim().replace(/\s/g, "");
      resolve(b64 && b64.length > 100 && code === 0 ? b64 : null);
    });
  });
}

/** 通过 PowerShell 获取窗口客户区尺寸 */
async function getWindowClientRect(hwnd: number): Promise<{ width: number; height: number } | null> {
  if (process.platform !== "win32") return null;
  const code = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
}
'@
$r = New-Object W+R
$h = [IntPtr]` +
    hwnd +
    `
if ([W]::GetClientRect($h, [ref]$r)) {
  Write-Output ($r.R - $r.L).ToString() + "," + ($r.B - $r.T).ToString()
}
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("close", () => {
      const m = out.trim().match(/^(\d+),(\d+)$/);
      resolve(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
    });
  });
}

/** 窗口在屏幕上的完整矩形（用于 screenToRel、screenshotRegion、OCR 坐标换算）
 * 双屏时 GetWindowRect 可能失效，fallback 用 GetClientRect + ClientToScreen */
export async function getWindowRectFull(
  hwnd: number
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  if (process.platform !== "win32") return null;
  const runScript = (script: string) =>
    new Promise<string>((res) => {
      const child = spawn("powershell", ["-NoProfile", "-Command", script], {
        cwd: process.cwd(),
        timeout: 3000,
        windowsHide: true,
      });
      let out = "";
      child.stdout?.on("data", (d) => { out += String(d); });
      child.on("close", () => res(out.trim()));
    });

  const parseRect = (s: string) => {
    const m = s.match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/);
    if (!m) return null;
    const left = parseInt(m[1], 10);
    const top = parseInt(m[2], 10);
    const width = parseInt(m[3], 10);
    const height = parseInt(m[4], 10);
    return width > 0 && height > 0 ? { left, top, width, height } : null;
  };

  // 方法 0: DwmGetWindowAttribute DWMWA_EXTENDED_FRAME_BOUNDS（多显示器/Aero 更可靠，参考 j3soon.com / MSDN）
  const code0 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DWM {
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, IntPtr pRect, int sz);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
}
'@
$h = [IntPtr]` +
    hwnd +
    `
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(16)
try {
  $ret = [DWM]::DwmGetWindowAttribute($h, 9, $ptr, 16)
  if ($ret -eq 0) {
    $r = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][DWM+R])
    $w = [Math]::Max(1, $r.R - $r.L)
    $ht = [Math]::Max(1, $r.B - $r.T)
    Write-Output ($r.L.ToString() + "," + $r.T.ToString() + "," + $w.ToString() + "," + $ht.ToString())
  }
} finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
`;
  let out = await runScript(code0);
  let rect = parseRect(out);
  if (rect) return rect;

  // 方法 1: GetWindowRect（主屏常用）
  const code1 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WR {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
}
'@
$r = New-Object WR+R
$h = [IntPtr]` +
    hwnd +
    `
if ([WR]::GetWindowRect($h, [ref]$r)) {
  Write-Output ($r.L.ToString() + "," + $r.T.ToString() + "," + ([Math]::Max(1, $r.R - $r.L)).ToString() + "," + ([Math]::Max(1, $r.B - $r.T)).ToString())
}
`;
  out = await runScript(code1);
  rect = parseRect(out);
  if (rect) return rect;

  // 方法 2: GetClientRect + ClientToScreen（双屏/副屏时更可靠）
  const code2 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WR2 {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
'@
$rect = New-Object WR2+R
$pt = New-Object WR2+POINT
$pt.X=0; $pt.Y=0
$h = [IntPtr]` +
    hwnd +
    `
if ([WR2]::GetClientRect($h, [ref]$rect) -and [WR2]::ClientToScreen($h, [ref]$pt)) {
  $w = [Math]::Max(1, $rect.R - $rect.L)
  $h = [Math]::Max(1, $rect.B - $rect.T)
  Write-Output ($pt.X.ToString() + "," + $pt.Y.ToString() + "," + $w.ToString() + "," + $h.ToString())
}
`;
  out = await runScript(code2);
  rect = parseRect(out);
  return rect;
}

/** 屏幕坐标转窗口相对坐标 (0–1)，用于记忆库写入 */
export function screenToRel(
  rect: { left: number; top: number; width: number; height: number },
  screenX: number,
  screenY: number
): { xRel: number; yRel: number } {
  const w = rect.width || 1;
  const h = rect.height || 1;
  const xRel = Math.max(0, Math.min(1, (screenX - rect.left) / w));
  const yRel = Math.max(0, Math.min(1, (screenY - rect.top) / h));
  return { xRel, yRel };
}

/** 区域截图参数：相对坐标 0–1 */
export interface ScreenshotRegion {
  xRel: number;
  yRel: number;
  wRel: number;
  hRel: number;
}

/** 按窗口内相对区域截图，返回 PNG base64（用于 OCR 提速）
 *  getWindowRectFull 失败时用 getWindowRect + 屏幕左上角兜底 */
export async function screenshotRegion(
  hwnd: number,
  region: ScreenshotRegion
): Promise<string | null> {
  if (process.platform !== "win32") return null;
  let rect = await getWindowRectFull(hwnd);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    const simpleRect = await getWindowRect(hwnd);
    if (simpleRect && simpleRect.width > 0 && simpleRect.height > 0) {
      rect = { left: 0, top: 0, width: simpleRect.width, height: simpleRect.height };
    }
  }
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.round(rect.left + region.xRel * rect.width);
  const y = Math.round(rect.top + region.yRel * rect.height);
  const w = Math.max(1, Math.round(region.wRel * rect.width));
  const h = Math.max(1, Math.round(region.hRel * rect.height));
  const code = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(` +
    w +
    `, ` +
    h +
    `)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(` +
    x +
    `, ` +
    y +
    `, 0, 0, [System.Drawing.Size]::new(` +
    w +
    `, ` +
    h +
    `))
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 10000,
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { console.warn("[screenshotRegion] stderr:", String(d).trim()); });
    child.on("close", (code) => {
      const b64 = out.trim().replace(/\s/g, "");
      resolve(b64 && b64.length > 100 && code === 0 ? b64 : null);
    });
  });
}

/** GetWindowRect 兜底：GetClientRect 失败时用窗口外框尺寸（部分窗口更稳定） */
async function getWindowRect(hwnd: number): Promise<{ width: number; height: number } | null> {
  if (process.platform !== "win32") return null;
  const code = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WR {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }
}
'@
$r = New-Object WR+R
$h = [IntPtr]` +
    hwnd +
    `
if ([WR]::GetWindowRect($h, [ref]$r)) {
  Write-Output ($r.R - $r.L).ToString() + "," + ($r.B - $r.T).ToString()
}
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 3000,
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("close", () => {
      const m = out.trim().match(/^(\d+),(\d+)$/);
      resolve(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
    });
  });
}

/** 通过 PowerShell + user32 在窗口客户区坐标处模拟鼠标点击（不依赖 SuperEye） */
async function clickAtClientCoords(hwnd: number, x: number, y: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const code = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int a, int b, int c, int d);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
}
'@
$p = New-Object W+P
$p.X = ` +
    x +
    `
$p.Y = ` +
    y +
    `
$h = [IntPtr]` +
    hwnd +
    `
if ([W]::ClientToScreen($h, [ref]$p)) {
  [W]::SetCursorPos($p.X, $p.Y)
  Start-Sleep -Milliseconds 50
  [W]::mouse_event(0x02, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 30
  [W]::mouse_event(0x04, 0, 0, 0, 0)
  exit 0
}
exit 1
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", code], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.on("close", (c) => resolve(c === 0));
  });
}

/** 当前前台窗口 + 光标位置（用于学习模式：用户操作后按 Enter 记录） */
export interface ForegroundSnapshot {
  hwnd: number;
  processId: number;
  windowTitle: string;
  rect: { left: number; top: number; width: number; height: number };
  cursor: { screenX: number; screenY: number };
  /** 光标在窗口内的相对坐标 0–1，适配不同分辨率/布局 */
  xRel: number;
  yRel: number;
}

/**
 * 获取当前前台窗口与光标位置，计算客户区相对坐标 (xRel, yRel)（用于自主学习记录）
 * 使用 .ps1 文件执行，避免 -EncodedCommand 编码损坏（GetWindowReect 等）
 */
export async function getForegroundWindowAndCursor(): Promise<ForegroundSnapshot | null> {
  if (process.platform !== "win32") return null;
  const ps1Path = join(tmpdir(), `ds_fg_cursor_${Date.now()}.ps1`);
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public class FG {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern bool GetClientRect(IntPtr h, out R r);",
    "  [DllImport(\"user32.dll\")] public static extern bool ClientToScreen(IntPtr h, ref P p);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out R r);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out P p);",
    "  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }",
    "}",
    "'@",
    "$h = [FG]::GetForegroundWindow()",
    "if ($h -eq [IntPtr]::Zero) { exit 1 }",
    "$pidOut = 0",
    "[FG]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null",
    "$sb = New-Object System.Text.StringBuilder 256",
    "[FG]::GetWindowText($h, $sb, 256) | Out-Null",
    "$title = $sb.ToString()",
    "$wr = New-Object FG+R",
    "if (-not [FG]::GetWindowRect($h, [ref]$wr)) { exit 1 }",
    "$p = New-Object FG+P",
    "if (-not [FG]::GetCursorPos([ref]$p)) { exit 1 }",
    "$rectW = $wr.R - $wr.L",
    "$rectH = $wr.B - $wr.T",
    "$xRel = 0.5",
    "$yRel = 0.5",
    "if ($rectW -gt 0 -and $rectH -gt 0) {",
    "  $xRel = [Math]::Max(0, [Math]::Min(1, ($p.X - $wr.L) / $rectW))",
    "  $yRel = [Math]::Max(0, [Math]::Min(1, ($p.Y - $wr.T) / $rectH))",
    "}",
    "$cr = New-Object FG+R",
    "$pt = New-Object FG+P",
    "$pt.X = 0",
    "$pt.Y = 0",
    "if ([FG]::GetClientRect($h, [ref]$cr) -and [FG]::ClientToScreen($h, [ref]$pt)) {",
    "  $cw = $cr.R - $cr.L",
    "  $ch = $cr.B - $cr.T",
    "  if ($cw -gt 0 -and $ch -gt 0) {",
    "    $xRel = [Math]::Max(0, [Math]::Min(1, ($p.X - $pt.X) / $cw))",
    "    $yRel = [Math]::Max(0, [Math]::Min(1, ($p.Y - $pt.Y) / $ch))",
    "  }",
    "}",
    "$o = @{ hwnd=[int]$h; processId=[int]$pidOut; windowTitle=$title; rect=@{ left=$wr.L; top=$wr.T; width=$rectW; height=$rectH }; cursor=@{ screenX=$p.X; screenY=$p.Y }; xRel=[double]$xRel; yRel=[double]$yRel }",
    "$o | ConvertTo-Json -Compress",
  ].join("\r\n");
  await writeFile(ps1Path, script, "utf8");
  let stdout = "";
  let exitCode = -1;
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => {
      if (process.env.DEBUG_LEARN === "1") process.stderr.write(String(d));
    });
    child.on("close", (c) => { exitCode = c ?? -1; resolve(); });
  });
  try {
    await unlink(ps1Path);
  } catch {
    /* ignore */
  }
  try {
    const lines = stdout.trim().split(/\r?\n/);
    const jsonLine = lines.find((l) => l.trim().startsWith("{") && l.includes("hwnd"));
    const raw = jsonLine ?? lines.pop() ?? "";
    const obj = JSON.parse(raw) as { hwnd?: number; processId?: number; windowTitle?: string; rect?: { left?: number; top?: number; width?: number; height?: number }; cursor?: { screenX?: number; screenY?: number }; xRel?: number; yRel?: number };
    if (obj?.hwnd && obj.rect && obj.cursor != null) {
      return {
        hwnd: obj.hwnd,
        processId: obj.processId ?? 0,
        windowTitle: String(obj.windowTitle ?? ""),
        rect: { left: obj.rect.left ?? 0, top: obj.rect.top ?? 0, width: obj.rect.width ?? 0, height: obj.rect.height ?? 0 },
        cursor: { screenX: obj.cursor.screenX ?? 0, screenY: obj.cursor.screenY ?? 0 },
        xRel: Math.max(0, Math.min(1, obj.xRel ?? 0.5)),
        yRel: Math.max(0, Math.min(1, obj.yRel ?? 0.5)),
      };
    }
  } catch {
    // ignore
  }
  if (process.env.DEBUG_LEARN === "1") {
    console.warn("[getForegroundWindowAndCursor] 失败 exitCode=" + exitCode + " stdoutLen=" + stdout.length + " preview=" + JSON.stringify(stdout.slice(0, 300)));
  }
  return null;
}

/**
 * 获取光标下的窗口与光标相对坐标（不依赖前台焦点）
 * 用 GetCursorPos + WindowFromPoint，纯对话流程可用：用户说「这是XXX」后，提示「请把光标移到目标上，三秒后记录」，
 * 延迟后调用此接口即可拿到光标下的窗口。
 */
export async function getWindowUnderCursor(): Promise<ForegroundSnapshot | null> {
  if (process.platform !== "win32") return null;
  const ps1Path = join(tmpdir(), `ds_cursor_win_${Date.now()}.ps1`);
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public class CU {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr WindowFromPoint(P p);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetClientRect(IntPtr h, out R r);",
    "  [DllImport(\"user32.dll\")] public static extern bool ClientToScreen(IntPtr h, ref P p);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out R r);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out P p);",
    "  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,R,B; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }",
    "}",
    "'@",
    "$p = New-Object CU+P",
    "if (-not [CU]::GetCursorPos([ref]$p)) { exit 1 }",
    "$h = [CU]::WindowFromPoint($p)",
    "if ($h -eq [IntPtr]::Zero) { exit 1 }",
    "$pidOut = 0",
    "[CU]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null",
    "$sb = New-Object System.Text.StringBuilder 256",
    "[CU]::GetWindowText($h, $sb, 256) | Out-Null",
    "$title = $sb.ToString()",
    "$wr = New-Object CU+R",
    "if (-not [CU]::GetWindowRect($h, [ref]$wr)) { exit 1 }",
    "$rectW = $wr.R - $wr.L",
    "$rectH = $wr.B - $wr.T",
    "$xRel = 0.5",
    "$yRel = 0.5",
    "if ($rectW -gt 0 -and $rectH -gt 0) {",
    "  $xRel = [Math]::Max(0, [Math]::Min(1, ($p.X - $wr.L) / $rectW))",
    "  $yRel = [Math]::Max(0, [Math]::Min(1, ($p.Y - $wr.T) / $rectH))",
    "}",
    "$cr = New-Object CU+R",
    "$pt = New-Object CU+P",
    "$pt.X = 0",
    "$pt.Y = 0",
    "if ([CU]::GetClientRect($h, [ref]$cr) -and [CU]::ClientToScreen($h, [ref]$pt)) {",
    "  $cw = $cr.R - $cr.L",
    "  $ch = $cr.B - $cr.T",
    "  if ($cw -gt 0 -and $ch -gt 0) {",
    "    $xRel = [Math]::Max(0, [Math]::Min(1, ($p.X - $pt.X) / $cw))",
    "    $yRel = [Math]::Max(0, [Math]::Min(1, ($p.Y - $pt.Y) / $ch))",
    "  }",
    "}",
    "$o = @{ hwnd=[int]$h; processId=[int]$pidOut; windowTitle=$title; rect=@{ left=$wr.L; top=$wr.T; width=$rectW; height=$rectH }; cursor=@{ screenX=$p.X; screenY=$p.Y }; xRel=[double]$xRel; yRel=[double]$yRel }",
    "$o | ConvertTo-Json -Compress",
  ].join("\r\n");
  await writeFile(ps1Path, script, "utf8");
  let stdout = "";
  let exitCode = -1;
  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => {
      if (process.env.DEBUG_LEARN === "1") process.stderr.write(String(d));
    });
    child.on("close", (c) => { exitCode = c ?? -1; resolve(); });
  });
  try {
    await unlink(ps1Path);
  } catch {
    /* ignore */
  }
  try {
    const lines = stdout.trim().split(/\r?\n/);
    const jsonLine = lines.find((l) => l.trim().startsWith("{") && l.includes("hwnd"));
    const raw = jsonLine ?? lines.pop() ?? "";
    const obj = JSON.parse(raw) as { hwnd?: number; processId?: number; windowTitle?: string; rect?: { left?: number; top?: number; width?: number; height?: number }; cursor?: { screenX?: number; screenY?: number }; xRel?: number; yRel?: number };
    if (obj?.hwnd && obj.rect && obj.cursor != null) {
      return {
        hwnd: obj.hwnd,
        processId: obj.processId ?? 0,
        windowTitle: String(obj.windowTitle ?? ""),
        rect: { left: obj.rect.left ?? 0, top: obj.rect.top ?? 0, width: obj.rect.width ?? 0, height: obj.rect.height ?? 0 },
        cursor: { screenX: obj.cursor.screenX ?? 0, screenY: obj.cursor.screenY ?? 0 },
        xRel: Math.max(0, Math.min(1, obj.xRel ?? 0.5)),
        yRel: Math.max(0, Math.min(1, obj.yRel ?? 0.5)),
      };
    }
  } catch {
    // ignore
  }
  if (process.env.DEBUG_LEARN === "1") {
    console.warn("[getWindowUnderCursor] 失败 exitCode=" + exitCode + " stdoutLen=" + stdout.length);
  }
  return null;
}

export interface TypeTextOptions extends DirectShellOptions {
  /** 若提供，则精准按句柄置顶后再粘贴，顺序：bringWindowToFront(targetHwnd) -> delay -> 剪贴板粘贴 */
  targetHwnd?: number;
  /** 多窗同名时传入 lastWindowPid，供 exe /pid:N 与 findWindowByName 精准锁定 */
  processId?: number;
  /** 另存为/导出对话框文件名输入：粘贴前 Alt+N 聚焦、Ctrl+A 全选，确保粘贴到正确控件 */
  context?: "save_dialog_filename" | "export_dialog_filename" | "open_dialog_filename";
  /** 剪贴板已预填，跳过 Set-Clipboard，直接置顶+Ctrl+V（用于丝滑衔接） */
  skipSetClipboard?: boolean;
}

/**
 * ds_text：剪贴板秒贴（降维打击）— 废弃逐字 SendKeys。
 * 顺序严格：1) Set-Clipboard  2) HWND 精准置顶 + 呼吸延迟  3) 发送 Ctrl+V。
 * 语义快捷键（保存 -> ^s + 1500ms 对话框延迟）在 clickByName 中已实现。
 */
export async function typeText(
  text: string,
  targetOrOptions?: string | TypeTextOptions,
  options?: TypeTextOptions
): Promise<void> {
  const opts = typeof targetOrOptions === "object" ? targetOrOptions : options;
  const target = typeof targetOrOptions === "string" ? targetOrOptions : "";
  if (target) await waitForTarget(target, opts);

  const timing = getExecutionTimingConfig();

  if (process.platform === "win32" && text) {
    const skip = opts?.skipSetClipboard === true;
    const okSet = skip || (await setClipboardOnly(text));
    if (!okSet) {
      console.warn("[directShellBridge] typeText Set-Clipboard 失败，尝试 directshell/inject 兜底");
    } else {
      let targetHwnd = opts?.targetHwnd;
      if (targetHwnd == null || targetHwnd === 0) {
        const resolved = await resolveTargetHwnd(target, opts ?? {});
        if (resolved != null) targetHwnd = resolved;
      }
      if (targetHwnd != null && targetHwnd !== 0) {
        await bringWindowToFront(targetHwnd);
        if (opts?.context === "save_dialog_filename" || opts?.context === "export_dialog_filename" || opts?.context === "open_dialog_filename") {
          await new Promise((r) => setTimeout(r, 120));
          await runSendKeys("%n^a");
          await new Promise((r) => setTimeout(r, 80));
        }
      } else if (target) {
        const { window } = parseTarget(target);
        if (window) await runBringWindowToFront(window);
      }
      const sent = await sendCtrlVOnly();
      if (sent) {
        console.log("[directShellBridge] typeText 剪贴板秒贴成功（Set-Clipboard -> 置顶 -> Ctrl+V）");
        return;
      }
    }
  }

  let targetHwnd = opts?.targetHwnd;
  if (targetHwnd == null || targetHwnd === 0) {
    const resolved = await resolveTargetHwnd(target, opts ?? {});
    if (resolved != null) targetHwnd = resolved;
  }
  if (targetHwnd != null && targetHwnd !== 0) {
    await bringWindowToFront(targetHwnd);
  } else if (target) {
    const { window } = parseTarget(target);
    if (window) await runBringWindowToFront(window);
  }

  let ok = false;
  const preferSniper = opts?.preferUiaSniper ?? true;
  if (preferSniper && process.platform === "win32" && target) {
    const result = await runUiaSniper("text", target, text, opts ?? undefined);
    ok = result.ok;
    if (ok) return;
  }
  ok = await runInject("text", [text, target].filter(Boolean), opts ?? undefined);
  if (ok) return;
}

/** 先 resolve targetHwnd → bring 置前 → directshell/UiaSniper → inject */
export async function scroll(
  direction: "up" | "down" | "left" | "right",
  targetOrOptions?: string | DirectShellOptions,
  options?: DirectShellOptions
): Promise<void> {
  const opts = typeof targetOrOptions === "object" ? targetOrOptions : options;
  const target = typeof targetOrOptions === "string" ? targetOrOptions : "";
  const timing = getExecutionTimingConfig();
  let targetHwnd = (opts as { targetHwnd?: number })?.targetHwnd;
  if ((targetHwnd == null || targetHwnd === 0) && target) {
    const resolved = await resolveTargetHwnd(target, opts ?? {});
    if (resolved != null) targetHwnd = resolved;
  }
  if (targetHwnd != null && targetHwnd !== 0) {
    await bringWindowToFront(targetHwnd);
    // bringWindowToFront 内已含 afterBringFrontMs 延迟（单一权威时序）
  }
  const preferSniper = opts?.preferUiaSniper ?? true;
  if (preferSniper && process.platform === "win32" && target) {
    const result = await runUiaSniper("scroll", target, direction, opts ?? undefined);
    if (result.ok) return;
  }
  await runInject("scroll", [direction, target].filter(Boolean), opts ?? undefined);
}

export async function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  options?: DirectShellOptions
): Promise<void> {
  const fromStr = `${Math.round(from.x)},${Math.round(from.y)}`;
  const toStr = `${Math.round(to.x)},${Math.round(to.y)}`;
  await runInject("drag", [fromStr, toStr], options);
}

/** 向前台窗口发送快捷键（如 {ENTER}、^s）。用于发微信等流程的发送步骤 */
export async function sendKeys(keys: string): Promise<boolean> {
  if (process.platform !== "win32" || !keys) return false;
  return runSendKeys(keys);
}
