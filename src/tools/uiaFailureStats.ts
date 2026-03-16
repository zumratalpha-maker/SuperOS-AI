/**
 * 按应用统计 UIA 失败率 — 用于动态决策「OCR 优先」
 * 蓝图 Phase 2.1：失败率 ≥ 阈值 → 优先走 OCR，减少无效 UIA 重试
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const STATS_PATH = join(process.cwd(), "data", "uia_failure_stats.json");
const FAILURE_RATE_THRESHOLD = 0.5; // 50% 失败率以上则 OCR 优先

export interface AppStats {
  success: number;
  failure: number;
}

async function ensureDataDir(): Promise<void> {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function readStats(): Promise<Record<string, AppStats>> {
  try {
    const raw = await readFile(STATS_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, AppStats>;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

async function writeStats(stats: Record<string, AppStats>): Promise<void> {
  await ensureDataDir();
  await writeFile(STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
}

/** 规范化应用名（用于统计键） */
function normalizeAppName(nameOrTarget: string): string {
  const part = nameOrTarget.includes("|") ? nameOrTarget.split("|")[0]?.trim() ?? nameOrTarget : nameOrTarget;
  if (/微信|WeChat/i.test(part)) return "微信";
  if (/剪映|JianyingPro|CapCut/i.test(part)) return "剪映";
  return part || "unknown";
}

/** 获取应用 UIA 失败率（0-1），样本不足时返回 0（不触发 OCR 优先） */
export async function getUiaFailureRate(nameOrTarget: string): Promise<number> {
  const app = normalizeAppName(nameOrTarget);
  const stats = await readStats();
  const s = stats[app];
  if (!s || (s.success + s.failure) < 3) return 0;
  return s.failure / (s.success + s.failure);
}

/** 是否应 OCR 优先（失败率 ≥ 阈值） */
export async function shouldPreferOcr(nameOrTarget: string): Promise<boolean> {
  const rate = await getUiaFailureRate(nameOrTarget);
  return rate >= FAILURE_RATE_THRESHOLD;
}

/** 记录 UIA 执行结果 */
export async function recordUiaResult(nameOrTarget: string, success: boolean): Promise<void> {
  const app = normalizeAppName(nameOrTarget);
  const stats = await readStats();
  const s = stats[app] ?? { success: 0, failure: 0 };
  if (success) s.success += 1;
  else s.failure += 1;
  stats[app] = s;
  await writeStats(stats);
}
