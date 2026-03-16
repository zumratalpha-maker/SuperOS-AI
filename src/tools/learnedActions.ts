/**
 * 自主学习记录 — 用户演示操作后记录的 click 坐标，优先于 automationSuccessCache
 * 支持多样本，查询时取中位数以适配不同布局/分辨率
 */

import { readFile, appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const LEARNED_PATH = join(process.cwd(), "data", "learned_actions.jsonl");

/** 记忆来源：user=用户教学，ocr=OCR首探，uia=UIA发现 */
export type LearnedSource = "user" | "ocr" | "uia";

export interface LearnedRecord {
  target: string;
  context?: string;
  xRel: number;
  yRel: number;
  ts: number;
  windowTitle?: string;
  /** 记忆来源，用于多维度优先级与失效策略 */
  source?: LearnedSource;
}

async function ensureDataDir(): Promise<void> {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * 追加一条学习记录
 */
export async function appendLearnedAction(record: LearnedRecord): Promise<void> {
  await ensureDataDir();
  const line = JSON.stringify(record) + "\n";
  await appendFile(LEARNED_PATH, line, "utf8");
}

/**
 * 删除与 target 匹配的记忆记录（失效时调用，下次自动走 OCR 重新定位）
 */
export async function deleteLearnedAction(target: string): Promise<void> {
  try {
    const raw = await readFile(LEARNED_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const keyword = target.includes("|") ? target.split("|")[1]?.trim() || target : target;
    const keyLower = keyword.toLowerCase();
    const kept: string[] = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as LearnedRecord;
        if (!r.target) {
          kept.push(line);
          continue;
        }
        const t = String(r.target);
        const fullMatch = t === target || t.toLowerCase() === target.toLowerCase();
        const elemMatch = t.includes("|") && t.split("|")[1]?.toLowerCase().includes(keyLower);
        const directMatch = t.toLowerCase().includes(keyLower);
        if (fullMatch || elemMatch || directMatch) continue;
        kept.push(line);
      } catch {
        kept.push(line);
      }
    }
    await writeFile(LEARNED_PATH, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  } catch {
    /* 文件不存在或写入失败，忽略 */
  }
}

/**
 * 查询 target 的学习坐标：匹配 target 或 element 部分，多样本取中位数
 */
export async function getLearnedClick(target: string): Promise<{ xRel: number; yRel: number } | null> {
  try {
    const raw = await readFile(LEARNED_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const keyword = target.includes("|") ? target.split("|")[1]?.trim() || target : target;
    const keyLower = keyword.toLowerCase();
    const matched: LearnedRecord[] = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as LearnedRecord;
        if (!r.target || r.xRel == null || r.yRel == null) continue;
        const t = String(r.target);
        const fullMatch = t === target || t.toLowerCase() === target.toLowerCase();
        const elemMatch = t.includes("|") && t.split("|")[1]?.toLowerCase().includes(keyLower);
        const directMatch = t.toLowerCase().includes(keyLower);
        if (fullMatch || elemMatch || directMatch) {
          matched.push(r);
        }
      } catch {
        /* skip invalid lines */
      }
    }
    if (matched.length === 0) return null;
    const xs = matched.map((m) => m.xRel).sort((a, b) => a - b);
    const ys = matched.map((m) => m.yRel).sort((a, b) => a - b);
    const mid = Math.floor(matched.length / 2);
    const xRel = matched.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
    const yRel = matched.length % 2 ? ys[mid]! : (ys[mid - 1]! + ys[mid]!) / 2;
    return { xRel, yRel };
  } catch {
    return null;
  }
}
