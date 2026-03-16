/**
 * 结果校验模块 — 层5：不是「做完就完」，而是「确认做对」
 * 校验维度：文件存在性、窗口出现、文本内容、消息发送、导出完成
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";

function runPowershell(script: string, timeoutMs = 5000): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
}

export interface ValidationResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * 校验文件是否存在且满足最小大小
 */
export function validateFileExists(
  filePath: string,
  options?: { minSizeBytes?: number; extensions?: string[] },
): ValidationResult {
  const minSize = options?.minSizeBytes ?? 0;
  const exts = options?.extensions;

  if (!existsSync(filePath)) {
    return { passed: false, message: `文件不存在: ${filePath}` };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { passed: false, message: `路径不是文件: ${filePath}` };
  }
  if (stat.size < minSize) {
    return {
      passed: false,
      message: `文件大小不足: ${stat.size} bytes < 要求 ${minSize} bytes`,
      details: { actualSize: stat.size, requiredSize: minSize },
    };
  }
  if (exts && exts.length > 0) {
    const ext = extname(filePath).toLowerCase();
    if (!exts.includes(ext)) {
      return {
        passed: false,
        message: `文件格式不符: ${ext}，要求 ${exts.join("|")}`,
        details: { actualExt: ext, requiredExts: exts },
      };
    }
  }
  return {
    passed: true,
    message: `文件校验通过: ${filePath} (${formatBytes(stat.size)})`,
    details: { size: stat.size, path: filePath },
  };
}

/**
 * 校验目录中是否存在符合条件的文件
 */
export function validateDirectoryHasFiles(
  dirPath: string,
  options?: { minCount?: number; extensions?: string[]; minSizeBytes?: number },
): ValidationResult {
  const minCount = options?.minCount ?? 1;
  const exts = options?.extensions;
  const minSize = options?.minSizeBytes ?? 0;

  if (!existsSync(dirPath)) {
    return { passed: false, message: `目录不存在: ${dirPath}` };
  }
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const files = entries.filter((e) => {
    if (!e.isFile()) return false;
    if (exts && exts.length > 0) {
      const ext = extname(e.name).toLowerCase();
      if (!exts.includes(ext)) return false;
    }
    if (minSize > 0) {
      const stat = statSync(join(dirPath, e.name));
      if (stat.size < minSize) return false;
    }
    return true;
  });

  if (files.length < minCount) {
    return {
      passed: false,
      message: `目录中文件数不足: ${files.length}/${minCount}`,
      details: { found: files.length, required: minCount, dir: dirPath },
    };
  }
  return {
    passed: true,
    message: `目录校验通过: ${dirPath} (${files.length} 个文件)`,
    details: { count: files.length, dir: dirPath },
  };
}

/**
 * 校验新文件是否在指定时间窗口内出现（用于等待导出/下载）
 * 轮询检测，适用于不确定具体文件名的场景
 */
export async function waitForNewFile(
  dirPath: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    extensions?: string[];
    minSizeBytes?: number;
  },
): Promise<ValidationResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollInterval = options?.pollIntervalMs ?? 1000;
  const exts = options?.extensions;
  const minSize = options?.minSizeBytes ?? 1;

  const before = new Set<string>();
  if (existsSync(dirPath)) {
    for (const f of readdirSync(dirPath)) before.add(f);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));
    if (!existsSync(dirPath)) continue;

    const current = readdirSync(dirPath);
    for (const name of current) {
      if (before.has(name)) continue;
      const fullPath = join(dirPath, name);
      const ext = extname(name).toLowerCase();
      if (exts && exts.length > 0 && !exts.includes(ext)) continue;
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size >= minSize) {
          return {
            passed: true,
            message: `新文件已出现: ${name} (${formatBytes(stat.size)})`,
            details: { filePath: fullPath, size: stat.size },
          };
        }
      } catch { /* file might still be writing */ }
    }
  }

  return {
    passed: false,
    message: `等待超时(${timeoutMs}ms)：未检测到新文件`,
    details: { dir: dirPath, timeout: timeoutMs },
  };
}

