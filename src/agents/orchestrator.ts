/**
 * 多智能体编排调度层：任务状态、创建任务、基础调度逻辑，执行步骤时接入自愈机制
 * 所有外部调用均 try-catch + 日志；执行步骤预留接口，待 MCP 就绪后注入
 */

import {
  withRetry,
  withTimeout,
  withFallback,
  type RetryOptions,
} from "../tools/resilience.js";

/** 任务状态枚举 */
export type TaskStatus =
  | "pending"   // 待执行
  | "running"   // 执行中
  | "completed" // 已完成
  | "failed"    // 失败
  | "cancelled"; // 已取消

/** A11y 多步链单步类型 */
export type A11yStep =
  | { type: "open_app"; app: string }
  | { type: "type"; text: string }
  | { type: "generate_and_type"; prompt: string }
  | { type: "click"; name: string }
  | { type: "keys"; keys: string }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right" }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "wait"; ms: number };

/** 基于 A11y 的连续多步任务（打开应用 → 输入 → 点击 → …） */
export interface A11ySequencePayload {
  kind: "a11y_sequence";
  steps: A11yStep[];
}

/** 任务 payload 类型（可扩展） */
export type TaskPayload =
  | Record<string, unknown>
  | SnapshotAndClickReviewPayload
  | A11ySequencePayload;

/** 微型任务：抓取快照、记录轨迹并点击 Review 按钮 */
export interface SnapshotAndClickReviewPayload {
  kind: "snapshot_and_click_review";
  targetApp: string;
  buttonName: string;
}

/** 任务实体 */
export interface Task {
  id: string;
  status: TaskStatus;
  payload: TaskPayload;
  createdAt: number;
  updatedAt?: number;
  error?: string;
}

/** 执行一步的上下文（预留：后续接 MCP / DirectShell） */
export interface StepContext {
  task: Task;
  stepIndex: number;
}

/** 单步执行函数类型（由外部注入，如 MCP 调用） */
export type ExecuteStepFn = (ctx: StepContext) => Promise<void>;

/** 默认空执行：仅打日志，不调外部（fallback 时勿误报为「未注入」） */
const noopExecuteStep: ExecuteStepFn = async (ctx) => {
  try {
    console.warn(
      "[orchestrator] 步骤回退到 noop（主执行器已失败）。taskId=%s stepIndex=%s",
      ctx.task.id,
      ctx.stepIndex
    );
  } catch (_) {}
};

// --- 内存任务表（首版不持久化） ---
const taskStore: Map<string, Task> = new Map();

/** 生成唯一任务 id（简单时间戳 + 随机） */
function generateTaskId(): string {
  try {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  } catch (err) {
    try {
      console.error("[orchestrator] generateTaskId 异常:", err);
    } catch (_) {}
    return `task_${Date.now()}`;
  }
}

/**
 * 创建任务：生成唯一 id，状态初始为 pending，写入内存表
 * @param payload 任务负载（任意键值）
 * @returns 新任务对象；失败时打日志并抛出
 */
export function createTask(payload: TaskPayload): Task {
  try {
    const id = generateTaskId();
    const now = Date.now();
    const task: Task = {
      id,
      status: "pending",
      payload,
      createdAt: now,
      updatedAt: now,
    };
    taskStore.set(id, task);
    return task;
  } catch (err) {
    try {
      console.error("[orchestrator] createTask 异常:", err);
    } catch (_) {}
    throw err;
  }
}

/**
 * 按 id 获取任务
 */
export function getTask(id: string): Task | undefined {
  try {
    return taskStore.get(id);
  } catch (err) {
    try {
      console.error("[orchestrator] getTask 异常:", err);
    } catch (_) {}
    return undefined;
  }
}

/**
 * 更新任务状态（并更新 updatedAt、可选 error）
 */
export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  error?: string
): void {
  try {
    const task = taskStore.get(id);
    if (!task) {
      try {
        console.error("[orchestrator] updateTaskStatus 任务不存在: %s", id);
      } catch (_) {}
      return;
    }
    task.status = status;
    task.updatedAt = Date.now();
    if (error !== undefined) task.error = error;
  } catch (err) {
    try {
      console.error("[orchestrator] updateTaskStatus 异常:", err);
    } catch (_) {}
  }
}

/**
 * 取下一个待执行任务（pending，按 createdAt 升序）
 */
export function getNextPendingTask(): Task | undefined {
  try {
    const pending = Array.from(taskStore.values()).filter(
      (t) => t.status === "pending"
    );
    if (pending.length === 0) return undefined;
    pending.sort((a, b) => a.createdAt - b.createdAt);
    return pending[0];
  } catch (err) {
    try {
      console.error("[orchestrator] getNextPendingTask 异常:", err);
    } catch (_) {}
    return undefined;
  }
}

/** 调度器配置（超时、重试等） */
export interface OrchestratorConfig {
  stepTimeoutMs?: number;
  stepRetry?: RetryOptions;
  /** 是否对单步使用 fallback（主：注入的 executeStep；备：noop） */
  useStepFallback?: boolean;
}

const defaultConfig: Required<OrchestratorConfig> = {
  stepTimeoutMs: 30_000,
  stepRetry: { maxAttempts: 3, delayMs: 500, backoff: true, backoffFactor: 2 },
  useStepFallback: true,
};

/**
 * 执行单步（内部用）：用 withTimeout + withRetry + 可选 withFallback 包装 stepFn
 * stepFn 内抛错（如 findWindowByName 未找到）会触发 withRetry 重试，保证双屏/多窗鲁棒性
 */
async function runStepWithResilience(
  ctx: StepContext,
  stepFn: ExecuteStepFn,
  config: Required<OrchestratorConfig>
): Promise<void> {
  const { stepTimeoutMs, stepRetry, useStepFallback } = config;
  const wrapped = () =>
    withTimeout(() => stepFn(ctx), stepTimeoutMs);
  const withRetryWrapped = () => withRetry(wrapped, stepRetry);
  const fn = useStepFallback
    ? () => withFallback(withRetryWrapped, () => noopExecuteStep(ctx))
    : () => withRetryWrapped();
  await fn();
}

/**
 * 调度器：取下一 pending 任务，更新为 running，执行一步（预留 stepFn），更新状态
 * @param stepFn 执行一步的实现（未注入则用 noop）；建议在此内调用 MCP/DirectShell
 * @param config 超时/重试/fallback 配置，不传则用默认
 */
export async function runNextTask(
  stepFn: ExecuteStepFn = noopExecuteStep,
  config: OrchestratorConfig = {}
): Promise<Task | null> {
  const cfg = { ...defaultConfig, ...config };
  try {
    const task = getNextPendingTask();
    if (!task) return null;
    updateTaskStatus(task.id, "running");
    const ctx: StepContext = { task, stepIndex: 0 };
    try {
      await runStepWithResilience(ctx, stepFn, cfg);
      updateTaskStatus(task.id, "completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        console.error("[orchestrator] runNextTask 执行失败 taskId=%s: %s", task.id, msg);
      } catch (_) {}
      updateTaskStatus(task.id, "failed", msg);
      throw err; // 错误上抛，供 jarvis say 出摘要（Blueprint 阶段 6）
    }
    return getTask(task.id) ?? null;
  } catch (err) {
    try {
      console.error("[orchestrator] runNextTask 异常:", err);
    } catch (_) {}
    throw err;
  }
}

/**
 * 预留：执行一步的对外接口（可由 MCP 就绪后传入具体 stepFn 给 runNextTask）
 * 此处仅导出类型与 noop 实现，便于上层注入
 */
export { noopExecuteStep };
