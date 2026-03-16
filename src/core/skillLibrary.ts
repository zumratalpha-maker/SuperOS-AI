/**
 * 技能库 — SuperOS 的"永久记忆"
 *
 * 存储从网上自学到的技巧、用户教的方法、系统自己发现的最优路径。
 * 每个技能是结构化的可执行知识，不是自由文本。
 *
 * 技能类型：
 *   url_transform  — URL 替换规则（如 youtube → youtube9x）
 *   shell_command  — 可执行的 Shell/PowerShell 命令模板
 *   multi_step     — 多步操作序列（A11y / Puppeteer）
 *   api_call       — 直接调 API 的方法
 *   tool_usage     — 使用某个工具的方法（如 yt-dlp、aria2）
 *   knowledge      — 纯知识型（不直接执行，但可被 LLM 参考）
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "skill_library.db");

export type SkillType = "url_transform" | "shell_command" | "multi_step" | "api_call" | "tool_usage" | "knowledge";

export interface Skill {
  id: number;
  name: string;
  type: SkillType;
  taskPattern: string;
  tags: string[];
  description: string;
  steps: SkillStep[];
  source: string;
  sourceUrl?: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  deprecated: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SkillStep {
  action: string;
  params: Record<string, unknown>;
  description?: string;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      task_pattern TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'unknown',
      source_url TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      deprecated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
    CREATE INDEX IF NOT EXISTS idx_skills_pattern ON skills(task_pattern);
    CREATE INDEX IF NOT EXISTS idx_skills_deprecated ON skills(deprecated);
    CREATE INDEX IF NOT EXISTS idx_skills_confidence ON skills(confidence);
  `);
  return db;
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: row.id as number,
    name: row.name as string,
    type: row.type as SkillType,
    taskPattern: row.task_pattern as string,
    tags: JSON.parse((row.tags as string) || "[]"),
    description: row.description as string,
    steps: JSON.parse((row.steps as string) || "[]"),
    source: row.source as string,
    sourceUrl: row.source_url as string | undefined,
    confidence: row.confidence as number,
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    lastUsedAt: row.last_used_at as number | null,
    deprecated: (row.deprecated as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

// ─── CRUD ───

export function addSkill(skill: Omit<Skill, "id" | "successCount" | "failureCount" | "lastUsedAt" | "deprecated" | "createdAt" | "updatedAt">): Skill {
  const now = Date.now();
  const result = getDb().prepare(`
    INSERT INTO skills (name, type, task_pattern, tags, description, steps, source, source_url, confidence, success_count, failure_count, last_used_at, deprecated, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?)
  `).run(
    skill.name,
    skill.type,
    skill.taskPattern,
    JSON.stringify(skill.tags),
    skill.description,
    JSON.stringify(skill.steps),
    skill.source,
    skill.sourceUrl ?? null,
    skill.confidence,
    now, now
  );
  return getSkillById(result.lastInsertRowid as number)!;
}

export function getSkillById(id: number): Skill | null {
  const row = getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : null;
}

export function updateSkill(id: number, updates: Partial<Pick<Skill, "name" | "description" | "steps" | "confidence" | "deprecated" | "tags">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.name !== undefined) { sets.push("name = ?"); vals.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); vals.push(updates.description); }
  if (updates.steps !== undefined) { sets.push("steps = ?"); vals.push(JSON.stringify(updates.steps)); }
  if (updates.confidence !== undefined) { sets.push("confidence = ?"); vals.push(updates.confidence); }
  if (updates.deprecated !== undefined) { sets.push("deprecated = ?"); vals.push(updates.deprecated ? 1 : 0); }
  if (updates.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(updates.tags)); }

  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);

  getDb().prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteSkill(id: number): void {
  getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
}

// ─── 查询 ───

/**
 * 根据任务描述模糊匹配技能。
 * 按 confidence 和 success_rate 排序，排除已废弃的。
 */
