/**
 * 端到端短视频流水线测试
 *
 * 测试流程：
 * 1. DeepSeek 生成文案
 * 2. 通义万相文生图
 * 3. 图片保存验证
 *
 * 用法：
 *   npx tsx scripts/e2e-short-video.ts [话题]
 *   npx tsx scripts/e2e-short-video.ts --dry   # 仅测试文案生成（不调浏览器）
 */
import "dotenv/config";
import * as browserBridge from "../src/tools/browserBridge.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const topic = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]) || "春天出游";
const dryRun = process.argv.includes("--dry");

function log(step: string, msg: string): void {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${step}] ${msg}`);
}

function assert(ok: boolean, msg: string): void {
  console.log(ok ? `  ✅ ${msg}` : `  ❌ ${msg}`);
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  SuperOS 端到端短视频流水线测试`);
  console.log(`  话题：${topic}`);
  console.log(`  模式：${dryRun ? "DRY RUN（仅文案）" : "完整流水线"}`);
  console.log(`${"=".repeat(60)}\n`);

  const outputDir = join(process.cwd(), "output", `e2e_${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  log("初始化", `输出目录: ${outputDir}`);

  // ─── Step 1: 文案生成 ───
  log("Step 1", "DeepSeek 文案生成…");
  const t1 = Date.now();
  let copywriting = "";

  try {
    const result = await browserBridge.deepseekCopywriting(
      `请写一段关于「${topic}」的短视频文案，100～200字，口语化，有节奏感，包含标题和3个标签。`,
    );

    const dur = Date.now() - t1;
    assert(result.success, `文案生成 ${result.success ? "成功" : "失败"}（${dur}ms）`);

    if (result.success && result.text) {
      copywriting = result.text;
      const preview = copywriting.slice(0, 200).replace(/\n/g, " ");
      log("Step 1", `文案预览: ${preview}…`);

      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(outputDir, "copywriting.txt"), copywriting, "utf-8");
      log("Step 1", `文案已保存: ${join(outputDir, "copywriting.txt")}`);
    } else {
      log("Step 1", `失败原因: ${result.error ?? "未知"}`);
    }
  } catch (e) {
    log("Step 1", `异常: ${(e as Error).message}`);
    assert(false, "文案生成异常");
  }

  if (dryRun) {
    console.log("\n--- DRY RUN 完成，跳过浏览器操作 ---\n");

    // 验证核心模块可导入
    log("模块检查", "验证核心模块…");
    try {
      await import("../src/core/systemSensor.js");
      assert(true, "systemSensor 可导入");
    } catch { assert(false, "systemSensor 导入失败"); }

    try {
      await import("../src/core/safetyGuard.js");
      assert(true, "safetyGuard 可导入");
    } catch { assert(false, "safetyGuard 导入失败"); }

    try {
      await import("../src/core/memoryGraph.js");
      assert(true, "memoryGraph 可导入");
    } catch { assert(false, "memoryGraph 导入失败"); }

    try {
      await import("../src/core/workflowRecorder.js");
      assert(true, "workflowRecorder 可导入");
    } catch { assert(false, "workflowRecorder 导入失败"); }

    try {
      await import("../src/core/visionEngine.js");
      assert(true, "visionEngine 可导入");
    } catch { assert(false, "visionEngine 导入失败"); }

    console.log(`\n${"=".repeat(60)}`);
    console.log("  DRY RUN 测试完成");
    console.log(`${"=".repeat(60)}\n`);
    return;
  }

  if (!copywriting) {
    log("中止", "文案生成失败，无法继续流水线");
    return;
  }

  // ─── Step 2: 文生图 ───
  log("Step 2", "通义万相文生图…");
  const t2 = Date.now();
  let imagePath = "";

  try {
    const imagePrompt = copywriting.split("\n")[0]?.slice(0, 50) || topic;
    log("Step 2", `图片 Prompt: ${imagePrompt}`);

    const result = await browserBridge.tongyiWanxiangTextToImage(imagePrompt);
    const dur = Date.now() - t2;
    assert(result.success, `文生图 ${result.success ? "成功" : "失败"}（${dur}ms）`);

    if (result.success && result.outputPath) {
      imagePath = result.outputPath;
      log("Step 2", `图片已保存: ${imagePath}`);
      assert(existsSync(imagePath), `图片文件存在: ${imagePath}`);
    } else {
      log("Step 2", `失败原因: ${result.error ?? "未知"}`);
    }
  } catch (e) {
    log("Step 2", `异常: ${(e as Error).message}`);
    assert(false, "文生图异常");
  }

  // ─── Step 3: 验证输出 ───
  log("Step 3", "输出验证…");
  const copyOk = existsSync(join(outputDir, "copywriting.txt"));
  assert(copyOk, "文案文件存在");
  assert(!!imagePath && existsSync(imagePath), "图片文件存在");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  端到端测试完成`);
  console.log(`  输出目录: ${outputDir}`);
  console.log(`  文案: ${copyOk ? "✅" : "❌"}`);
  console.log(`  图片: ${imagePath ? "✅" : "❌"}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(console.error);
