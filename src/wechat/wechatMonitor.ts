/**
 * 微信远程指令监控 — 监听桌面微信「文件传输助手」中的新消息
 *
 * 原理：
 *   1. 通过 PowerShell + UIAutomation 定期读取微信窗口中「文件传输助手」聊天的消息列表
 *   2. 识别新消息 → 喂给 dispatch() 执行
 *   3. 执行结果通过模拟输入发回「文件传输助手」
 *
 * 使用方式（在 jarvis.ts 中）：
 *   import { startWeChatMonitor } from "./wechat/wechatMonitor.js";
 *   startWeChatMonitor(dispatch, say);
 */

import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface WeChatMonitorConfig {
  pollIntervalMs: number;
  chatTarget: string;
  enabled: boolean;
}

type DispatchFn = (input: string) => Promise<string>;
type SayFn = (msg: string) => void;

const DEFAULT_CONFIG: WeChatMonitorConfig = {
  pollIntervalMs: 3000,
  chatTarget: "文件传输助手",
  enabled: true,
};

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastProcessedMessages = new Set<string>();
let isProcessing = false;
let config = { ...DEFAULT_CONFIG };
const DATA_DIR = join(process.cwd(), "data", "wechat");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getMessageHistoryPath(): string {
  return join(DATA_DIR, "processed_messages.json");
}

function loadProcessedMessages(): void {
  const path = getMessageHistoryPath();
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      lastProcessedMessages = new Set(data.slice(-200));
    } catch { /* ignore */ }
  }
}

function saveProcessedMessages(): void {
  const path = getMessageHistoryPath();
  try {
    writeFileSync(path, JSON.stringify([...lastProcessedMessages].slice(-200)), "utf-8");
  } catch { /* ignore */ }
}

function messageKey(text: string, index: number): string {
  return `${text.trim().slice(0, 100)}__${index}`;
}

/**
 * 通过 PowerShell 查找微信窗口并读取聊天消息
 * 返回当前聊天窗口中可见的消息文本列表
 */
async function readWeChatMessages(): Promise<string[]> {
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$wechatCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, "微信"
)
$wechat = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wechatCond)
if (-not $wechat) {
  $processCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, "WeChatMainWndForPC"
  )
  $wechat = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $processCond)
}
if (-not $wechat) { Write-Output "##NO_WECHAT##"; exit }

$listCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::List
)
$lists = $wechat.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)

$msgList = $null
foreach ($list in $lists) {
  $name = $list.Current.Name
  if ($name -match '消息' -or $name -eq '' -or $name -match 'Message') {
    $items = $list.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    if ($items.Count -gt 2) { $msgList = $items; break }
  }
}

if (-not $msgList) { Write-Output "##NO_MESSAGES##"; exit }

$count = $msgList.Count
$start = [Math]::Max(0, $count - 10)
for ($i = $start; $i -lt $count; $i++) {
  $item = $msgList[$i]
  $name = $item.Current.Name
  if ($name -and $name.Length -gt 0) {
    Write-Output "##MSG##$name"
  }
}
`;

  return new Promise((resolve) => {
    const scriptPath = join(DATA_DIR, "_read_wechat.ps1");
    const BOM = "\uFEFF";
    writeFileSync(scriptPath, BOM + ps1, { encoding: "utf-8" });

    const child = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command",
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath}'`,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", () => {});

    child.on("close", () => {
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.includes("##NO_WECHAT##") || lines.includes("##NO_MESSAGES##")) {
        resolve([]);
        return;
      }
      const messages = lines
        .filter((l) => l.startsWith("##MSG##"))
        .map((l) => l.replace("##MSG##", "").trim())
        .filter((l) => l.length > 0);
      resolve(messages);
    });

    child.on("error", () => resolve([]));
    setTimeout(() => { try { child.kill(); } catch {} resolve([]); }, 12000);
  });
}

/**
 * 切换到微信的「文件传输助手」聊天
 */
async function switchToFileTransferChat(): Promise<boolean> {
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$root = [System.Windows.Automation.AutomationElement]::RootElement
$wechatCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, "微信"
)
$wechat = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wechatCond)
if (-not $wechat) {
  $processCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, "WeChatMainWndForPC"
  )
  $wechat = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $processCond)
}
if (-not $wechat) { Write-Output "FAIL"; exit }

$hwnd = $wechat.Current.NativeWindowHandle
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
[WinAPI]::ShowWindow([IntPtr]$hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 200
[WinAPI]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
Start-Sleep -Milliseconds 300

# Ctrl+F 打开搜索框
[System.Windows.Forms.SendKeys]::SendWait("^f")
Start-Sleep -Milliseconds 500

# 输入"文件传输助手"
[System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE 20}")
Start-Sleep -Milliseconds 100

$searchText = "文件传输助手"
[System.Windows.Automation.AutomationElement]$searchBox = $null
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$edits = $wechat.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
foreach ($edit in $edits) {
  $name = $edit.Current.Name
  if ($name -match '搜索' -or $name -match 'Search') {
    $searchBox = $edit
    break
  }
}

if ($searchBox) {
  $vp = $searchBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp) { ([System.Windows.Automation.ValuePattern]$vp).SetValue($searchText) }
  Start-Sleep -Milliseconds 800
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Milliseconds 500
  Write-Output "OK"
} else {
  [System.Windows.Forms.SendKeys]::SendWait($searchText)
  Start-Sleep -Milliseconds 800
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Milliseconds 500
  Write-Output "OK"
}
`;

  return new Promise((resolve) => {
    const scriptPath = join(DATA_DIR, "_switch_chat.ps1");
    writeFileSync(scriptPath, "\uFEFF" + ps1, { encoding: "utf-8" });

    const child = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command",
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath}'`,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });

    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    child.on("close", () => resolve(out.includes("OK")));
    child.on("error", () => resolve(false));
  });
}