export function findSkills(taskDescription: string, limit = 5): Skill[] {
  const keywords = taskDescription
    .replace(/[，。！？、\s]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1);

  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => "(task_pattern LIKE ? OR tags LIKE ? OR name LIKE ? OR description LIKE ?)");
  const params: string[] = [];
  for (const kw of keywords) {
    const like = `%${kw}%`;
    params.push(like, like, like, like);
  }

  const sql = `
    SELECT *, 
      CASE WHEN (success_count + failure_count) > 0 
        THEN CAST(success_count AS REAL) / (success_count + failure_count) 
        ELSE confidence 
      END AS effective_score
    FROM skills
    WHERE deprecated = 0 AND (${conditions.join(" OR ")})
    ORDER BY effective_score DESC, confidence DESC, updated_at DESC
    LIMIT ?
  `;
  params.push(String(limit));

  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

/**
 * 精确匹配：按技能类型 + 关键词查找
 */
export function findSkillsByType(type: SkillType, keyword?: string, limit = 10): Skill[] {
  let sql = "SELECT * FROM skills WHERE deprecated = 0 AND type = ?";
  const params: unknown[] = [type];

  if (keyword) {
    sql += " AND (task_pattern LIKE ? OR name LIKE ?)";
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  sql += " ORDER BY confidence DESC, success_count DESC LIMIT ?";
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

// ─── 执行反馈 ───

export function recordSuccess(id: number): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE skills SET success_count = success_count + 1, last_used_at = ?, updated_at = ?,
      confidence = MIN(1.0, confidence + 0.05)
    WHERE id = ?
  `).run(now, now, id);
}

export function recordFailure(id: number): void {
  const now = Date.now();
  const skill = getSkillById(id);
  if (!skill) return;

  const newFailure = skill.failureCount + 1;
  const shouldDeprecate = newFailure >= 3 && skill.successCount === 0;

  getDb().prepare(`
    UPDATE skills SET failure_count = failure_count + 1, last_used_at = ?, updated_at = ?,
      confidence = MAX(0.0, confidence - 0.15),
      deprecated = ?
    WHERE id = ?
  `).run(now, now, shouldDeprecate ? 1 : 0, id);

  if (shouldDeprecate) {
    console.log(`[skillLibrary] 技能「${skill.name}」连续失败 ${newFailure} 次，已自动废弃。`);
  }
}

// ─── 维护 ───

/**
 * 清理过期/低质量技能
 */
export function cleanupSkills(maxAgeDays = 90): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(`
    DELETE FROM skills 
    WHERE deprecated = 1 OR (
      confidence < 0.2 AND success_count = 0 AND created_at < ?
    )
  `).run(cutoff);
  return result.changes;
}

/**
 * 统计技能库概况
 */
export function getStats(): {
  total: number;
  active: number;
  deprecated: number;
  byType: Record<string, number>;
  avgConfidence: number;
  totalSuccess: number;
  totalFailure: number;
} {
  const total = (getDb().prepare("SELECT COUNT(*) as c FROM skills").get() as { c: number }).c;
  const active = (getDb().prepare("SELECT COUNT(*) as c FROM skills WHERE deprecated = 0").get() as { c: number }).c;
  const deprecated = total - active;

  const byTypeRows = getDb().prepare("SELECT type, COUNT(*) as c FROM skills WHERE deprecated = 0 GROUP BY type").all() as { type: string; c: number }[];
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.type] = r.c;

  const agg = getDb().prepare("SELECT AVG(confidence) as avg_conf, SUM(success_count) as total_s, SUM(failure_count) as total_f FROM skills WHERE deprecated = 0").get() as { avg_conf: number | null; total_s: number | null; total_f: number | null };

  return {
    total,
    active,
    deprecated,
    byType,
    avgConfidence: agg.avg_conf ?? 0,
    totalSuccess: agg.total_s ?? 0,
    totalFailure: agg.total_f ?? 0,
  };
}

/**
 * 列出所有技能（分页）
 */
export function listSkills(page = 1, pageSize = 20): { skills: Skill[]; total: number } {
  const total = (getDb().prepare("SELECT COUNT(*) as c FROM skills WHERE deprecated = 0").get() as { c: number }).c;
  const offset = (page - 1) * pageSize;
  const rows = getDb().prepare(`
    SELECT * FROM skills WHERE deprecated = 0
    ORDER BY confidence DESC, success_count DESC, updated_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset) as Record<string, unknown>[];
  return { skills: rows.map(rowToSkill), total };
}
