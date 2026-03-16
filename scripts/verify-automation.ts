/**
 * 终端验证脚本 — 无需网页/语音，直接验证自动化能力
 * 用法：tsx scripts/verify-automation.ts [命令]
 * 命令：open-wechat | open-jianying | click-wechat-input | click-jianying-export | wechat-send
 */

import "dotenv/config";
import { resolveAndLaunch } from "../src/tools/appExecutor.js";
import {
  findWindowByName,
  clickByName,
  focusWeChatInputBox,
  bringWindowToFront,
} from "../src/tools/directShellBridge.js";
import { createTask, runNextTask } from "../src/agents/orchestrator.js";
import { a11ySequenceStep } from "../src/runA11ySequence.js";
import {
  parseIntent,
  extractWeChatSendInfo,
  isWeChatSendFlow,
  hasMessageInWeChatFlow,
  injectWeChatMessage,
  ensureWeChatSearchFlowWithContact,
  fixWeChatOpenAppStep,
} from "../src/jarvis/parseIntent.js";

async function main(): Promise<void> {
  const cmd = process.argv[2]?.toLowerCase().trim() || "help";
  console.log("[verify] 执行:", cmd);

  if (cmd === "help") {
    console.log(`
用法: tsx scripts/verify-automation.ts <命令> [参数]

命令:
  open-wechat        打开微信
  open-jianying      打开剪映
  click-wechat-input 聚焦微信输入框（需先打开微信并进入聊天）
  click-jianying-export 点击剪映导出按钮（需先打开剪映编辑界面）
  click-jianying-import 点击剪映导入（需先打开剪映）
  wechat-send <联系人> <消息>  发微信（例：wechat-send 阿尔法 我很忙）
  notepad-poem [保存路径]  打开记事本写诗并保存（默认 D:\\，例：notepad-poem D:\\）
`);
    return;
  }

  if (cmd === "open-wechat") {
    const r = await resolveAndLaunch("微信");
    console.log(r.ok ? "[OK] 微信已启动" : "[FAIL] " + (r.error ?? "未知"));
    return;
  }

  if (cmd === "open-jianying") {
    const r = await resolveAndLaunch("剪映");
    console.log(r.ok ? "[OK] 剪映已启动" : "[FAIL] " + (r.error ?? "未知"));
    return;
  }

  if (cmd === "click-wechat-input") {
    const info = await findWindowByName("微信");
    if (!info?.nativeWindowHandle) {
      console.log("[FAIL] 未找到微信窗口，请先打开微信并进入任意聊天");
      return;
    }
    const hwnd = Number(info.nativeWindowHandle);
    await bringWindowToFront(hwnd);
    await new Promise((r) => setTimeout(r, 800));
    const ok = await focusWeChatInputBox(hwnd, "微信");
    console.log(ok ? "[OK] 微信输入框已聚焦" : "[FAIL] 聚焦失败");
    return;
  }

  if (cmd === "click-jianying-export") {
    const r = await clickByName("剪映|导出");
    console.log(r.done ? "[OK] 剪映导出已点击" : "[FAIL] 未完成");
    return;
  }

  if (cmd === "click-jianying-import") {
    const r = await clickByName("剪映|导入");
    console.log(r.done ? "[OK] 剪映导入已点击" : "[FAIL] 未完成");
    return;
  }

  if (cmd === "wechat-send") {
    const contact = process.argv[3]?.trim();
    const message = process.argv.slice(4).join(" ").trim();
    if (!contact || !message) {
      console.log("[FAIL] 用法: wechat-send <联系人> <消息>");
      console.log("  例: npx tsx scripts/verify-automation.ts wechat-send 阿尔法 我很忙");
      return;
    }
    const input = `打开微信给${contact}发消息说 ${message}`;
    try {
      const intent = await parseIntent(input, []);
      if (!intent || intent.kind !== "a11y_sequence") {
        console.log("[FAIL] 解析失败，请确认 Ollama 已启动");
        return;
      }
      let steps = intent.steps;
      const wechatInfo = extractWeChatSendInfo(input);
      if (wechatInfo?.message && isWeChatSendFlow(steps)) {
        steps = injectWeChatMessage(steps, wechatInfo.message);
      }
      if (isWeChatSendFlow(steps) && !hasMessageInWeChatFlow(steps)) {
        console.log("[FAIL] 缺少消息内容");
        return;
      }
      if (wechatInfo?.contact && isWeChatSendFlow(steps)) {
        steps = fixWeChatOpenAppStep(steps, wechatInfo.contact);
        steps = ensureWeChatSearchFlowWithContact(steps, wechatInfo.contact);
      }
      createTask({ kind: "a11y_sequence", steps });
      await runNextTask(a11ySequenceStep, { stepTimeoutMs: 90000, useStepFallback: false });
      console.log("[OK] 已执行：给", contact, "发", message);
    } catch (e) {
      console.error("[FAIL]", e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (cmd === "notepad-poem") {
    const savePath = process.argv[3]?.trim() || "D:\\";
    const input = `打开记事本写一首诗保存到${savePath.replace(/\\+$/, "")}`;
    try {
      const intent = await parseIntent(input, []);
      if (!intent || intent.kind !== "a11y_sequence") {
        console.log("[FAIL] 解析失败，请确认 Ollama 已启动");
        return;
      }
      createTask({ kind: "a11y_sequence", steps: intent.steps });
      await runNextTask(a11ySequenceStep, { stepTimeoutMs: 90000, useStepFallback: false });
      console.log("[OK] 已执行：记事本写诗保存到", savePath);
    } catch (e) {
      console.error("[FAIL]", e instanceof Error ? e.message : String(e));
    }
    return;
  }

  console.log("[FAIL] 未知命令，运行无参数查看帮助");
}

main().catch((e) => {
  console.error("[verify] 异常:", e);
  process.exit(1);
});
