/**
 * 习惯学习 — 层6：越用越懂你
 * 记录用户操作习惯：常用时间段、偏好路径、格式、操作序列
 * 分析并提供智能推荐
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "habits.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      target TEXT,
      details TEXT,
      hour_of_day INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      sample_count INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS frequent_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence TEXT NOT NULL UNIQUE,
      occurrence INTEGER NOT NULL DEFAULT 1,
      last_used_at INTEGER NOT NULL,
      avg_duration_ms REAL
    );

    CREATE INDEX IF NOT EXISTS idx_oplog_type ON operation_log(action_type);
    CREATE INDEX IF NOT EXISTS idx_oplog_hour ON operation_log(hour_of_day);
    CREATE INDEX IF NOT EXISTS idx_oplog_day ON operation_log(day_of_week);
  `);
  return db;
}

/** 记录一次用户操作 */
export function logOperation(options: {
  actionType: string;
  target?: string;
  details?: Record<string, unknown>;
}): void {
  const d = getDb();
  const now = new Date();
  d.prepare(`
    INSERT INTO operation_log (action_type, target, details, hour_of_day, day_of_week, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    options.actionType,
    options.target ?? null,
    options.details ? JSON.stringify(options.details) : null,
    now.getHours(),
    now.getDay(),
    Date.now(),
  );
}

/** 更新偏好（滑动平均，置信度随样本量递增） */
export function updatePreference(key: string, value: string): void {
  const d = getDb();
  const existing = d.prepare("SELECT * FROM preferences WHERE key = ?").get(key) as Record<string, unknown> | undefined;
  if (existing) {
    const count = (existing.sample_count as number) + 1;
    const confidence = Math.min(0.99, 0.5 + count * 0.05);
    if (existing.value === value) {
      d.prepare("UPDATE preferences SET sample_count = ?, confidence = ?, updated_at = ? WHERE key = ?")
        .run(count, confidence, Date.now(), key);
    } else {
      d.prepare("UPDATE preferences SET value = ?, sample_count = ?, confidence = ?, updated_at = ? WHERE key = ?")
        .run(value, count, Math.max(0.3, confidence - 0.1), Date.now(), key);
    }
  } else {
    d.prepare("INSERT INTO preferences (key, value, confidence, sample_count, updated_at) VALUES (?, ?, 0.5, 1, ?)")
      .run(key, value, Date.now());
  }
}

/** 获取偏好 */
export function getPreference(key: string): { value: string; confidence: number } | null {
  const d = getDb();
  const row = d.prepare("SELECT value, confidence FROM preferences WHERE key = ?").get(key) as { value: string; confidence: number } | undefined;
  return row ?? null;
}

/** 获取所有偏好 */
export function getAllPreferences(): Array<{ key: string; value: string; confidence: number }> {
  const d = getDb();
  return d.prepare("SELECT key, value, confidence FROM preferences ORDER BY confidence DESC").all() as Array<{ key: string; value: string; confidence: number }>;
}

/** 记录操作序列（用于发现常用操作模式） */
export function recordSequence(steps: string[], durationMs?: number): void {
  const d = getDb();
  const seq = steps.join(" → ");
  const existing = d.prepare("SELECT * FROM frequent_sequences WHERE sequence = ?").get(seq) as Record<string, unknown> | undefined;
  if (existing) {
    const occ = (existing.occurrence as number) + 1;
    const oldAvg = (existing.avg_duration_ms as number) ?? durationMs ?? 0;
    const newAvg = durationMs != null ? (oldAvg * (occ - 1) + durationMs) / occ : oldAvg;
    d.prepare("UPDATE frequent_sequences SET occurrence = ?, last_used_at = ?, avg_duration_ms = ? WHERE id = ?")
      .run(occ, Date.now(), newAvg, existing.id);
  } else {
    d.prepare("INSERT INTO frequent_sequences (sequence, occurrence, last_used_at, avg_duration_ms) VALUES (?, 1, ?, ?)")
      .run(seq, Date.now(), durationMs ?? null);
  }
}

/** 获取最常用操作序列 */
export function getFrequentSequences(limit = 10): Array<{
  sequence: string;
  occurrence: number;
  avgDurationMs: number | null;
}> {
  const d = getDb();
  const rows = d.prepare(
    "SELECT sequence, occurrence, avg_duration_ms FROM frequent_sequences ORDER BY occurrence DESC LIMIT ?",
  ).all(limit) as Array<{ sequence: string; occurrence: number; avg_duration_ms: number | null }>;
  return rows.map((r) => ({
    sequence: r.sequence,
    occurrence: r.occurrence,
    avgDurationMs: r.avg_duration_ms,
  }));
}

/** 分析活跃时段：哪些小时操作最频繁 */
export function getActiveHours(): Array<{ hour: number; count: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT hour_of_day as hour, COUNT(*) as count
    FROM operation_log
    GROUP BY hour_of_day
    ORDER BY count DESC
  `).all() as Array<{ hour: number; count: number }>;
}

/** 分析活跃日：哪些天操作最频繁 */
export function getActiveDays(): Array<{ day: number; count: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT day_of_week as day, COUNT(*) as count
    FROM operation_log
    GROUP BY day_of_week
    ORDER BY count DESC
  `).all() as Array<{ day: number; count: number }>;
}

/** 最常操作的目标应用/对象 */
export function getTopTargets(limit = 10): Array<{ target: string; count: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT target, COUNT(*) as count
    FROM operation_log
    WHERE target IS NOT NULL
    GROUP BY target
    ORDER BY count DESC
    LIMIT ?
  `).all(limit) as Array<{ target: string; count: number }>;
}

/** 智能推荐：基于当前时间和历史习惯，推荐可能的操作 */
export function suggestActions(): Array<{ action: string; reason: string; confidence: number }> {
  const suggestions: Array<{ action: string; reason: string; confidence: number }> = [];
  const d = getDb();
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  const hourActions = d.prepare(`
    SELECT action_type, target, COUNT(*) as cnt
    FROM operation_log
    WHERE hour_of_day = ?
    GROUP BY action_type, target
    ORDER BY cnt DESC
    LIMIT 3
  `).all(hour) as Array<{ action_type: string; target: string | null; cnt: number }>;

  for (const a of hourActions) {
    if (a.cnt >= 3) {
      suggestions.push({
        action: a.target ? `${a.action_type}: ${a.target}` : a.action_type,
        reason: `你通常在 ${hour}:00 左右做这个（已执行 ${a.cnt} 次）`,
        confidence: Math.min(0.95, 0.5 + a.cnt * 0.05),
      });
    }
  }

  const dayActions = d.prepare(`
    SELECT action_type, target, COUNT(*) as cnt
    FROM operation_log
    WHERE day_of_week = ?
    GROUP BY action_type, target
    ORDER BY cnt DESC
    LIMIT 3
  `).all(day) as Array<{ action_type: string; target: string | null; cnt: number }>;

  const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  for (const a of dayActions) {
    if (a.cnt >= 3) {
      const exists = suggestions.some((s) => s.action.includes(a.action_type));
      if (!exists) {
        suggestions.push({
          action: a.target ? `${a.action_type}: ${a.target}` : a.action_type,
          reason: `你通常在${dayNames[day]}做这个（已执行 ${a.cnt} 次）`,
          confidence: Math.min(0.9, 0.4 + a.cnt * 0.04),
        });
      }
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

export function closeHabitDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
