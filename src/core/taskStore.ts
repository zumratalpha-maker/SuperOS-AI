/**
 * 任务持久化存储 — SQLite 实现
 * 支持任务创建、更新状态、断点续跑、历史查询
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "tasks.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      payload TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      current_step INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      depends_on TEXT,
      scheduled_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_at);

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step_index INTEGER,
      engine TEXT,
      action TEXT,
      success INTEGER,
      duration_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
  `);
  return db;
}

export type TaskStatus = "pending" | "running" | "paused" | "waiting_user" | "completed" | "failed" | "cancelled";
export type TaskPriority = "high" | "medium" | "low";

export interface TaskRecord {
  id: string;
  kind: string;
  status: TaskStatus;
  priority: TaskPriority;
  payload: Record<string, unknown>;
  progress: number;
  totalSteps: number;
  currentStep: number;
  parentId: string | null;
  dependsOn: string[];
  scheduledAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    kind: row.kind as string,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    payload: JSON.parse((row.payload as string) || "{}"),
    progress: row.progress as number,
    totalSteps: row.total_steps as number,
    currentStep: row.current_step as number,
    parentId: (row.parent_id as string) || null,
    dependsOn: JSON.parse((row.depends_on as string) || "[]"),
    scheduledAt: (row.scheduled_at as number) || null,
    startedAt: (row.started_at as number) || null,
    completedAt: (row.completed_at as number) || null,
    error: (row.error as string) || null,
    result: row.result ? JSON.parse(row.result as string) : null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function createPersistentTask(options: {
  kind: string;
  payload: Record<string, unknown>;
  priority?: TaskPriority;
  totalSteps?: number;
  parentId?: string;
  dependsOn?: string[];
  scheduledAt?: number;
}): TaskRecord {
  const d = getDb();
  const id = generateId();
  const now = Date.now();
  const stmt = d.prepare(`
    INSERT INTO tasks (id, kind, status, priority, payload, total_steps, parent_id, depends_on, scheduled_at, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    options.kind,
    options.priority ?? "medium",
    JSON.stringify(options.payload),
    options.totalSteps ?? 0,
    options.parentId ?? null,
    JSON.stringify(options.dependsOn ?? []),
    options.scheduledAt ?? null,
    now,
    now,
  );
  return getTaskById(id)!;
}

export function getTaskById(id: string): TaskRecord | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  extra?: { error?: string; result?: Record<string, unknown>; currentStep?: number; progress?: number },
): void {
  const d = getDb();
  const now = Date.now();
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [status, now];

  if (status === "running" && !extra?.currentStep) {
    sets.push("started_at = COALESCE(started_at, ?)");
    values.push(now);
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    sets.push("completed_at = ?");
    values.push(now);
  }
  if (extra?.error !== undefined) {
    sets.push("error = ?");
    values.push(extra.error);
  }
  if (extra?.result !== undefined) {
    sets.push("result = ?");
    values.push(JSON.stringify(extra.result));
  }
  if (extra?.currentStep !== undefined) {
    sets.push("current_step = ?");
    values.push(extra.currentStep);
  }
  if (extra?.progress !== undefined) {
    sets.push("progress = ?");
    values.push(extra.progress);
  }

  values.push(id);
  d.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** 获取下一个待执行任务（按优先级、创建时间排序） */
export function getNextPendingTask(): TaskRecord | null {
  const d = getDb();
  const priorityOrder = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END";
  const row = d.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
    ORDER BY ${priorityOrder}, created_at ASC
    LIMIT 1
  `).get(Date.now()) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** 获取可恢复的暂停任务 */
export function getResumableTasks(): TaskRecord[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('paused', 'running')
    ORDER BY updated_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** 获取等待用户操作的任务 */
export function getWaitingUserTasks(): TaskRecord[] {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM tasks WHERE status = 'waiting_user' ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** 查询依赖是否全部完成 */
export function areDependenciesMet(taskId: string): boolean {
  const task = getTaskById(taskId);
  if (!task || task.dependsOn.length === 0) return true;
  const d = getDb();
  const placeholders = task.dependsOn.map(() => "?").join(",");
  const count = d.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE id IN (${placeholders}) AND status = 'completed'
  `).get(...task.dependsOn) as { cnt: number };
  return count.cnt === task.dependsOn.length;
}

/** 获取子任务列表 */
export function getSubTasks(parentId: string): TaskRecord[] {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all(parentId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** 记录任务步骤执行日志 */
export function logTaskStep(options: {
  taskId: string;
  stepIndex: number;
  engine?: string;
  action?: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO task_logs (task_id, step_index, engine, action, success, duration_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.stepIndex,
    options.engine ?? null,
    options.action ?? null,
    options.success ? 1 : 0,
    options.durationMs ?? null,
    options.error ?? null,
    Date.now(),
  );
}

/** 查询任务执行日志 */
export function getTaskLogs(taskId: string): Array<{
  stepIndex: number;
  engine: string | null;
  action: string | null;
  success: boolean;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
}> {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY id ASC").all(taskId) as Record<string, unknown>[];
  return rows.map((r) => ({
    stepIndex: r.step_index as number,
    engine: (r.engine as string) || null,
    action: (r.action as string) || null,
    success: (r.success as number) === 1,
    durationMs: (r.duration_ms as number) || null,
    error: (r.error as string) || null,
    createdAt: r.created_at as number,
  }));
}

/** 获取任务统计 */
export function getTaskStats(): {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
} {
  const d = getDb();
  const row = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM tasks
  `).get() as Record<string, number>;
  return {
    total: row.total ?? 0,
    pending: row.pending ?? 0,
    running: row.running ?? 0,
    completed: row.completed ?? 0,
    failed: row.failed ?? 0,
  };
}

export function getRecentTasks(limit = 20): TaskRecord[] {
  const d = getDb();
  return d.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as TaskRecord[];
}

/** 清理已完成/已取消的旧任务 */
export function cleanOldTasks(olderThanDays = 30): number {
  const d = getDb();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = d.prepare("DELETE FROM tasks WHERE status IN ('completed', 'cancelled') AND updated_at < ?").run(cutoff);
  return result.changes;
}

export function closeTaskDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
