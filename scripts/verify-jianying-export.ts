/**
 * Phase C P0 验证：打开剪映 + 导出到桌面
 * 运行：npx tsx scripts/verify-jianying-export.ts
 * 前置：剪映已安装、DirectShell 可选
 */

import { runJianyingExport } from "../src/pipeline/videoPipeline.js";

async function main() {
  console.log("[验证] 开始：打开剪映并导出到桌面（output.mp4）…");
  const result = await runJianyingExport({ filename: "output.mp4", toDesktop: true });
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
