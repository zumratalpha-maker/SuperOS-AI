/**
 * Learn UI 服务 — 语音+视觉学习系统的本地 HTTP 后端
 * 用法：npm run learn:ui
 *
 * F12 热键：在目标窗口上把光标移到要学习的按钮 → 按 F12 → 切回本页说「这是XXX按钮」
 * 避免点击输入导致焦点切到浏览器。
 */

import express, { type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadKnowledge, teachFeature } from "./knowledgeStore.js";
import {
  getForegroundWindowAndCursor,
  getWindowUnderCursor,
  screenshotWindowToBase64,
  clickByName,
} from "../tools/directShellBridge.js";
import { appendLearnedAction } from "../tools/learnedActions.js";
import { resolveAndLaunch } from "../tools/appExecutor.js";
import { visionChatCompletion } from "../llm/apiClient.js";
import { VISION_LLM } from "../config/llmConfig.js";
import { preloadOcrWorker } from "../tools/ocrBridge.js";
import { createTask, runNextTask } from "../agents/orchestrator.js";
import { a11ySequenceStep } from "../runA11ySequence.js";
import {
  parseIntent,
  extractWeChatSendInfo,
  isWeChatSendFlow,
  hasMessageInWeChatFlow,
  injectWeChatMessage,
  ensureWeChatSearchFlowWithContact,
  fixWeChatOpenAppStep,
} from "../jarvis/parseIntent.js";

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "1mb" }));

/** 包装 async 路由，确保未捕获错误传给 Express 错误处理，避免返回 HTML 导致前端 "Unexpected token '<'" */
function runAsync(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (e?: unknown) => void) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** F12 触发时缓存的位置（避免点击 UI 抢焦点） */
let lastF12Capture: {
  windowTitle: string;
  xRel: number;
  yRel: number;
  ts: number;
} | null = null;

/** F11 触发时缓存的描述（看看画面用） */
let lastF11Describe: { windowTitle: string; description: string; ts: number } | null = null;

/** 启动 F11/F12 热键监听（PowerShell GetAsyncKeyState 轮询） */
function startHotkeyListener(): void {
  if (process.platform !== "win32") return;
  const script = [
    "$vkF11 = 0x7A; $vkF12 = 0x7B",
    "$lastF11 = 0; $lastF12 = 0",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class K {",
    '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);',
    "}",
    "'@",
    "while ($true) {",
    "  $now = [Environment]::TickCount",
    "  if (([K]::GetAsyncKeyState($vkF11) -band 0x8000) -ne 0 -and ($now - $lastF11) -gt 500) {",
    '    Write-Output "F11_TRIGGER"; $lastF11 = $now',
    "  }",
    "  if (([K]::GetAsyncKeyState($vkF12) -band 0x8000) -ne 0 -and ($now - $lastF12) -gt 500) {",
    '    Write-Output "F12_TRIGGER"; $lastF12 = $now',
    "  }",
    "  Start-Sleep -Milliseconds 60",
    "}",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  child.stdout?.on("data", async (d: Buffer) => {
    const s = String(d);
    if (s.includes("F11_TRIGGER")) {
      try {
        const snap = await getForegroundWindowAndCursor();
        if (snap) {
          const b64 = await screenshotWindowToBase64(snap.hwnd);
          if (b64) {
            const desc = await visionChatCompletion({
              ...VISION_LLM,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "简要描述这张截图中的界面：是什么应用、有哪些可点击的按钮或区域。用一两句话。若有中文界面请用中文回答。" },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
                  ],
                },
              ],
              maxTokens: 256,
              timeoutMs: 15000,
              jsonMode: false,
            });
            lastF11Describe = { windowTitle: snap.windowTitle, description: desc?.trim() ?? "", ts: Date.now() };
            console.log(`[learn-ui] F11 已描述: ${snap.windowTitle}`);
          }
        }
      } catch (e) {
        console.error("[learn-ui] F11 描述失败:", e);
      }
    }
    if (s.includes("F12_TRIGGER")) {
      try {
        const snap = await getForegroundWindowAndCursor();
        if (snap) {
          lastF12Capture = {
            windowTitle: snap.windowTitle,
            xRel: snap.xRel,
            yRel: snap.yRel,
            ts: Date.now(),
          };
          console.log(`[learn-ui] F12 已记录: ${snap.windowTitle} (${snap.xRel.toFixed(2)}, ${snap.yRel.toFixed(2)})`);
        }
      } catch (e) {
        console.error("[learn-ui] F12 捕获失败:", e);
      }
    }
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));
  child.on("error", (e) => console.error("[learn-ui] F12 监听异常:", e));
}

