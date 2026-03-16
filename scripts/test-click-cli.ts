/**
 * 终端 CLI 测试 — 直接输入指令，不依赖网页/语音
 * 用法：tsx scripts/test-click-cli.ts
 *
 * 示例指令：
 *   打开微信
 *   打开剪映
 *   点击 微信|输入框
 *   点击 剪映|导出
 *   点击 剪映|开始创作
 *   quit / exit
 */

import * as readline from "node:readline";
import { resolveAndLaunch } from "../src/tools/appExecutor.js";
import { clickByName, findWindowByName } from "../src/tools/directShellBridge.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(): void {
  rl.question("> ", async (line) => {
    const t = (line ?? "").trim();
    if (!t || /^(quit|exit|q)$/i.test(t)) {
      console.log("再见");
      rl.close();
      process.exit(0);
    }

    const openMatch = t.match(/^打开\s*(.+)$/);
    if (openMatch) {
      const app = openMatch[1].trim();
      if (!app) {
        console.log("用法: 打开微信 / 打开剪映");
        ask();
        return;
      }
      console.log("正在打开:", app);
      try {
        const r = await resolveAndLaunch(app);
        console.log(r.ok ? "已打开" : "失败:", r.error ?? "未知");
      } catch (e) {
        console.log("失败:", (e as Error).message);
      }
      ask();
      return;
    }

    const clickMatch = t.match(/^点击\s+(.+)$/);
    if (clickMatch) {
      const target = clickMatch[1].trim();
      if (!target) {
        console.log("用法: 点击 微信|输入框 / 点击 剪映|导出");
        ask();
        return;
      }
      console.log("正在点击:", target);
      try {
        const r = await clickByName(target);
        console.log(r.done ? "已执行" : "未完成");
      } catch (e) {
        console.log("失败:", (e as Error).message);
      }
      ask();
      return;
    }

    console.log("支持指令: 打开X / 点击 X|Y");
    ask();
  });
}

console.log("终端 CLI 测试 — 输入「打开微信」「点击 微信|输入框」等");
console.log("输入 quit 退出\n");
ask();
