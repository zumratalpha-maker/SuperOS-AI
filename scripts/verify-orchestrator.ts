/**
 * 验证 Orchestrator 合体闭环
 * 运行: npx tsx scripts/verify-orchestrator.ts
 *
 * 前置条件：
 * 1. DirectShell 守护进程已启动（directshell.exe）
 * 2. Cursor 窗口在前台且可见 Review 按钮
 */
import { runSnapshotAndClickReviewOnce } from "../src/runSnapshotAndClickReview.js";

async function main() {
  console.log("[验证] 开始执行 Orchestrator 合体测试...");
  console.log("[验证] 请确保：");
  console.log("  1. DirectShell 已运行（D:\\DirectShell\\target\\release\\directshell.exe）");
  console.log("  2. Cursor 窗口在前台");
  console.log("");

  try {
    const task = await runSnapshotAndClickReviewOnce();
    if (task) {
      console.log("[验证] 完成！任务状态:", task.status);
      console.log("[验证] 轨迹已写入 data/trajectories/trajectories_YYYY-MM-DD.jsonl");
    } else {
      console.log("[验证] 无待执行任务（可能已有其他 pending 任务）");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[验证] 失败:", msg);
    process.exitCode = 1;
  }
}

main();