/** GET /api/last-describe — 最近一次 F11 描述的界面 */
app.get("/api/last-describe", (_req: Request, res: Response) => {
  const maxAge = 120_000;
  if (!lastF11Describe || Date.now() - lastF11Describe.ts > maxAge) {
    return res.json({ ok: false, error: "无有效 F11 记录，请先在目标窗口按 F11" });
  }
  return res.json({
    ok: true,
    windowTitle: lastF11Describe.windowTitle,
    description: lastF11Describe.description,
    ts: lastF11Describe.ts,
  });
});

/** GET /api/last-capture — 最近一次 F12 记录的位置 */
app.get("/api/last-capture", (_req: Request, res: Response) => {
  const maxAge = 120_000; // 2 分钟内有效
  if (!lastF12Capture || Date.now() - lastF12Capture.ts > maxAge) {
    return res.json({ ok: false, error: "无有效 F12 记录，请先在目标窗口按 F12" });
  }
  return res.json({
    ok: true,
    windowTitle: lastF12Capture.windowTitle,
    xRel: lastF12Capture.xRel,
    yRel: lastF12Capture.yRel,
    ts: lastF12Capture.ts,
  });
});

/** POST /api/describe — 截图当前前台窗口，Vision 描述画面 */
app.post("/api/describe", async (_req: Request, res: Response) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getForegroundWindowAndCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取前台窗口" });
    const b64 = await screenshotWindowToBase64(snap.hwnd);
    if (!b64) return res.json({ ok: false, error: "截图失败" });
    const desc = await visionChatCompletion({
      ...VISION_LLM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "简要描述这张截图中的界面：是什么应用、有哪些可点击的按钮或区域。用一两句话。若有中文界面请用中文回答。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
      maxTokens: 256,
      timeoutMs: 15000,
      jsonMode: false,
    });
    return res.json({ ok: true, description: desc?.trim() ?? "", windowTitle: snap.windowTitle });
  } catch (e) {
    console.error("[learn-ui] describe:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/teach — 记录功能与坐标 */
app.post("/api/teach", async (req: Request, res: Response) => {
  try {
    const { app, feature, xRel, yRel, context } = req.body as {
      app?: string;
      feature?: string;
      xRel?: number;
      yRel?: number;
      context?: string;
    };
    if (!app || !feature || xRel == null || yRel == null) {
      return res.json({ ok: false, error: "缺少 app/feature/xRel/yRel" });
    }
    await teachFeature(app, feature, xRel, yRel, context);
    await appendLearnedAction({ target: `${app}|${feature}`, xRel, yRel, ts: Date.now(), context });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[learn-ui] teach:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** GET /api/foreground — 当前前台窗口+光标相对坐标 */
app.get("/api/foreground", async (_req: Request, res: Response) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getForegroundWindowAndCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取" });
    return res.json({
      ok: true,
      windowTitle: snap.windowTitle,
      xRel: snap.xRel,
      yRel: snap.yRel,
    });
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
});

/** GET /api/cursor-window — 光标下的窗口与相对坐标（不依赖前台焦点，纯对话可用） */
app.get("/api/cursor-window", async (_req, res) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getWindowUnderCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取光标下的窗口" });
    return res.json({
      ok: true,
      windowTitle: snap.windowTitle,
      xRel: snap.xRel,
      yRel: snap.yRel,
    });
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/describe-cursor — 截取光标下窗口并 Vision 描述（不依赖前台） */
app.post("/api/describe-cursor", async (_req, res) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getWindowUnderCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取光标下的窗口" });
    const b64 = await screenshotWindowToBase64(snap.hwnd);
    if (!b64) return res.json({ ok: false, error: "截图失败" });
    const desc = await visionChatCompletion({
      ...VISION_LLM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "简要描述这张截图中的界面：是什么应用、有哪些可点击的按钮或区域。用一两句话。若有中文界面请用中文回答。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
      maxTokens: 256,
      timeoutMs: 15000,
      jsonMode: false,
    });
    return res.json({ ok: true, description: desc?.trim() ?? "", windowTitle: snap.windowTitle });
  } catch (e) {
    console.error("[learn-ui] describe-cursor:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** GET /api/cursor-window — 光标下的窗口与相对坐标（不依赖前台，纯对话流程） */
app.get("/api/cursor-window", async (_req, res) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getWindowUnderCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取光标下的窗口" });
    return res.json({
      ok: true,
      windowTitle: snap.windowTitle,
      xRel: snap.xRel,
      yRel: snap.yRel,
    });
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/describe-cursor — 截取光标下窗口并 Vision 描述 */
app.post("/api/describe-cursor", async (_req, res) => {
  if (process.platform !== "win32") {
    return res.json({ ok: false, error: "仅支持 Windows" });
  }
  try {
    const snap = await getWindowUnderCursor();
    if (!snap) return res.json({ ok: false, error: "无法获取光标下的窗口" });
    const b64 = await screenshotWindowToBase64(snap.hwnd);
    if (!b64) return res.json({ ok: false, error: "截图失败" });
    const desc = await visionChatCompletion({
      ...VISION_LLM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "简要描述这张截图中的界面：是什么应用、有哪些可点击的按钮或区域。用一两句话。若有中文界面请用中文回答。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
      maxTokens: 256,
      timeoutMs: 15000,
      jsonMode: false,
    });
    return res.json({ ok: true, description: desc?.trim() ?? "", windowTitle: snap.windowTitle });
  } catch (e) {
    console.error("[learn-ui] describe-cursor:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** GET /api/knowledge */
app.get("/api/knowledge", async (_req, res) => {
  try {
    const k = await loadKnowledge();
    return res.json(k);
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/open-app — 打开应用（open_target，如 打开微信） */
app.post("/api/open-app", async (req, res) => {
  try {
    const { targetName } = req.body as { targetName?: string };
    if (!targetName || !String(targetName).trim())
      return res.json({ ok: false, error: "缺少 targetName" });
    const result = await resolveAndLaunch(String(targetName).trim());
    return res.json({ ok: result.ok, error: result.error });
  } catch (e) {
    console.error("[learn-ui] open-app:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/execute — 按知识库执行 click */
app.post("/api/execute", async (req, res) => {
  try {
    const { app, feature } = req.body as { app?: string; feature?: string };
    if (!app || !feature) return res.json({ ok: false, error: "缺少 app/feature" });
    const target = `${app}|${feature}`;
    const result = await clickByName(target);
    return res.json({ ok: result.done });
  } catch (e) {
    console.error("[learn-ui] execute:", e);
    return res.json({ ok: false, error: String(e) });
  }
});

/** POST /api/chat — 复合指令（如 打开微信给阿尔法发消息说 我很忙）走 jarvis 解析 + a11y 执行 */
app.post("/api/chat", runAsync(async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    const input = (text ?? "").trim();
    if (!input) {
      res.json({ ok: false, error: "缺少 text" });
      return;
    }

    const intent = await parseIntent(input, []);
    if (!intent || intent.kind !== "a11y_sequence") {
      res.json({
        ok: false,
        error: "无法解析为可执行步骤，请说例如：打开微信给阿尔法发消息说 我很忙",
      });
      return;
    }

    let steps = intent.steps;
    const wechatInfo = extractWeChatSendInfo(input);
    if (wechatInfo?.message && isWeChatSendFlow(steps)) {
      steps = injectWeChatMessage(steps, wechatInfo.message);
      (intent as { steps: typeof steps }).steps = steps;
    }
    if (isWeChatSendFlow(steps) && !hasMessageInWeChatFlow(steps)) {
      res.json({
        ok: false,
        needsMessage: true,
        error: "要发什么内容？请再说完整，如：给阿尔法发消息说 我很忙",
      });
      return;
    }
    if (wechatInfo?.contact && isWeChatSendFlow(steps)) {
      steps = fixWeChatOpenAppStep(steps, wechatInfo.contact);
      steps = ensureWeChatSearchFlowWithContact(steps, wechatInfo.contact);
      (intent as { steps: typeof steps }).steps = steps;
    }

    createTask({ kind: "a11y_sequence", steps });
    await runNextTask(a11ySequenceStep, {
      stepTimeoutMs: 90000,
      useStepFallback: false,
    });
    return res.json({ ok: true, message: "已执行" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[learn-ui] chat:", e);
    return res.json({ ok: false, error: msg.slice(0, 120) || "执行失败" });
  }
}));

/** 静态文件（放在 API 之后，确保 POST /api/chat 等先被匹配） */
app.use(express.static(join(process.cwd(), "src", "learn-ui", "public")));

/** 全局错误处理：确保所有错误都返回 JSON，避免前端解析 HTML 时报 Unexpected token '<' */
app.use((err: unknown, _req: Request, res: Response, _next: () => void) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[learn-ui] 未捕获错误:", err);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: msg.slice(0, 120) || "服务器异常" });
  }
});

/** 404：返回 JSON 而非 HTML */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "接口不存在" });
});

const PORT = Number(process.env.LEARN_UI_PORT) || 3856;

app.listen(PORT, () => {
  console.log(`Learn UI: http://localhost:${PORT}`);
  startHotkeyListener();
  console.log("F11/F12 热键已启用：F11=描述画面，F12=记录位置");
  preloadOcrWorker().catch(() => {});
});