/**
 * 校验窗口是否存在（通过 PowerShell Get-Process + MainWindowTitle）
 */
export async function validateWindowExists(
  titleKeyword: string,
): Promise<ValidationResult> {
  if (process.platform !== "win32") {
    return { passed: false, message: "仅支持 Windows" };
  }
  const script = `Get-Process | Where-Object {$_.MainWindowTitle -like '*${titleKeyword}*' -and $_.MainWindowHandle -ne 0} | Select-Object -First 1 -ExpandProperty MainWindowTitle`;
  const out = await runPowershell(script);
  if (out) {
    return {
      passed: true,
      message: `窗口存在: ${out}`,
      details: { title: out },
    };
  }
  return {
    passed: false,
    message: `未找到包含「${titleKeyword}」的窗口`,
  };
}

/**
 * 校验进程是否在运行
 */
export async function validateProcessRunning(
  processName: string,
): Promise<ValidationResult> {
  if (process.platform !== "win32") {
    return { passed: false, message: "仅支持 Windows" };
  }
  const script = `$p=Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){Write-Output ($p.Id.ToString()+','+$p.ProcessName)}`;
  const out = await runPowershell(script);
  if (out) {
    const [pid, name] = out.split(",");
    return {
      passed: true,
      message: `进程运行中: ${name} (PID: ${pid})`,
      details: { pid: parseInt(pid, 10), name },
    };
  }
  return {
    passed: false,
    message: `进程未运行: ${processName}`,
  };
}

/**
 * 校验剪贴板内容是否包含指定文本（用于校验复制操作）
 */
export async function validateClipboardContains(
  keyword: string,
): Promise<ValidationResult> {
  if (process.platform !== "win32") {
    return { passed: false, message: "仅支持 Windows" };
  }
  const script = `$c=Get-Clipboard; if($c -like '*${keyword}*'){Write-Output 'MATCH'} else {Write-Output 'NOMATCH'}`;
  const out = await runPowershell(script);
  return {
    passed: out === "MATCH",
    message: out === "MATCH"
      ? `剪贴板包含「${keyword}」`
      : `剪贴板不包含「${keyword}」`,
  };
}

export type ValidationType =
  | "file_exists"
  | "directory_has_files"
  | "window_exists"
  | "process_running"
  | "new_file_appeared"
  | "clipboard_contains";

export interface ValidationSpec {
  type: ValidationType;
  params: Record<string, unknown>;
}

/**
 * 通用校验调度：根据 spec.type 调用对应校验函数
 */
export async function runValidation(spec: ValidationSpec): Promise<ValidationResult> {
  const p = spec.params;
  switch (spec.type) {
    case "file_exists":
      return validateFileExists(String(p.path), {
        minSizeBytes: p.minSizeBytes as number | undefined,
        extensions: p.extensions as string[] | undefined,
      });
    case "directory_has_files":
      return validateDirectoryHasFiles(String(p.path), {
        minCount: p.minCount as number | undefined,
        extensions: p.extensions as string[] | undefined,
        minSizeBytes: p.minSizeBytes as number | undefined,
      });
    case "window_exists":
      return validateWindowExists(String(p.keyword));
    case "process_running":
      return validateProcessRunning(String(p.name));
    case "new_file_appeared":
      return waitForNewFile(String(p.path), {
        timeoutMs: p.timeoutMs as number | undefined,
        extensions: p.extensions as string[] | undefined,
        minSizeBytes: p.minSizeBytes as number | undefined,
      });
    case "clipboard_contains":
      return validateClipboardContains(String(p.keyword));
    default:
      return { passed: false, message: `未知校验类型: ${spec.type}` };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1073741824).toFixed(2)}GB`;
}
