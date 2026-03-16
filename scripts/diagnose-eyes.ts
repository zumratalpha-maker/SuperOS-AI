/**
 * 诊断「眼睛」能力：UIA 能否看见顶级窗口、当前浏览器标题是什么
 * 用法：tsx scripts/diagnose-eyes.ts [open]
 *   - 无参数：列出当前所有顶级窗口标题（先手动打开通义万相再运行）
 *   - open：自动打开通义万相 URL，等 6 秒后列出窗口
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndLaunch } from "../src/tools/appExecutor.js";
import { findWindowByName } from "../src/tools/directShellBridge.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function escapeForPsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

/** 方法 A：Win32 Get-Process MainWindowTitle — 快（<2s），不依赖 UIA */
async function listWindowsViaGetProcess(): Promise<Array<{ name: string; processId: number }>> {
  const outPath = join(tmpdir(), `ds_list_win_${Date.now()}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `$all = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ name=$_.MainWindowTitle; processId=$_.Id } })`,
    `$all | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 5000,
      windowsHide: true,
    });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}${stderr ? " stderr: " + stderr.trim().slice(0, 200) : ""}`))));
  });
  const raw = await readFile(outPath, "utf8");
  try { await unlink(outPath); } catch (_) {}
  if (!raw || !raw.trim()) throw new Error("输出为空（可能被 timeout 中断）");
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch {
    throw new Error(`JSON 解析失败，raw 前 200 字符: ${raw.slice(0, 200)}`);
  }
  return (Array.isArray(arr) ? arr : [arr]).map((w: { name?: string; processId?: number }) => ({
    name: String(w.name ?? "").trim(),
    processId: typeof w.processId === "number" ? w.processId : 0,
  })).filter((w) => w.name.length > 0);
}

/** 方法 B：UIA RootElement — 与 findWindowByName 一致，但可能很慢（窗口多时 10s+） */
async function listWindowsViaUia(): Promise<Array<{ name: string; processId: number }>> {
  const outPath = join(tmpdir(), `ds_list_uia_${Date.now()}.json`);
  const safePath = escapeForPsSingleQuoted(outPath);
  const script = [
    `$outPath = '${safePath}'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$root = [System.Windows.Automation.AutomationElement]::RootElement`,
    `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `$coll = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)`,
    `$all = @()`,
    `foreach ($w in $coll) {`,
    `  try {`,
    `    $name = $w.Current.Name`,
    `    $pid = $w.Current.ProcessId`,
    `    if (-not [string]::IsNullOrWhiteSpace($name)) { $all += @{ name=$name; processId=$pid } }`,
    `  } catch {}`,
    `}`,
    `$all | ConvertTo-Json -Compress | Out-File -LiteralPath $outPath -Encoding utf8`,
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      cwd: process.cwd(),
      timeout: 12000,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  let raw: string;
  try {
    raw = await readFile(outPath, "utf8");
  } finally {
    try { await unlink(outPath); } catch (_) {}
  }
  if (!raw || !raw.trim()) throw new Error("输出为空");
  let arr: Array<{ name?: string; processId?: number }>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "name" in parsed ? [parsed as { name?: string; processId?: number }] : [];
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}，raw 前80字符: ${raw.slice(0, 80)}`);
  }
  return arr.map((w) => ({
    name: String(w.name ?? "").trim(),
    processId: typeof w.processId === "number" ? w.processId : 0,
  })).filter((w) => w.name.length > 0);
}

async function main(): Promise<void> {
  const doOpen = process.argv[2]?.toLowerCase() === "open";
  console.log("[诊断] 眼睛能力检测（UIA 顶级窗口列表）\n");

  if (doOpen) {
    console.log("1. 打开通义万相 URL…");
    const r = await resolveAndLaunch("通义万相");
    if (!r.ok) {
      console.error("[FAIL] resolveAndLaunch:", r.error);
      process.exit(1);
    }
    console.log("   已用默认浏览器打开。等待 6 秒待页面加载…");
    await delay(6000);
  } else {
    console.log("提示：无 open 参数，直接列出当前窗口。若需测试通义万相，请先手动打开网页，或运行: tsx scripts/diagnose-eyes.ts open\n");
  }

  console.log("2. 枚举顶级窗口（优先 Win32 Get-Process，快；fallback UIA）…");
  const start = Date.now();
  let windows: Array<{ name: string; processId: number }>;
  try {
    windows = await listWindowsViaGetProcess();
    console.log(`   Get-Process 耗时 ${Date.now() - start}ms，共 ${windows.length} 个窗口`);
  } catch (e) {
    console.log("   Get-Process 失败:", e instanceof Error ? e.message : String(e));
    console.log("   尝试 UIA…");
    try {
      windows = await listWindowsViaUia();
      console.log(`   UIA 耗时 ${Date.now() - start}ms，共 ${windows.length} 个窗口`);
    } catch (e2) {
      console.error("[FAIL] 枚举失败:", e2 instanceof Error ? e2.message : String(e2));
      process.exit(1);
    }
  }
  console.log("");

  console.log("3. 当前窗口列表（含通义万相关键字会高亮）：");
  const keywords = ["万相", "通义", "阿里云", "wanxiang", "领先", "Microsoft Edge", "Chrome", "新标签页"];
  for (const w of windows) {
    const hit = keywords.some((k) => w.name.includes(k));
    console.log(`   ${hit ? ">>> " : "    "}[pid=${w.processId}] ${w.name.slice(0, 80)}${w.name.length > 80 ? "…" : ""}`);
  }

  console.log("\n4. findWindowByName 测试（通义万相别名）：");
  const aliases = ["万相", "通义万相", "wanxiang", "阿里云", "领先的AI"];
  let anyFound = false;
  for (const alias of aliases) {
    const info = await findWindowByName(alias);
    const found = !!info?.nativeWindowHandle;
    if (found) anyFound = true;
    console.log(`   "${alias}" => ${found ? `hwnd=${info!.nativeWindowHandle} pid=${info!.processId} name="${info!.name}"` : "未找到"}`);
  }

  console.log("\n结论：", anyFound || windows.some((w) => keywords.some((k) => w.name.includes(k)))
    ? "眼睛可见浏览器/通义万相相关窗口"
    : "未发现含通义万相关键字的窗口，可能：1) 页面未加载完 2) 在新标签未激活 3) 标题与预期不同");
}

main().catch((e) => {
  console.error("[诊断] 异常:", e);
  process.exit(1);
});
