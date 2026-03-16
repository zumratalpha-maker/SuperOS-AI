/**
 * 验证文生图模块
 * 运行：npx tsx scripts/verify-text-to-image.ts [prompt]
 * 示例：npx tsx scripts/verify-text-to-image.ts "A cute cat sitting by the window"
 * 默认：cinematic shot of a cup of coffee in morning light
 */

import "dotenv/config";
import { textToImage } from "../src/mediaGen/textToImage.js";

async function main() {
  const prompt = process.argv[2]?.trim() || "cinematic shot of a cup of coffee in morning light, soft focus";
  console.log("[验证] prompt:", prompt);
  console.log("[验证] 生成图片…");
  const outPath = await textToImage(prompt, { index: 0 });
  console.log("[验证] 完成，保存至:", outPath);
}

main().catch((e) => {
  console.error("[验证] 失败:", e);
  process.exit(1);
});
