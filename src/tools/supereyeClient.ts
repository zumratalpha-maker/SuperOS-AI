/**
 * SuperEye Daemon IPC 客户端
 * 通过 stdio JSON-RPC 与 supereye --stdio 进程通信
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WindowInfo {
  hwnd: number;
  process_id: number;
  name: string;
}

export interface ElementInfo {
  hwnd: number;
  name?: string;
  role?: string;
  automation_id?: string;
  rect?: { left: number; top: number; right: number; bottom: number };
}

export interface Locator {
  name?: string;
  role?: string;
  automation_id?: string;
  index?: number;
}

let proc: ReturnType<typeof spawn> | null = null;
let procReady = false;
/** 按请求 id 匹配响应，超时后可安全移除 */
const pendingById = new Map<number, { resolve: (line: string) => void; reject: (e: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>();
let stdoutBuffer = "";

function getSuperEyePath(): string {
  const cwd = process.cwd();
  const debug = join(cwd, "target", "debug", "supereye.exe");
  const release = join(cwd, "target", "release", "supereye.exe");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  return release;
}

function ensureProc(): Promise<boolean> {
  if (proc && procReady) return Promise.resolve(true);
  if (proc && !proc.exitCode) return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 500);
    proc?.once("spawn", () => { clearTimeout(t); procReady = true; resolve(true); });
  });

  const exe = getSuperEyePath();
  try {
    proc = spawn(exe, ["--stdio"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    console.warn("[supereyeClient] 启动失败:", e);
    return Promise.resolve(false);
  }

  proc.stdin?.on("error", () => {});
  proc.stderr?.on("data", (d) => console.warn("[supereye] stderr:", String(d).trim()));
  proc.on("error", (e) => console.warn("[supereyeClient] 进程错误:", e));
  proc.on("exit", (code) => {
    proc = null;
    procReady = false;
    for (const [, { reject }] of pendingById) {
      try { reject(new Error(`supereye exited: ${code}`)); } catch (_) {}
    }
    pendingById.clear();
  });

  stdoutBuffer = "";
  proc.stdout?.on("data", (d) => {
    stdoutBuffer += String(d);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { id?: number };
        const rid = typeof obj?.id === "number" ? obj.id : 0;
        const pending = rid ? pendingById.get(rid) : undefined;
        if (pending) {
          pendingById.delete(rid);
          clearTimeout(pending.timeoutId);
          pending.resolve(trimmed);
        }
      } catch (_) {
        /* 非 JSON 行忽略 */
      }
    }
  });

  procReady = true;
  return Promise.resolve(true);
}

const RPC_TIMEOUT_MS = 20000; // 单次 RPC 超时，避免 find_window_by_profile 等慢操作挂死

let reqId = 0;
async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const ok = await ensureProc();
  if (!ok || !proc?.stdin?.writable) {
    throw new Error("SuperEye daemon 不可用");
  }

  const id = ++reqId;
  const req = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingById.delete(id);
      console.warn("[supereyeClient] RPC 超时 (%sms): %s", RPC_TIMEOUT_MS, method);
      reject(new Error(`SuperEye RPC 超时 (${RPC_TIMEOUT_MS}ms)`));
    }, RPC_TIMEOUT_MS);

    const onResolve = (line: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      pendingById.delete(id);
      try {
        const resp = JSON.parse(line) as { result?: T; error?: { code: number; message: string } };
        if (resp.error) {
          reject(new Error(resp.error.message || `RPC error ${resp.error.code}`));
        } else {
          resolve(resp.result as T);
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const onReject = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      pendingById.delete(id);
      reject(e);
    };
    pendingById.set(id, { resolve: onResolve, reject: onReject, timeoutId });
    proc!.stdin!.write(req + "\n", (err) => {
      if (err && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        pendingById.delete(id);
        reject(err);
      }
    });
  });
}

/** 窗口列表 */
export async function listWindows(): Promise<WindowInfo[]> {
  return call<WindowInfo[]>("windows.list", {});
}

/** 按名称/PID 查找窗口；指定 app 时走 Profile 路径（内置微信/记事本/剪映） */
export async function findWindow(
  name: string,
  options?: { app?: string; processId?: number; excludePids?: number[] }
): Promise<WindowInfo | null> {
  const params: Record<string, unknown> = {
    excludePids: options?.excludePids ?? [],
  };
  if (options?.app && options.app.trim()) {
    params.app = options.app.trim();
  } else {
    params.name = name;
    params.processId = options?.processId;
  }
  const result = await call<WindowInfo | null>("window.find", params);
  return result;
}

/** 置前窗口 */
export async function bringFront(hwnd: number): Promise<boolean> {
  await call("window.bringFront", { hwnd });
  return true;
}

/** 输入文本（剪贴板 + Ctrl+V） */
export async function typeText(hwnd: number, text: string): Promise<void> {
  await call("action.type", { hwnd, text });
}

/** 发送快捷键 */
export async function sendKeys(keys: string): Promise<void> {
  await call("action.keys", { keys });
}

/** 点击坐标 */
export async function click(hwnd: number, x: number, y: number): Promise<void> {
  await call("action.click", { hwnd, x, y });
}

/** 按 locator 查找并点击元素中心（UTF-8 友好，兜底 UiaSniper 编码问题） */
export async function clickByLocator(hwnd: number, locator: Locator): Promise<void> {
  await call("action.click", { hwnd, locator });
}

/** 获取元素树 */
export async function getElementTree(hwnd: number, maxDepth?: number): Promise<ElementInfo[]> {
  return call<ElementInfo[]>("element.tree", { hwnd, maxDepth });
}

/** 按 locator 查找元素 */
export async function findElement(hwnd: number, locator: Locator): Promise<ElementInfo | null> {
  return call<ElementInfo | null>("element.find", { hwnd, locator });
}

/** 轮询等待元素出现；超时返回 null */
export async function waitForElement(
  hwnd: number,
  locator: Locator,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<ElementInfo | null> {
  const result = await call<ElementInfo | null>("element.waitFor", {
    hwnd,
    locator,
    timeoutMs: options?.timeoutMs ?? 5000,
    intervalMs: options?.intervalMs ?? 200,
  });
  return result;
}

/** 检查 SuperEye 是否可用（可先 ping windows.list） */
export async function isAvailable(): Promise<boolean> {
  try {
    await listWindows();
    return true;
  } catch {
    return false;
  }
}
