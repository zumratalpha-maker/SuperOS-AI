/**
 * 任务调度器 — 层3：支持依赖执行、并行执行、定时执行、断点续跑、人机协同
 */

import {
  createPersistentTask,
  getTaskById,
  updateTaskStatus,
  getNextPendingTask,
  getResumableTasks,
  areDependenciesMet,
  getSubTasks,
  logTaskStep,
  type TaskRecord,
  type TaskPriority,
} from "./taskStore.js";

import { preflightCheck } from "./systemSensor.js";
import { runValidation, type ValidationSpec } from "./validator.js";

export type TaskExecutor = (task: TaskRecord, stepIndex: number) => Promise<{
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}>;

export interface SchedulerConfig {
  maxParallel: number;
  pollIntervalMs: number;
  enablePreflight: boolean;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  maxParallel: 3,
  pollIntervalMs: 2000,
  enablePreflight: true,
};

export class TaskScheduler {
  private config: SchedulerConfig;
  private executors: Map<string, TaskExecutor> = new Map();
  private runningCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 注册任务执行器（按 task.kind 分发） */
  registerExecutor(kind: string, executor: TaskExecutor): void {
    this.executors.set(kind, executor);
  }

  /** 提交任务 */
  submit(options: {
    kind: string;
    payload: Record<string, unknown>;
    priority?: TaskPriority;
    totalSteps?: number;
    dependsOn?: string[];
    scheduledAt?: number;
    parentId?: string;
  }): TaskRecord {
    return createPersistentTask(options);
  }

  /** 提交长周期计划（自动拆成子任务） */
  submitPlan(plan: {
    name: string;
    stages: Array<{
      name: string;
      kind: string;
      payload: Record<string, unknown>;
      totalSteps?: number;
      dependsOnStageIndex?: number[];
    }>;
    priority?: TaskPriority;
  }): TaskRecord {
    const parent = createPersistentTask({
      kind: "plan",
      payload: { name: plan.name, stageCount: plan.stages.length },
      priority: plan.priority,
      totalSteps: plan.stages.length,
    });

    const stageIds: string[] = [];
    for (let i = 0; i < plan.stages.length; i++) {
      const stage = plan.stages[i];
      const deps = (stage.dependsOnStageIndex ?? []).map((idx) => stageIds[idx]).filter(Boolean);
      const sub = createPersistentTask({
        kind: stage.kind,
        payload: { ...stage.payload, stageName: stage.name },
        priority: plan.priority,
        totalSteps: stage.totalSteps ?? 0,
        parentId: parent.id,
        dependsOn: deps,
      });
      stageIds.push(sub.id);
    }

    return parent;
  }

  /** 暂停任务（人机协同：等待用户手动操作后继续） */
  pauseForUser(taskId: string, reason: string): void {
    updateTaskStatus(taskId, "waiting_user", { error: reason });
    console.log(`[scheduler] 任务 ${taskId} 暂停，等待用户操作: ${reason}`);
  }

  /** 用户完成手动操作后恢复 */
  resumeTask(taskId: string): void {
    const task = getTaskById(taskId);
    if (!task) return;
    if (task.status === "waiting_user" || task.status === "paused") {
      updateTaskStatus(taskId, "pending");
      console.log(`[scheduler] 任务 ${taskId} 已恢复到队列`);
    }
  }

  /** 取消任务 */
  cancelTask(taskId: string): void {
    updateTaskStatus(taskId, "cancelled");
  }

