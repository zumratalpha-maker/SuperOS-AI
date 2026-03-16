/**
 * 剪映学习模式：在剪映上点击后按 F12 记录（无需切回终端），写入 learned_actions.jsonl
 * 用法：npm run learn:jianying
 * 流程：光标移到要学习的按钮上 → 按 F12 → 切回终端输入语义 → Ctrl+C 退出
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getForegroundWindowAndCursor } from "../src/tools/directShellBridge.js";
import { appendLearnedAction } from "../src/tools/learnedActions.js";

const JIANYING_PRESETS = ["开始创作", "开始创作(弹窗)", "导入", "导出", "导出设置"];

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer ?? "").trim()));
  });
}

function toEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** 启动 F12 热键监听（PowerShell GetAsyncKeyState 轮询），触发时输出 TRIGGER */
function startF12Listener(): { child: ReturnType<typeof spawn>; nextTrigger: () => Promise<void> } {
  const script = [
    "$vkF12 = 0x7B",
    "$last = 0",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class K {",
    '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);',
    "}",
    "'@",
    "while ($true) {",
    "  $s = [K]::GetAsyncKeyState($vkF12)",
    "  if (($s -band 0x8000) -ne 0) {",
    "    $now = [Environment]::TickCount",
    "    if (($now - $last) -gt 500) {",
    '      Write-Output "TRIGGER"',
    "      $last = $now",
    "    }",
    "  }",
    "  Start-Sleep -Milliseconds 60",
    "}",
  ].join("\r\n");
  const encoded = toEncodedCommand(script);
  const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  const nextTrigger = (): Promise<void> =>
    new Promise((resolve) => {
      const onData = (d: Buffer) => {
        if (String(d).includes("TRIGGER")) {
          child.stdout?.off("data", onData);
          resolve();
        }
      };
      child.stdout?.on("data", onData);
    });
  return { child, nextTrigger };
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (process.platform !== "win32") {
    console.log("学习模式仅支持 Windows");
    rl.close();
    return;
  }

  const { child, nextTrigger } = startF12Listener();
  child.stderr?.on("data", (d) => process.stderr.write(d));
  child.on("error", (e) => console.error("F12 监听异常:", e));
  process.on("SIGINT", () => {
    child.kill();
    rl.close();
    process.exit(0);
  });

  console.log("剪映学习模式（F12 全局热键）\n");
  console.log("  1. 在剪映上点击要学习的按钮，保持光标在按钮上");
  console.log("  2. 按 F12 记录（无需切到本终端）");
  console.log("  3. 切回本终端，输入语义后回车");
  console.log("  4. Ctrl+C 退出\n");

  while (true) {
    process.stdout.write("等待 F12… ");
    await nextTrigger();
    console.log("已触发");

    const snap = await getForegroundWindowAndCursor();
    if (!snap) {
      console.log("  [跳过] 无法获取前台窗口与光标\n");
      continue;
    }

    const isJianying = /剪映|JianyingPro|CapCut/i.test(snap.windowTitle);
    const prefix = isJianying ? "剪映|" : "";

    console.log(`  窗口: ${snap.windowTitle}`);
    console.log(`  坐标: xRel=${snap.xRel.toFixed(3)} yRel=${snap.yRel.toFixed(3)}`);
    if (isJianying) {
      console.log(`  预设: ${JIANYING_PRESETS.map((p, i) => `${i + 1})${p}`).join(" ")}`);
    }

    const raw = await question(
      rl,
      `  输入语义 (${prefix}xxx，直接 Enter 用默认): `
    );
    if (!raw && !isJianying) {
      console.log("  [跳过] 非剪映窗口且未输入语义\n");
      continue;
    }

    const semantic = raw || (isJianying ? JIANYING_PRESETS[0] : "unknown");
    const target = semantic.includes("|") ? semantic : (prefix ? prefix + semantic : semantic);

    try {
      await appendLearnedAction({
        target,
        xRel: snap.xRel,
        yRel: snap.yRel,
        ts: Date.now(),
        windowTitle: snap.windowTitle,
      });
      console.log(`  [已记录] ${target}\n`);
    } catch (e) {
      console.error("  写入失败:", e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
