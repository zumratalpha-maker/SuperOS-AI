/**
 * Phase C P1 验证：打开剪映 + 导入本地视频 + 导出
 * 运行：npx tsx scripts/verify-jianying-import.ts [视频路径]
 * 示例：npx tsx scripts/verify-jianying-import.ts C:\Users\Administrator\Videos\test.mp4
 * 默认：若未指定路径，使用 C:\Users\%USERNAME%\Videos\ 下第一个 .mp4 或提示
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runJianyingFullPipeline } from "../src/pipeline/videoPipeline.js";

async function findDefaultVideo(): Promise<string | null> {
  const videosDir = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, "Videos")
    : null;
  if (!videosDir || !existsSync(videosDir)) return null;
  const entries = await readdir(videosDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /\.(mp4|mov|avi|mkv)$/i.test(e.name)) {
      return join(videosDir, e.name);
    }
  }
  return null;
}

async function main() {
  const argPath = process.argv[2]?.trim();
  let importPath: string;
  if (argPath && existsSync(argPath)) {
    importPath = argPath;
  } else {
    const defaultVideo = await findDefaultVideo();
    if (defaultVideo) {
      importPath = defaultVideo;
      console.log("[验证] 未指定路径，使用:", importPath);
    } else {
      console.error("[验证] 请指定视频路径，例如：");
      console.error("  npx tsx scripts/verify-jianying-import.ts C:\\Users\\xxx\\Videos\\test.mp4");
      process.exit(1);
    }
  }

  console.log("[验证] 开始：打开剪映 → 导入", importPath, "→ 导出到桌面 output.mp4 …");
  const result = await runJianyingFullPipeline({
    importPath,
    filename: "output.mp4",
    toDesktop: true,
  });
  if (result.ok) {
    console.log("[验证] 完成！");
  } else {
    console.error("[验证] 失败:", result.error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[验证] 异常:", e);
  process.exit(1);
});
