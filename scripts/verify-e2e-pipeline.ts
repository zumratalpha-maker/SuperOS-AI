/**
 * 端到端流水线验证：话题 → 文案 → 文生图（通义万相）→ [可选] 剪映
 * 运行：npx tsx scripts/verify-e2e-pipeline.ts [话题] [--run] [--imagePath 路径]
 * 示例：npx tsx scripts/verify-e2e-pipeline.ts 春天的第一杯奶茶
 *      npx tsx scripts/verify-e2e-pipeline.ts 春天 --run
 *      npx tsx scripts/verify-e2e-pipeline.ts 春天 --run --imagePath C:\Users\xxx\Downloads\xxx.png
 */

import "dotenv/config";
import { runFullE2EPipeline } from "../src/pipeline/videoPipeline.js";

const ARGS = process.argv.slice(2);
const doRun = ARGS.includes("--run");
const imagePathIdx = ARGS.indexOf("--imagePath");
const imagePath = imagePathIdx >= 0 ? ARGS[imagePathIdx + 1]?.trim() : undefined;
const topic = ARGS.filter((a) => a !== "--run" && a !== "--imagePath" && (imagePathIdx < 0 || a !== ARGS[imagePathIdx + 1]))[0]?.trim() || "春天的第一杯奶茶";

async function main() {
  console.log("[验证] 话题:", topic);
  if (imagePath) console.log("[验证] 图片路径:", imagePath);

  if (!doRun) {
    console.log("[验证] 预览模式（未执行）。加 --run 可实际执行。");
    console.log("[验证] 流程: 1.生成文案 2.通义万相文生图 3.剪映导入导出(需 --imagePath)");
    return;
  }

  console.log("[验证] 执行端到端流水线…");
  const result = await runFullE2EPipeline(topic, {
    imagePath,
    outputFilename: "e2e_output.mp4",
  });

  if (result.ok) {
    console.log("[验证] 完成");
    if (result.copywriting) console.log("\n--- 文案 ---\n" + result.copywriting.slice(0, 200) + "…");
  } else {
    console.error("[验证] 失败:", result.error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[验证] 异常:", e);
  process.exit(1);
});
