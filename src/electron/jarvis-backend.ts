/**
 * Jarvis 后端进程 — 通过 IPC message 接收 Electron 指令，调用 parseIntent 后返回结果
 * 运行在独立的 Node.js 子进程中，避免 Electron 主进程加载重模块
 */
import "dotenv/config";
import { parseIntent, type ConversationMessage } from "../../src/jarvis/parseIntent.js";

const conversationHistory: ConversationMessage[] = [];

process.on("message", async (msg: unknown) => {
  const m = msg as { id?: string; command?: string };
  if (!m.id || !m.command) return;

  try {
    const intent = await parseIntent(m.command, conversationHistory);
    conversationHistory.push({ role: "user", content: m.command });

    if (intent) {
      conversationHistory.push({ role: "assistant", content: `执行: ${intent.kind}` });
      process.send?.({ id: m.id, result: { ok: true, intent } });
    } else {
      conversationHistory.push({ role: "assistant", content: "未识别" });
      process.send?.({ id: m.id, result: { ok: false, error: "无法识别指令" } });
    }
  } catch (e) {
    process.send?.({ id: m.id, result: { ok: false, error: (e as Error).message } });
  }
});

console.log("[jarvis-backend] 后端进程已启动");
