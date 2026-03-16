/**
 * 验证文案生成模块
 * 运行：npx tsx scripts/verify-copywriting.ts [话题]
 * 示例：npx tsx scripts/verify-copywriting.ts 春天的第一杯奶茶
 * 默认话题：如何提高工作效率
 */

import "dotenv/config";
import { generateCopywriting, generateStoryboard } from "../src/copywriting/index.js";

async function main() {
  const topic = process.argv[2]?.trim() || "如何提高工作效率";
  console.log("[验证] 话题:", topic);
  console.log("[验证] 生成文案…");
  const copywriting = await generateCopywriting(topic);
  console.log("\n--- 文案 ---\n" + copywriting + "\n---\n");

  console.log("[验证] 生成分镜…");
  const storyboard = await generateStoryboard(copywriting);
  console.log("\n--- 分镜 (" + storyboard.length + " 个) ---");
  storyboard.forEach((s, i) => {
    console.log(`\n[${i + 1}] scene: ${s.scene}`);
    console.log(`    prompt: ${s.prompt}`);
  });
  console.log("\n[验证] 完成");
}

main().catch((e) => {
  console.error("[验证] 失败:", e);
  process.exit(1);
});
