/**
 * 成本追踪：API 调用记录与日报/周趋势/月预估，数据保存在 data/costs.jsonl
 * 所有 I/O 均 try-catch + 日志
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

/** 单次 API 调用记录 */
export interface APICallRecord {
  timestamp: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  metadata?: Record<string, unknown>;
}

/** 可选数据路径 */
export interface CostTrackerOptions {
  dataPath?: string;
}

/** 单日汇总 */
export interface DailyReport {
  date: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

/** 周趋势单日项 */
export interface DailyTrendItem {
  date: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
}

/** 月成本预估结果 */
export interface MonthlyCostEstimate {
  estimatedCost?: number;
  basedOnDays: number;
  totalCalls: number;
  message?: string;
}

const DEFAULT_DATA_PATH = join(process.cwd(), "data", "costs.jsonl");

function getDataPath(options?: CostTrackerOptions): string {
  return options?.dataPath ?? DEFAULT_DATA_PATH;
}

function toDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 追加一条 API 调用记录到 data/costs.jsonl
 */
export async function recordAPICall(
  record: APICallRecord,
  options?: CostTrackerOptions
): Promise<void> {
  const dataPath = getDataPath(options);
  const line = JSON.stringify({ ...record, timestamp: record.timestamp ?? Date.now() }) + "\n";

  try {
    await mkdir(dirname(dataPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[costTracker] recordAPICall mkdir 失败: %s", msg);
    throw err;
  }

  try {
    await appendFile(dataPath, line, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[costTracker] recordAPICall appendFile 失败: %s", msg);
    throw err;
  }
}

async function readAllRecords(options?: CostTrackerOptions): Promise<APICallRecord[]> {
  const dataPath = getDataPath(options);
  let content: string;
  try {
    content = await readFile(dataPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[costTracker] readAllRecords 失败: %s", msg);
    return [];
  }

  const records: APICallRecord[] = [];
  const lines = content.split("\n").filter((s) => s.trim().length > 0);
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as APICallRecord);
    } catch (_) {
      /* 单行解析失败跳过 */
    }
  }
  return records;
}

/**
 * 获取指定日期的日报；未传 date 则用当天
 */
export async function getDailyReport(
  date?: Date | string,
  options?: CostTrackerOptions
): Promise<DailyReport> {
  const targetDate = date == null
    ? toDateKey(Date.now())
    : typeof date === "string"
      ? date
      : toDateKey(date.getTime());

  const empty: DailyReport = {
    date: targetDate,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const records = await readAllRecords(options);
  const dayRecords = records.filter((r) => toDateKey(r.timestamp) === targetDate);

  if (dayRecords.length === 0) return empty;

  let cost: number | undefined;
  const hasCost = dayRecords.some((r) => typeof r.cost === "number");
  if (hasCost) {
    cost = dayRecords.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  }

  return {
    date: targetDate,
    callCount: dayRecords.length,
    inputTokens: dayRecords.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    outputTokens: dayRecords.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    ...(cost !== undefined && { cost }),
  };
}

/**
 * 最近 7 天按日汇总趋势
 */
export async function getWeeklyTrend(options?: CostTrackerOptions): Promise<DailyTrendItem[]> {
  const records = await readAllRecords(options);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = records.filter((r) => r.timestamp >= cutoff);

  const byDate = new Map<string, { callCount: number; inputTokens: number; outputTokens: number }>();

  for (const r of recent) {
    const key = toDateKey(r.timestamp);
    const cur = byDate.get(key) ?? { callCount: 0, inputTokens: 0, outputTokens: 0 };
    cur.callCount += 1;
    cur.inputTokens += r.inputTokens ?? 0;
    cur.outputTokens += r.outputTokens ?? 0;
    byDate.set(key, cur);
  }

  const sorted = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([date, v]) => ({
    date,
    callCount: v.callCount,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
  }));
}

/**
 * 基于近期用量估算当月成本（最近 7 天日均 * 30）
 */
export async function estimateMonthlyCost(options?: CostTrackerOptions): Promise<MonthlyCostEstimate> {
  const records = await readAllRecords(options);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = records.filter((r) => r.timestamp >= cutoff);

  const totalCalls = recent.length;
  const hasCost = recent.some((r) => typeof r.cost === "number");
  const totalCost = recent.reduce((s, r) => s + (r.cost ?? 0), 0);

  if (!hasCost || totalCost === 0) {
    return {
      basedOnDays: 7,
      totalCalls,
      message: "暂无成本数据或近期无带 cost 的记录，无法估算月成本",
    };
  }

  const dailyAvg = totalCost / 7;
  const estimatedCost = Math.round(dailyAvg * 30 * 100) / 100;

  return {
    estimatedCost,
    basedOnDays: 7,
    totalCalls,
  };
}
