/**
 * 诊断微信窗口 UIA 树：查找包含指定文本的元素
 * 用法：npx tsx scripts/check_wechat_ui.ts [搜索文本，默认 阿尔法]
 */

import * as supereyeClient from "../src/tools/supereyeClient";

async function main() {
  const keyword = process.argv[2] || "阿尔法";
  console.log("查找窗口「微信」并导出 UIA 树，搜索包含:", keyword);

  const win = await supereyeClient.findWindow("微信");
  if (!win) {
    console.error("未找到微信窗口");
    process.exit(1);
  }
  console.log("找到窗口 hwnd=%d pid=%d name=%s", win.hwnd, win.process_id, win.name);

  const tree = await supereyeClient.getElementTree(win.hwnd, 20);
  console.log("元素总数:", tree.length);

  const matches: Array<{ idx: number; name?: string; role?: string; rect?: string }> = [];
  tree.forEach((e, i) => {
    const name = e.name ?? "";
    if (name.includes(keyword)) {
      matches.push({
        idx: i,
        name: e.name ?? undefined,
        role: e.role ?? undefined,
        rect: e.rect ? `(${e.rect.left},${e.rect.top})-(${e.rect.right},${e.rect.bottom})` : undefined,
      });
    }
  });

  console.log("\n包含「" + keyword + "」的元素:", matches.length, "个");
  matches.forEach((m, i) => console.log("  ", i + 1, JSON.stringify(m)));

  if (matches.length === 0) {
    console.log("\n未找到匹配元素。前 30 个有 name 的元素 sample:");
    let count = 0;
    for (const e of tree) {
      if (e.name && count < 30) {
        console.log("  ", e.role ?? "?", "|", (e.name ?? "").slice(0, 50));
        count++;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
