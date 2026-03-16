/**
 * 自动化成功路径缓存 — 扫描成功一次的路径进行完善进化
 * 当 clickByName 某策略成功时记录，下次优先尝试该策略
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 缓存文件路径（data 目录，与 trajectories 同级） */
function getCachePath(): string {
  const root = process.cwd();
  return join(root, "data", "automation_success_cache.json");
}

/** 单条成功记录 */
export interface SuccessEntry {
  /** 策略类型 */
  strategy: "coordinate" | "tab_order" | "shortcut";
  /** 策略参数 */
  data: {
    /** 窗口相对坐标 0-1（coordinate） */
    xRel?: number;
    yRel?: number;
    /** 屏幕坐标中心（tab_order） */
    screenX?: number;
    screenY?: number;
    /** 快捷键（shortcut） */
    keys?: string;
  };
  /** 成功时间戳 */
  lastSuccess: number;
}

/** 完整缓存结构 */
export interface SuccessCache {
  [target: string]: SuccessEntry;
}

async function ensureDataDir(): Promise<void> {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/** 读取缓存 */
export async function readSuccessCache(): Promise<SuccessCache> {
  const path = getCachePath();
  try {
    const raw = await readFile(path, "utf8");
    const obj = JSON.parse(raw) as SuccessCache;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/** 写入缓存 */
async function writeSuccessCache(cache: SuccessCache): Promise<void> {
  await ensureDataDir();
  const path = getCachePath();
  await writeFile(path, JSON.stringify(cache, null, 2), "utf8");
}

/**
 * 根据 target（如「剪映|开始创作」）获取缓存的成功策略
 */
export async function getCachedSuccess(target: string): Promise<SuccessEntry | null> {
  const cache = await readSuccessCache();
  const entry = cache[target];
  if (!entry || !entry.strategy || !entry.data) return null;
  return entry;
}

/**
 * 记录成功：供 clickByName 成功时调用
 */
export async function recordSuccess(
  target: string,
  strategy: SuccessEntry["strategy"],
  data: SuccessEntry["data"]
): Promise<void> {
  const cache = await readSuccessCache();
  cache[target] = { strategy, data, lastSuccess: Date.now() };
  await writeSuccessCache(cache);
}
