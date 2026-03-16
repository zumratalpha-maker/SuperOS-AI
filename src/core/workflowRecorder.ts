/**
 * 工作流录制与回放
 *
 * 录制模式：用户说「开始录制」→ 系统捕获后续所有操作步骤 → 「结束录制」保存为可复用序列
 * 回放模式：用户说「回放 XXX」→ 从存储中取出该工作流 → 按序执行
 * 存储：SQLite + memoryGraph 记录
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { recordTrajectory, type TrajectoryRecord } from "../tools/trajectoryRecorder.js";

const DB_PATH = join(process.cwd(), "data", "workflows.db");

function ensureDir(): void {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let db: Database.Database | null = null;
function getDb(): Database.Database {
  if (!db) {
    ensureDir();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        steps TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        avg_duration_ms INTEGER DEFAULT 0,
        tags TEXT
      )
    `);
  }
  return db;
}

// ─── 类型定义 ───

export interface WorkflowStep {
  type: "open_app" | "click" | "type" | "key" | "scroll" | "wait" | "custom";
  target?: string;
  value?: string;
  durationMs?: number;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
  successCount: number;
  avgDurationMs: number;
  tags?: string[];
}

// ─── 录制状态 ───

let recording = false;
let recordingName = "";
let recordingSteps: WorkflowStep[] = [];
let recordingStartTime = 0;

export function isRecording(): boolean {
  return recording;
}

export function startRecording(name: string): void {
  recording = true;
  recordingName = name || `工作流_${Date.now()}`;
  recordingSteps = [];
  recordingStartTime = Date.now();
  console.log(`[workflow] 录制开始：${recordingName}`);
}

export function captureStep(step: WorkflowStep): void {
  if (!recording) return;
  recordingSteps.push({ ...step, durationMs: Date.now() - recordingStartTime });
  console.log(`[workflow] 录制步骤 #${recordingSteps.length}: ${step.type} ${step.target ?? step.value ?? ""}`);
}

export function stopRecording(description?: string): Workflow | null {
  if (!recording || recordingSteps.length === 0) {
    recording = false;
    return null;
  }

  const workflow = saveWorkflow({
    name: recordingName,
    description,
    steps: recordingSteps,
  });

  recording = false;
  recordingSteps = [];
  recordingName = "";
  recordingStartTime = 0;

  console.log(`[workflow] 录制完成：${workflow.name}（${workflow.steps.length} 步）`);

  recordTrajectory({
    timestamp: Date.now(),
    action: "workflow_recorded",
    target: workflow.name,
    sessionId: workflow.id,
  }).catch(() => {});

  return workflow;
}

// ─── CRUD ───

export function saveWorkflow(opts: {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  tags?: string[];
}): Workflow {
  const d = getDb();
  const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();

  d.prepare(`
    INSERT INTO workflows (id, name, description, steps, created_at, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.description ?? "", JSON.stringify(opts.steps), now, JSON.stringify(opts.tags ?? []));

  return {
    id,
    name: opts.name,
    description: opts.description,
    steps: opts.steps,
    createdAt: now,
    useCount: 0,
    successCount: 0,
    avgDurationMs: 0,
    tags: opts.tags,
  };
}

export function getWorkflow(id: string): Workflow | null {
  const row = getDb().prepare("SELECT * FROM workflows WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function findWorkflowByName(name: string): Workflow | null {
  const row = getDb()
    .prepare("SELECT * FROM workflows WHERE name LIKE ? ORDER BY use_count DESC LIMIT 1")
    .get(`%${name}%`) as Record<string, unknown> | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function listWorkflows(limit = 20): Workflow[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflows ORDER BY last_used_at DESC, use_count DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToWorkflow);
}

export function deleteWorkflow(id: string): void {
  getDb().prepare("DELETE FROM workflows WHERE id = ?").run(id);
}

export function recordWorkflowUsage(id: string, success: boolean, durationMs: number): void {
  const d = getDb();
  const current = d.prepare("SELECT use_count, success_count, avg_duration_ms FROM workflows WHERE id = ?").get(id) as
    | { use_count: number; success_count: number; avg_duration_ms: number }
    | undefined;

  if (!current) return;

  const newCount = current.use_count + 1;
  const newSuccess = success ? current.success_count + 1 : current.success_count;
  const newAvg = Math.round((current.avg_duration_ms * current.use_count + durationMs) / newCount);

  d.prepare(`
    UPDATE workflows SET use_count = ?, success_count = ?, avg_duration_ms = ?, last_used_at = ?
    WHERE id = ?
  `).run(newCount, newSuccess, newAvg, Date.now(), id);
}

// ─── 回放 ───

export type StepExecutor = (step: WorkflowStep, index: number) => Promise<boolean>;

/**
 * 回放工作流：按序执行每一步
 */
export async function replayWorkflow(
  workflow: Workflow,
  executor: StepExecutor,
): Promise<{ success: boolean; stepsCompleted: number; error?: string }> {
  const startTime = Date.now();
  let completed = 0;

  console.log(`[workflow] 回放开始：${workflow.name}（${workflow.steps.length} 步）`);

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    try {
      const ok = await executor(step, i);
      if (!ok) {
        const dur = Date.now() - startTime;
        recordWorkflowUsage(workflow.id, false, dur);
        return { success: false, stepsCompleted: completed, error: `步骤 ${i + 1} 执行失败` };
      }
      completed++;
      console.log(`[workflow] 回放 ${i + 1}/${workflow.steps.length}: ${step.type} ✓`);
    } catch (e) {
      const dur = Date.now() - startTime;
      recordWorkflowUsage(workflow.id, false, dur);
      return { success: false, stepsCompleted: completed, error: (e as Error).message };
    }
  }

  const dur = Date.now() - startTime;
  recordWorkflowUsage(workflow.id, true, dur);
  console.log(`[workflow] 回放完成：${workflow.name}，耗时 ${dur}ms`);
  return { success: true, stepsCompleted: completed };
}

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    steps: JSON.parse((row.steps as string) || "[]") as WorkflowStep[],
    createdAt: row.created_at as number,
    lastUsedAt: (row.last_used_at as number) || undefined,
    useCount: (row.use_count as number) || 0,
    successCount: (row.success_count as number) || 0,
    avgDurationMs: (row.avg_duration_ms as number) || 0,
    tags: JSON.parse((row.tags as string) || "[]") as string[],
  };
}
