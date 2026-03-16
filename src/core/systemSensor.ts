/**
 * 系统感知模块 — 层1：硬件/系统状态实时感知
 * 执行任务前的前置校验：磁盘空间、网络连通性、内存占用、进程列表
 */

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

export interface DiskInfo {
  drive: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

export async function getDiskSpace(driveLetter = "C"): Promise<DiskInfo | null> {
  if (process.platform !== "win32") return null;
  const letter = driveLetter.replace(":", "").toUpperCase();
  const script = `$d = Get-PSDrive ${letter} -ErrorAction SilentlyContinue; if($d){$f=[math]::Round($d.Free/1GB,2);$u=[math]::Round($d.Used/1GB,2);$t=$f+$u;Write-Output "$f,$u,$t"}`;
  const out = await runPowershell(script);
  const parts = out.split(",").map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  const [freeGB, usedGB, totalGB] = parts;
  return {
    drive: `${letter}:`,
    totalGB,
    freeGB,
    usedPercent: totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0,
  };
}

export interface MemoryInfo {
  totalGB: number;
  availableGB: number;
  usedPercent: number;
}

export async function getMemoryUsage(): Promise<MemoryInfo | null> {
  if (process.platform !== "win32") return null;
  const script = `$os=Get-CimInstance Win32_OperatingSystem;$t=[math]::Round($os.TotalVisibleMemorySize/1MB,2);$a=[math]::Round($os.FreePhysicalMemory/1MB,2);Write-Output "$t,$a"`;
  const out = await runPowershell(script);
  const parts = out.split(",").map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return null;
  const [totalGB, availableGB] = parts;
  return {
    totalGB,
    availableGB,
    usedPercent: totalGB > 0 ? Math.round(((totalGB - availableGB) / totalGB) * 100) : 0,
  };
}

export interface NetworkStatus {
  connected: boolean;
  latencyMs: number | null;
}

export async function getNetworkStatus(host = "www.baidu.com"): Promise<NetworkStatus> {
  const script = `try{$p=Test-Connection -ComputerName '${host}' -Count 1 -ErrorAction Stop;Write-Output ("ok,"+$p.ResponseTime)}catch{Write-Output "fail"}`;
  const out = await runPowershell(script, 8000);
  if (out.startsWith("ok,")) {
    const ms = parseInt(out.split(",")[1], 10);
    return { connected: true, latencyMs: isNaN(ms) ? null : ms };
  }
  return { connected: false, latencyMs: null };
}

export async function checkAdminPrivilege(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | Write-Output`;
  const out = await runPowershell(script);
  return out.toLowerCase() === "true";
}

export interface ProcessInfo {
  pid: number;
  name: string;
  memoryMB: number;
}

export async function getRunningProcesses(filter?: string): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") return [];
  const filterClause = filter ? `| Where-Object {$_.Name -like '*${filter}*'}` : "";
  const script = `Get-Process ${filterClause} | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 | ForEach-Object { $_.Id.ToString()+","+$_.Name+","+ [math]::Round($_.WorkingSet64/1MB,1).ToString() } | Write-Output`;
  const out = await runPowershell(script, 8000);
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pidStr, name, memStr] = line.split(",");
    return { pid: parseInt(pidStr, 10), name: name ?? "", memoryMB: parseFloat(memStr) || 0 };
  }).filter((p) => p.pid > 0);
}

export interface PreflightResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * 任务执行前置校验：综合检查磁盘/内存/网络
 * @param requiredDiskGB 需要的最小磁盘空间（GB），默认 2
 * @param requiredDrive 目标盘符，默认 C
 * @param needsNetwork 是否需要网络连接，默认 true
 */
export async function preflightCheck(options?: {
  requiredDiskGB?: number;
  requiredDrive?: string;
  needsNetwork?: boolean;
  targetUrl?: string;
}): Promise<PreflightResult> {
  const requiredDiskGB = options?.requiredDiskGB ?? 2;
  const requiredDrive = options?.requiredDrive ?? "C";
  const needsNetwork = options?.needsNetwork ?? true;
  const warnings: string[] = [];
  const errors: string[] = [];

  const [disk, memory, network] = await Promise.all([
    getDiskSpace(requiredDrive),
    getMemoryUsage(),
    needsNetwork ? getNetworkStatus(options?.targetUrl ?? "www.baidu.com") : Promise.resolve({ connected: true, latencyMs: null }),
  ]);

  if (disk) {
    if (disk.freeGB < requiredDiskGB) {
      errors.push(`${disk.drive} 剩余空间不足：${disk.freeGB}GB < 需要${requiredDiskGB}GB`);
    } else if (disk.freeGB < requiredDiskGB * 2) {
      warnings.push(`${disk.drive} 空间偏低：剩余${disk.freeGB}GB`);
    }
  }

  if (memory) {
    if (memory.usedPercent > 95) {
      errors.push(`内存严重不足：已使用${memory.usedPercent}%`);
    } else if (memory.usedPercent > 85) {
      warnings.push(`内存偏高：已使用${memory.usedPercent}%`);
    }
  }

  if (needsNetwork && !network.connected) {
    errors.push("网络不可用，请检查网络连接");
  } else if (needsNetwork && network.latencyMs != null && network.latencyMs > 3000) {
    warnings.push(`网络延迟较高：${network.latencyMs}ms`);
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}
