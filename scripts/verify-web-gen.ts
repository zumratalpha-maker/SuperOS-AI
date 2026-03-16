/**
 * 验证网页创作流程
 * 运行：npx tsx scripts/verify-web-gen.ts [--run] [--puppeteer] [文案|文生图|图生视频]
 * 示例：npx tsx scripts/verify-web-gen.ts 文生图
 *      npx tsx scripts/verify-web-gen.ts --run --puppeteer 文生图   (Puppeteer 路径)
 *      npx tsx scripts/verify-web-gen.ts --run 文案
 *      npx tsx scripts/verify-web-gen.ts --run 图生视频 --imagePath C:\...\a.png
 * --puppeteer: 使用 Puppeteer 浏览器自动化（推荐，稳定性高）
 * 默认：仅解析并打印 steps，不执行；加 --run 则执行
 */

import "dotenv/config";
import { parseIntent } from "../src/jarvis/parseIntent.js";
import { runA11ySequence } from "../src/runA11ySequence.js";
import { buildKlingVideoSteps, buildJimengVideoSteps } from "../src/pipeline/webGenSteps.js";
import * as browserBridge from "../src/tools/browserBridge.js";

const ARGS = process.argv.slice(2);
const doRun = ARGS.includes("--run");
const usePuppeteer = ARGS.includes("--puppeteer");
const imagePathIdx = ARGS.indexOf("--imagePath");
const imagePath = imagePathIdx >= 0 ? ARGS[imagePathIdx + 1]?.trim() : undefined;
const toolIdx = ARGS.indexOf("--tool");
const tool = (toolIdx >= 0 ? ARGS[toolIdx + 1] : "可灵").trim();
const modeArg = ARGS.find((a) => !a.startsWith("--") && (imagePathIdx < 0 || a !== ARGS[imagePathIdx + 1]) && (toolIdx < 0 || a !== ARGS[toolIdx + 1]));
const mode = (modeArg ?? "文生图").trim();

const TEST_INPUTS: Record<string, string> = {
  文案: "帮我写一篇关于春天的短视频文案",
  文生图: "用通义万相生成一张橘色猫趴在窗台上的图片",
  图生视频: "用可灵把图片生成视频",
};

async function main() {
  if (usePuppeteer && doRun) {
    console.log("[验证] Puppeteer 模式：" + mode);
    try {
      if (mode === "文生图") {
        const prompt = "一只橘色短毛猫，趴在窗台上晒太阳，写实风格";
        console.log("[验证] prompt:", prompt);
        const result = await browserBridge.tongyiWanxiangTextToImage(prompt);
        if (result.success) {
          console.log("[验证] 文生图成功！图片:", result.outputPath);
        } else {
          console.error("[验证] 文生图失败:", result.error);
        }
      } else if (mode === "文案") {
        const prompt = "请写一段关于春天的短视频文案，100～200字，口语化，有节奏感。";
        console.log("[验证] prompt:", prompt);
        const result = await browserBridge.geminiCopywriting(prompt);
        if (result.success) {
          console.log("[验证] 文案生成成功！\n" + result.text?.slice(0, 300));
        } else {
          console.error("[验证] 文案生成失败:", result.error);
        }
      } else if (mode === "图生视频") {
        if (!imagePath) {
          console.error("[验证] 图生视频需 --imagePath");
          process.exit(1);
        }
        console.log("[验证] 图片:", imagePath);
        const result = /即梦|Jimeng/i.test(tool)
          ? await browserBridge.jimengImageToVideo(imagePath, "镜头推进")
          : await browserBridge.klingImageToVideo(imagePath, "镜头缓慢推进");
        if (result.success) {
          console.log("[验证] 视频生成成功！视频:", result.outputPath);
        } else {
          console.error("[验证] 视频生成失败:", result.error);
        }
      }
    } finally {
      await browserBridge.closeBrowser().catch(() => {});
    }
    return;
  }

  let steps: Array<{ type: string; app?: string; name?: string; text?: string; keys?: string; ms?: number }>;

  if (mode === "图生视频") {
    const pathForSteps = imagePath || "C:\\path\\to\\image.png";
    if (doRun && !imagePath) {
      console.error("[验证] 图生视频执行需 --imagePath，如: npm run verify:web-gen -- --run 图生视频 --imagePath C:\\Users\\xxx\\Downloads\\a.png");
      process.exit(1);
    }
    steps = /即梦|Jimeng/i.test(tool)
      ? buildJimengVideoSteps(pathForSteps, "镜头推进")
      : buildKlingVideoSteps(pathForSteps, "镜头缓慢推进");
    console.log("[验证] 图生视频（" + tool + "）" + (imagePath ? "，图片: " + imagePath : "（预览，执行时需 --imagePath）"));
  } else {
    const input = TEST_INPUTS[mode] ?? mode;
    console.log("[验证] 输入:", input);
    console.log("[验证] 解析意图…");
    const intent = await parseIntent(input, []);
    if (!intent) {
      console.error("[验证] 无法解析意图");
      process.exit(1);
    }
    if (intent.kind === "puppeteer_web_gen") {
      console.log("[验证] 解析为 Puppeteer 网页创作意图:", intent.tool, "prompt:", intent.prompt.slice(0, 60));
      if (doRun) {
        console.log("[验证] 提示：加 --puppeteer 执行 Puppeteer 路径");
      }
      console.log("[验证] 解析完成。");
      return;
    }
    if (intent.kind !== "a11y_sequence") {
      console.error("[验证] 非 a11y_sequence:", intent.kind);
      process.exit(1);
    }
    steps = intent.steps;
  }
  console.log("\n[验证] 产出 steps (" + steps.length + " 步):");
  steps.forEach((s, i) => {
    const desc =
      s.type === "open_app"
        ? `open_app ${(s as { app?: string }).app}`
        : s.type === "type"
          ? `type "${((s as { text?: string }).text ?? "").slice(0, 40)}…"`
          : s.type === "click"
            ? `click ${(s as { name?: string }).name}`
            : s.type === "wait"
              ? `wait ${(s as { ms?: number }).ms}ms`
              : s.type === "keys"
                ? `keys ${(s as { keys?: string }).keys}`
                : String(s.type);
    console.log("  " + (i + 1) + ". " + desc);
  });

  if (doRun) {
    console.log("\n[验证] 执行 a11y_sequence（UIA 路径）…");
    try {
      await runA11ySequence({ kind: "a11y_sequence", steps });
      console.log("[验证] 完成");
    } catch (e) {
      console.error("[验证] 执行失败:", e);
      process.exit(1);
    }
  } else {
    console.log("\n[验证] 解析完成（未执行）。加 --run 执行 UIA 路径，加 --run --puppeteer 执行 Puppeteer 路径。");
  }
}

main().catch((e) => {
  console.error("[验证] 异常:", e);
  process.exit(1);
});