/**
 * 向微信当前聊天窗口发送消息（模拟输入）
 */
async function sendWeChatMessage(text: string): Promise<boolean> {
  const safeText = text.replace(/[+^%~(){}[\]]/g, "{$&}").replace(/\n/g, "{ENTER}");
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

$root = [System.Windows.Automation.AutomationElement]::RootElement
$wechatCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, "微信"
)
$wechat = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wechatCond)
if (-not $wechat) { Write-Output "FAIL"; exit }

$hwnd = $wechat.Current.NativeWindowHandle
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
[WinAPI2]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
Start-Sleep -Milliseconds 200

# 通过剪贴板粘贴（避免 SendKeys 中文问题）
[System.Windows.Forms.Clipboard]::SetText('${text.replace(/'/g, "''")}')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 300
Write-Output "OK"
`;

  return new Promise((resolve) => {
    const scriptPath = join(DATA_DIR, "_send_msg.ps1");
    writeFileSync(scriptPath, "\uFEFF" + ps1, { encoding: "utf-8" });

    const child = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command",
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath}'`,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });

    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    child.on("close", () => resolve(out.includes("OK")));
    child.on("error", () => resolve(false));
  });
}

/**
 * 判断消息是否是一条指令（而非系统消息/时间戳等）
 */
function isCommandMessage(text: string): boolean {
  if (text.length < 2) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return false;
  if (/^(上午|下午|昨天|今天|星期)/.test(text) && text.length < 15) return false;
  if (text.includes("以下是新消息") || text.includes("已发送") || text.includes("消息已发出")) return false;
  if (text.startsWith("[SuperOS]")) return false;
  return true;
}

/**
 * 从消息文本中提取发送者和内容
 * 微信消息格式通常是 "发送者\n消息内容" 或直接是内容
 */
function extractContent(rawMessage: string): string {
  const lines = rawMessage.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  if (lines.length === 1) return lines[0].trim();
  return lines.slice(1).join("\n").trim() || lines[0].trim();
}

async function pollOnce(dispatchFn: DispatchFn, sayFn: SayFn): Promise<void> {
  if (isProcessing) return;

  try {
    const messages = await readWeChatMessages();
    if (messages.length === 0) return;

    for (let i = 0; i < messages.length; i++) {
      const raw = messages[i];
      const key = messageKey(raw, i);

      if (lastProcessedMessages.has(key)) continue;
      lastProcessedMessages.add(key);

      const content = extractContent(raw);
      if (!content || !isCommandMessage(content)) continue;

      isProcessing = true;
      sayFn(`[微信指令] 收到: ${content}`);

      try {
        const result = await dispatchFn(content);
        const reply = `[SuperOS] ${result || "已执行完成"}`;
        const truncated = reply.length > 500 ? reply.slice(0, 497) + "…" : reply;
        await sendWeChatMessage(truncated);
        sayFn(`[微信回复] ${truncated.slice(0, 80)}…`);
      } catch (e) {
        const errMsg = `[SuperOS] 执行失败: ${(e as Error).message}`;
        await sendWeChatMessage(errMsg);
        sayFn(`[微信错误] ${errMsg}`);
      }

      isProcessing = false;
    }

    saveProcessedMessages();
  } catch (e) {
    console.warn("[wechatMonitor] 轮询异常:", (e as Error).message);
    isProcessing = false;
  }
}

/**
 * 启动微信消息监控
 */
export function startWeChatMonitor(
  dispatchFn: DispatchFn,
  sayFn: SayFn,
  userConfig?: Partial<WeChatMonitorConfig>,
): void {
  if (monitorTimer) {
    sayFn("[微信监控] 已在运行，先停止再重新启动");
    stopWeChatMonitor();
  }

  config = { ...DEFAULT_CONFIG, ...userConfig };
  ensureDataDir();
  loadProcessedMessages();

  sayFn(`[微信监控] 启动成功，每 ${config.pollIntervalMs / 1000} 秒检查「${config.chatTarget}」新消息`);
  sayFn("[微信监控] 请确保微信已登录且「文件传输助手」聊天窗口已打开");

  monitorTimer = setInterval(() => pollOnce(dispatchFn, sayFn), config.pollIntervalMs);
  pollOnce(dispatchFn, sayFn);
}

/**
 * 停止微信消息监控
 */
export function stopWeChatMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  saveProcessedMessages();
  isProcessing = false;
}

/**
 * 检查微信是否正在运行
 */
export function isWeChatRunning(): boolean {
  try {
    const result = execSync(
      'powershell -NoProfile -Command "Get-Process WeChat -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }"',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return result.length > 0 && /^\d+$/.test(result);
  } catch {
    return false;
  }
}

/**
 * 初始化：切换到文件传输助手聊天
 */
export async function initWeChatChat(): Promise<boolean> {
  if (!isWeChatRunning()) {
    console.warn("[wechatMonitor] 微信未运行");
    return false;
  }
  return switchToFileTransferChat();
}

export function isMonitorRunning(): boolean {
  return monitorTimer !== null;
}
