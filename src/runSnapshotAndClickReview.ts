/**
 * Orchestrator 合体任务：抓取快照 → 记录轨迹 → 模拟点击（意图）→ 真实 ds_click → 再次抓取 + 差异对比
 * 两阶段闭环：click_intent（模拟）→ clickByName（真实 DirectShell 执行）
 */

import {
  createTask,
  runNextTask,
  type ExecuteStepFn,
  type Task,
} from "./agents/orchestrator.js";
import {
  captureA11ySnapshot,
  diffA11ySnapshots,
} from "./tools/a11yDiff.js";
import { recordTrajectory } from "./tools/trajectoryRecorder.js";
import {
  findNodeByName,
  clickByName,
  formatTarget,
} from "./tools/directShellBridge.js";

interface SnapshotAndClickReviewPayload {
  kind: "snapshot_and_click_review";
  targetApp: string;
  buttonName: string;
}

function isSnapshotAndClickReviewPayload(
  payload: unknown
): payload is SnapshotAndClickReviewPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    p.kind === "snapshot_and_click_review" &&
    typeof p.targetApp === "string" &&
    typeof p.buttonName === "string"
  );
}

/**
 * Orchestrator 合体：DirectShell 采样 + trajectoryRecorder 记录 + a11yDiff 前后对比
 * 流程：ds_snapshot → before_click → click_intent（模拟）→ 真实 ds_click → after_click → after_real_click + diff
 */
export const snapshotAndClickStep: ExecuteStepFn = async ({ task }) => {
  const payload = task.payload;
  if (!isSnapshotAndClickReviewPayload(payload)) {
    try {
      console.error(
        "[runSnapshotAndClickReview] payload 不是 snapshot_and_click_review，taskId=%s",
        task.id
      );
    } catch (_) {}
    throw new Error("payload 不是 snapshot_and_click_review");
  }

  const { targetApp, buttonName } = payload;
  const target = formatTarget(targetApp, buttonName);

  try {
    // Step 1: DirectShell 采样（ds_profiles 快照）
    const snapshot = await captureA11ySnapshot();
    await recordTrajectory({
      timestamp: Date.now(),
      action: "ds_snapshot",
      target: targetApp,
      afterState: snapshot,
    });

    // Step 2: before 快照
    const before = snapshot;

    await recordTrajectory({
      timestamp: Date.now(),
      action: "before_click",
      target: targetApp,
      afterState: before,
    });

    // Step 3: 模拟点击（记录意图，查找目标）
    const foundNode = findNodeByName(before, buttonName);

    await recordTrajectory({
      timestamp: Date.now(),
      action: "click_intent",
      target: buttonName,
      beforeState: before,
      found: Boolean(foundNode),
    });

    // Step 4: 真实 ds_click（DirectShell inject / UiaSniper）
    await clickByName(target);

    // 给 UI 时间完成渲染
    await new Promise((r) => setTimeout(r, 800));

    // Step 5: after_click 快照 + diff
    const after = await captureA11ySnapshot();
    const diff = diffA11ySnapshots(before, after);

    await recordTrajectory({
      timestamp: Date.now(),
      action: "after_click",
      target: targetApp,
      beforeState: before,
      afterState: after,
      diffSummary: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
      },
    });

    // Step 6: 二次采样（after_real_click，应对异步 UI 更新）
    await new Promise((r) => setTimeout(r, 400));
    const afterReal = await captureA11ySnapshot();

    await recordTrajectory({
      timestamp: Date.now(),
      action: "after_real_click",
      target: targetApp,
      beforeState: before,
      afterState: afterReal,
      diffSummary: {
        added: diffA11ySnapshots(before, afterReal).added.length,
        removed: diffA11ySnapshots(before, afterReal).removed.length,
        changed: diffA11ySnapshots(before, afterReal).changed.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      console.error("[runSnapshotAndClickReview] snapshotAndClickStep 失败 taskId=%s: %s", task.id, msg);
    } catch (_) {}
    throw err;
  }
};

/** 创建并执行一次 snapshot_and_click_review 任务 */
export async function runSnapshotAndClickReviewOnce(): Promise<Task | null> {
  const task = createTask({
    kind: "snapshot_and_click_review",
    targetApp: "cursor",
    buttonName: "Review",
  });
  return runNextTask(snapshotAndClickStep);
}

