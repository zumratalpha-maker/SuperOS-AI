/**
 * 验证核心模块：systemSensor / validator / executor / taskStore / taskScheduler
 */
import "dotenv/config";

import * as sensor from "../src/core/systemSensor.js";
import * as validator from "../src/core/validator.js";
import * as taskStore from "../src/core/taskStore.js";
import { TaskScheduler } from "../src/core/taskScheduler.js";
import * as browserBridge from "../src/tools/browserBridge.js";

const DIVIDER = "─".repeat(60);

async function testSystemSensor() {
  console.log("\n" + DIVIDER);
  console.log("  [1/5] 系统感知模块 (systemSensor)");
  console.log(DIVIDER);

  const disk = await sensor.getDiskSpace("C");
  console.log("  磁盘(C):", disk ? `${disk.freeGB}GB 可用 / ${disk.totalGB}GB 总量 (${disk.usedPercent}%已用)` : "获取失败");

  const mem = await sensor.getMemoryUsage();
  console.log("  内存:", mem ? `${mem.availableGB}GB 可用 / ${mem.totalGB}GB 总量 (${mem.usedPercent}%已用)` : "获取失败");

  const net = await sensor.getNetworkStatus();
  console.log("  网络:", net.connected ? `已连接 (延迟 ${net.latencyMs}ms)` : "未连接");

  const admin = await sensor.checkAdminPrivilege();
  console.log("  管理员:", admin ? "是" : "否");

  const procs = await sensor.getRunningProcesses("chrome");
  console.log("  Chrome 进程:", procs.length > 0 ? `${procs.length} 个 (最大内存: ${procs[0]?.memoryMB}MB)` : "未运行");

  const preflight = await sensor.preflightCheck({ requiredDiskGB: 1 });
  console.log("  前置校验:", preflight.ok ? "✓ 通过" : `✗ 失败: ${preflight.errors.join(", ")}`);
  if (preflight.warnings.length > 0) console.log("  ⚠ 警告:", preflight.warnings.join(", "));
}

async function testValidator() {
  console.log("\n" + DIVIDER);
  console.log("  [2/5] 结果校验模块 (validator)");
  console.log(DIVIDER);

  const fileCheck = validator.validateFileExists("d:\\SuperOS\\package.json", { minSizeBytes: 100 });
  console.log("  文件校验(package.json):", fileCheck.passed ? "✓ " + fileCheck.message : "✗ " + fileCheck.message);

  const dirCheck = validator.validateDirectoryHasFiles("d:\\SuperOS\\src", { minCount: 3, extensions: [".ts"] });
  console.log("  目录校验(src):", dirCheck.passed ? "✓ " + dirCheck.message : "✗ " + dirCheck.message);

  const winCheck = await validator.validateWindowExists("Cursor");
  console.log("  窗口校验(Cursor):", winCheck.passed ? "✓ " + winCheck.message : "✗ " + winCheck.message);

  const noFileCheck = validator.validateFileExists("d:\\SuperOS\\nonexistent_file.xyz");
  console.log("  不存在文件:", noFileCheck.passed ? "✗ 不应通过" : "✓ 正确拒绝: " + noFileCheck.message);
}

async function testTaskStore() {
  console.log("\n" + DIVIDER);
  console.log("  [3/5] 任务持久化存储 (taskStore)");
  console.log(DIVIDER);

  const task = taskStore.createPersistentTask({
    kind: "test_task",
    payload: { action: "verify", target: "core_modules" },
    priority: "high",
    totalSteps: 3,
  });
  console.log("  创建任务:", task.id, "状态:", task.status);

  taskStore.updateTaskStatus(task.id, "running", { currentStep: 1 });
  const updated = taskStore.getTaskById(task.id);
  console.log("  更新后:", updated?.status, "step:", updated?.currentStep);

  taskStore.logTaskStep({
    taskId: task.id,
    stepIndex: 0,
    engine: "uia",
    action: "click",
    success: true,
    durationMs: 120,
  });
  const logs = taskStore.getTaskLogs(task.id);
  console.log("  执行日志:", logs.length, "条");

  taskStore.updateTaskStatus(task.id, "completed", { progress: 100 });
  const stats = taskStore.getTaskStats();
  console.log("  任务统计:", `总${stats.total} 待${stats.pending} 运行${stats.running} 完成${stats.completed} 失败${stats.failed}`);

  taskStore.closeTaskDb();
}

async function testTaskScheduler() {
  console.log("\n" + DIVIDER);
  console.log("  [4/5] 任务调度器 (taskScheduler)");
  console.log(DIVIDER);

  const scheduler = new TaskScheduler({ maxParallel: 2, enablePreflight: false });

  let executedSteps = 0;
  scheduler.registerExecutor("demo_task", async (_task, step) => {
    executedSteps++;
    console.log(`    执行 step ${step}...`);
    await new Promise((r) => setTimeout(r, 100));
    return { success: true };
  });

  const task = scheduler.submit({
    kind: "demo_task",
    payload: { test: true },
    totalSteps: 3,
    priority: "high",
  });
  console.log("  提交任务:", task.id);

  const plan = scheduler.submitPlan({
    name: "测试计划",
    stages: [
      { name: "阶段1", kind: "demo_task", payload: { stage: 1 }, totalSteps: 1 },
      { name: "阶段2", kind: "demo_task", payload: { stage: 2 }, totalSteps: 1, dependsOnStageIndex: [0] },
    ],
  });
  console.log("  提交计划:", plan.id);

  console.log("  ✓ 调度器创建成功（跳过实际调度循环以避免阻塞）");
}

async function testDeepSeekAPI() {
  console.log("\n" + DIVIDER);
  console.log("  [5/5] DeepSeek API 文案生成");
  console.log(DIVIDER);

  if (!process.env.CLOUD_API_KEY) {
    console.log("  ⚠ CLOUD_API_KEY 未配置，跳过");
    return;
  }

  console.log("  正在调用 DeepSeek API...");
  const result = await browserBridge.deepseekCopywriting("请写一段关于「高效办公」的短视频文案，50字以内。");
  if (result.success) {
    console.log("  ✓ 文案生成成功:");
    console.log("    " + (result.text?.slice(0, 200) ?? ""));
  } else {
    console.log("  ✗ 失败:", result.error);
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         SuperOS 核心模块验证                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  await testSystemSensor();
  await testValidator();
  await testTaskStore();
  await testTaskScheduler();
  await testDeepSeekAPI();

  console.log("\n" + DIVIDER);
  console.log("  全部验证完成");
  console.log(DIVIDER + "\n");
}

main().catch(console.error);