  /** 启动调度循环 */
  start(): void {
    this.stopped = false;
    console.log(`[scheduler] 调度器启动（最大并行: ${this.config.maxParallel}）`);

    this.resumeInterruptedTasks();

    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      this.poll().catch((e) => console.error("[scheduler] poll 异常:", e));
    }, this.config.pollIntervalMs);
  }

  /** 停止调度 */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[scheduler] 调度器已停止");
  }

  /** 恢复上次中断的任务（断点续跑） */
  private resumeInterruptedTasks(): void {
    const resumable = getResumableTasks();
    for (const task of resumable) {
      if (task.status === "running") {
        console.log(`[scheduler] 发现中断任务 ${task.id}(step ${task.currentStep}/${task.totalSteps})，标记为 pending 等待重新调度`);
        updateTaskStatus(task.id, "pending");
      }
    }
  }

  /** 轮询：取下一个任务并执行 */
  private async poll(): Promise<void> {
    if (this.runningCount >= this.config.maxParallel) return;

    const task = getNextPendingTask();
    if (!task) return;

    if (task.dependsOn.length > 0 && !areDependenciesMet(task.id)) {
      return;
    }

    if (task.kind === "plan") {
      await this.executePlan(task);
      return;
    }

    const executor = this.executors.get(task.kind);
    if (!executor) {
      console.warn(`[scheduler] 未注册执行器: ${task.kind}，跳过任务 ${task.id}`);
      updateTaskStatus(task.id, "failed", { error: `未注册执行器: ${task.kind}` });
      return;
    }

    this.runningCount++;
    this.executeTask(task, executor).finally(() => {
      this.runningCount--;
    });
  }

  private async executeTask(task: TaskRecord, executor: TaskExecutor): Promise<void> {
    updateTaskStatus(task.id, "running");
    const startStep = task.currentStep;
    const totalSteps = task.totalSteps || 1;

    if (this.config.enablePreflight) {
      const needsNet = !!(task.payload as Record<string, unknown>).url;
      const preflight = await preflightCheck({ needsNetwork: needsNet });
      if (!preflight.ok) {
        const errMsg = preflight.errors.join("; ");
        console.error(`[scheduler] 前置校验失败: ${errMsg}`);
        updateTaskStatus(task.id, "failed", { error: `前置校验失败: ${errMsg}` });
        return;
      }
      if (preflight.warnings.length > 0) {
        console.warn(`[scheduler] 前置校验警告: ${preflight.warnings.join("; ")}`);
      }
    }

    for (let step = startStep; step < totalSteps; step++) {
      if (this.stopped) {
        updateTaskStatus(task.id, "paused", { currentStep: step });
        console.log(`[scheduler] 调度器停止，任务 ${task.id} 暂停于 step ${step}`);
        return;
      }

      const fresh = getTaskById(task.id);
      if (fresh?.status === "waiting_user" || fresh?.status === "cancelled") return;

      const stepStart = Date.now();
      try {
        const result = await executor(task, step);
        const duration = Date.now() - stepStart;

        logTaskStep({
          taskId: task.id,
          stepIndex: step,
          success: result.success,
          durationMs: duration,
          error: result.error,
        });

        if (!result.success) {
          updateTaskStatus(task.id, "failed", {
            currentStep: step,
            error: result.error ?? `Step ${step} 执行失败`,
          });
          return;
        }

        const progress = Math.round(((step + 1) / totalSteps) * 100);
        updateTaskStatus(task.id, "running", {
          currentStep: step + 1,
          progress,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        logTaskStep({
          taskId: task.id,
          stepIndex: step,
          success: false,
          durationMs: Date.now() - stepStart,
          error: msg,
        });
        updateTaskStatus(task.id, "failed", {
          currentStep: step,
          error: msg,
        });
        return;
      }
    }

    updateTaskStatus(task.id, "completed", { progress: 100 });
    console.log(`[scheduler] 任务 ${task.id} 完成`);

    const validationSpec = (task.payload as Record<string, unknown>).validation as ValidationSpec | undefined;
    if (validationSpec) {
      const vResult = await runValidation(validationSpec);
      if (!vResult.passed) {
        console.warn(`[scheduler] 任务 ${task.id} 结果校验失败: ${vResult.message}`);
        updateTaskStatus(task.id, "failed", {
          error: `结果校验失败: ${vResult.message}`,
          result: { validation: vResult },
        });
      }
    }
  }

  /** 执行 plan 类型任务：监控子任务完成度 */
  private async executePlan(plan: TaskRecord): Promise<void> {
    updateTaskStatus(plan.id, "running");
    const subs = getSubTasks(plan.id);
    const total = subs.length;
    if (total === 0) {
      updateTaskStatus(plan.id, "completed");
      return;
    }

    const checkCompletion = (): boolean => {
      const current = getSubTasks(plan.id);
      const completed = current.filter((s) => s.status === "completed").length;
      const failed = current.filter((s) => s.status === "failed").length;

      updateTaskStatus(plan.id, "running", {
        progress: Math.round((completed / total) * 100),
        currentStep: completed,
      });

      if (failed > 0) {
        updateTaskStatus(plan.id, "failed", {
          error: `${failed}/${total} 个子任务失败`,
        });
        return true;
      }
      if (completed === total) {
        updateTaskStatus(plan.id, "completed", { progress: 100 });
        return true;
      }
      return false;
    };

    for (let i = 0; i < 1000; i++) {
      if (this.stopped || checkCompletion()) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** 全局单例 */
let _scheduler: TaskScheduler | null = null;
export function getScheduler(config?: Partial<SchedulerConfig>): TaskScheduler {
  if (!_scheduler) _scheduler = new TaskScheduler(config);
  return _scheduler;
}
