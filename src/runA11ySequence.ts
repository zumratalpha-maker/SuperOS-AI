/**
 * A11y 多步链执行器：全域上帝视角闭环
 * 找-切-做 (Search-Switch-Act)：findWindowByName -> bringWindowToFront(hwnd) -> clickByName/typeText(targetHwnd)
 * 保存对话框状态迁移：triggeredSave 后下一步前 findWindowByName("另存为") 锁定对话框 hwnd
 */

import type { ExecuteStepFn, A11ySequencePayload, A11yStep } from "./agents/orchestrator.js";
import { resolveTarget } from "./config/appRegistry.js";
import { resolveAndLaunch } from "./tools/appExecutor.js";
import { chatCompletion } from "./llm/apiClient.js";
import { LOCAL_LLM, CLOUD_LLM } from "./config/llmConfig.js";
import { CLICK_JIANYING_MODAL_START } from "./pipeline/jianyingSteps.js";
import {
  findWindowByName,
  findSaveDialogHwnd,
  findExportDialogHwnd,
  findOpenDialogHwnd,
  bringWindowToFront,
  maximizeWindow,
  clickByName,
  dismissJianyingProjectModal,
  typeText,
  scroll,
  drag,
  sendKeys,
  focusWeChatInputBox,
  setClipboardOnly,
  getExecutionTimingConfig,
  getProcessIdsByProcessName,
  useSuperEye,
} from "./tools/directShellBridge.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 步骤间状态：主窗 PID/名称/hwnd、保存对话框 hwnd、是否刚触发保存 */
export interface StepState {
  /** 上一步 open_app 或当前链路的主窗口进程 ID，用于双屏/多窗精准匹配 */
  lastWindowPid?: number;
  /** 主窗口标题名（如「记事本」），供 findWindowByName 使用 */
  lastWindowName?: string;
  /** 主窗口 hwnd：open_app 后缓存，后续 type/click 直接复用，避免重复 findWindowByName */
  lastWindowHwnd?: number;
  /** 若上一步 triggeredSave，本步前已解析出的「另存为」对话框 hwnd */
  saveDialogHwnd?: number;
  /** 上一步是否触发了 Ctrl+S，本步前需等 1.5s 并重新 find 另存为窗口 */
  lastTriggeredSave?: boolean;
  /** 发微信流程阶段：search=在搜索框搜人，input=在消息输入框输入；用于区分 type 联系人 vs type 消息 */
  weChatPhase?: "search" | "input";
  /** 上一步为 click 输入 且已成功聚焦，本步 type 消息时无需再 focusWeChatInputBox */
  weChatInputJustFocused?: boolean;
  /** 剪贴板已预填（keys ^f 时预填下一步 type 内容），本步 type 可跳过 setClipboard */
  clipboardPreFilled?: string;
  /** 剪映导出流程：上一步 click 导出（主窗）后，本步前已解析出的「导出」对话框 hwnd */
  exportDialogHwnd?: number;
  /** 上一步是否在剪映主窗点击了 导出，本步前需等待并 find 导出对话框 */
  lastClickedExport?: boolean;
  /** 剪映导入流程：上一步 click 导入（主窗）后，本步前已解析出的「打开」对话框 hwnd */
  importDialogHwnd?: number;
  /** 上一步是否在剪映主窗点击了 导入，本步前需等待并 find 打开对话框 */
  lastClickedImport?: boolean;
}

/** 应用名 → 窗口标题可能包含的关键字（中/英文系统），open_app 后查窗时依次尝试；Win11 新记事本可能仅「无标题」 */
const WINDOW_NAME_ALIASES: Record<string, string[]> = {
  记事本: ["记事本", "Notepad", "无标题"],
  计算器: ["计算器", "Calculator"],
  画图: ["画图", "Paint", "Mspaint"],
  资源管理器: ["资源管理器", "Explorer", "此电脑", "This PC"],
  微信: ["微信", "WeChat", "wechat"],
  Excel: ["Excel", "Microsoft Excel", "工作簿"],
  WPS: ["WPS", "WPS Office", "ET", "WPP", "金山"],
  剪映: ["剪映", "JianyingPro", "Jianying"],
  CapCut: ["CapCut", "capcut"],
  Word: ["Word", "Microsoft Word", "文档", "Document", "WINWORD", "无标题"],
  "Microsoft Word": ["Word", "Microsoft Word", "文档", "Document", "WINWORD", "无标题"],
  // 网页（open_app 打开 URL 后，浏览器窗口标题通常含页面名）
  豆包: ["豆包", "Doubao", "图片生成"],
  通义万相: ["万相", "通义万相", "wanxiang", "Wanxiang", "阿里云", "领先的AI", "通义", "AI视频与图像"],
  Gemini: ["Gemini", "Google AI"],
  可灵: ["可灵", "Kling", "klingai"],
  即梦: ["即梦", "Jimeng", "jimeng"],
};

function isA11ySequencePayload(p: unknown): p is A11ySequencePayload {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return x.kind === "a11y_sequence" && Array.isArray(x.steps) && x.steps.length > 0;
}

/** 判断 type 的 text 是否像文件名（用于链补全）；含扩展名或以短名为主 */
function looksLikeFilename(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 80) return false;
  return /\.(txt|md|json|log|csv|html|xml|pdf|mp4|mov|mkv|avi)$/i.test(t) || (t.length <= 40 && /^[\w\u4e00-\u9fa5.\-]+$/.test(t));
}

/** 是否像视频文件名（剪映导出链补全） */
function looksLikeVideoFilename(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 80) return false;
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(t) || (t.length <= 40 && /^[\w\u4e00-\u9fa5.\-]+$/.test(t));
}

/** 是否为发微信流程（open_app 微信 + 有 type 消息步） */
function isWeChatSendFlow(steps: A11yStep[]): boolean {
  const hasWeChat = steps.some((s) => s.type === "open_app" && /微信|WeChat/i.test((s as { app?: string }).app ?? ""));
  const hasType = steps.some((s) => s.type === "type" && (s as { text?: string }).text?.trim());
  return hasWeChat && hasType;
}

/** 发微信流程末端是否已有发送动作（keys Enter 或 click 发送）——必须在 type 消息之后，不能把「选中联系人」的 Enter 算作发送 */
function hasWeChatSendStep(steps: A11yStep[]): boolean {
  const wechatIdx = steps.findIndex((s) => s.type === "open_app" && /微信|WeChat/i.test((s as { app?: string }).app ?? ""));
  if (wechatIdx < 0) return false;
  let lastMsgTypeIdx = -1;
  for (let i = wechatIdx + 1; i < steps.length; i++) {
    if (steps[i].type === "type" && (steps[i] as { text?: string }).text?.trim()) lastMsgTypeIdx = i;
  }
  if (lastMsgTypeIdx < 0) return false;
  return steps.slice(lastMsgTypeIdx + 1).some(
    (s) =>
      (s.type === "keys" && ((s as { keys?: string }).keys ?? "").includes("ENTER")) ||
      (s.type === "click" && /^(发送|Send)$/i.test((s as { name?: string }).name ?? ""))
  );
}

/** 菜单/按钮名（非联系人）：click 这些时不做搜索替换 */
const WECHAT_MENU_NAMES = /^(保存|另存为|发送|文件|编辑|查看|发送|Send|Save|File|Edit|View)$/i;

/** 是否已有微信搜索流程（keys ^f），避免重复插入 */
function hasWeChatSearchFlow(steps: A11yStep[]): boolean {
  return steps.some((s) => s.type === "keys" && ((s as { keys?: string }).keys ?? "").includes("f"));
}

/** 发微信：将 click 联系人 或 type 联系人+type 消息 替换为 搜索流程（Ctrl+F → 输入联系人 → Enter），因 UIA 不暴露联系列表 */
function applyWeChatSearchFlow(steps: A11yStep[]): A11yStep[] {
  const wechatIdx = steps.findIndex((s) => s.type === "open_app" && /微信|WeChat/i.test((s as { app?: string }).app ?? ""));
  if (wechatIdx < 0) return steps;
  if (hasWeChatSearchFlow(steps)) return steps; // 已有搜索流程，不重复插入

  // 情况 1：click 联系人 → 替换为 keys ^f + type 联系人 + keys Enter
  for (let i = wechatIdx + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "click") {
      const name = (s as { name?: string }).name?.trim() ?? "";
      if (!name || WECHAT_MENU_NAMES.test(name)) continue;
      const hasTypeAfter = steps.slice(i + 1).some((x) => x.type === "type" && (x as { text?: string }).text?.trim());
      if (!hasTypeAfter) continue;
      const out = [...steps.slice(0, i), { type: "keys" as const, keys: "^f" }, { type: "type" as const, text: name }, { type: "keys" as const, keys: "{ENTER}" }, ...steps.slice(i + 1)];
      console.log("[runA11ySequence] 微信搜索流程：click 联系人 替换为 Ctrl+F → type " + name + " → Enter");
      return out;
    }
  }

  // 情况 2：type 联系人 + type 消息（云端可能产出两个 type，无 click）→ 在第一个 type 前插 Ctrl+F，后插 Enter
  const typeIndices: number[] = [];
  for (let i = wechatIdx + 1; i < steps.length; i++) {
    if (steps[i].type === "type" && (steps[i] as { text?: string }).text?.trim()) typeIndices.push(i);
  }
  if (typeIndices.length >= 2) {
    const first = typeIndices[0];
    const contact = (steps[first] as { text?: string }).text?.trim() ?? "";
    const out = [
      ...steps.slice(0, first),
      { type: "keys" as const, keys: "^f" },
      steps[first],
      { type: "keys" as const, keys: "{ENTER}" },
      ...steps.slice(first + 1),
    ];
    console.log("[runA11ySequence] 微信搜索流程：type 联系人+消息 插入 Ctrl+F → type " + contact + " → Enter");
    return out;
  }

  return steps;
}

/** 发微信：选中联系人（keys Enter）后、type 消息前插入 click 输入 聚焦输入框（多策略：点击 → Tab → 坐标） */
function insertWeChatInputFocus(steps: A11yStep[]): A11yStep[] {
  const wechatIdx = steps.findIndex((s) => s.type === "open_app" && /微信|WeChat/i.test((s as { app?: string }).app ?? ""));
  if (wechatIdx < 0) return steps;
  for (let i = wechatIdx + 1; i < steps.length - 1; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    if (s.type === "keys" && ((s as { keys?: string }).keys ?? "").includes("ENTER") && next?.type === "type") {
      const out = [...steps.slice(0, i + 1), { type: "click" as const, name: "输入" }, ...steps.slice(i + 1)];
      console.log("[runA11ySequence] 微信聚焦输入框：keys Enter 选中联系人后插入 click 输入（多策略兜底）");
      return out;
    }
  }
  return steps;
}

/** Chain 校验与补全：检测「触发另存为 → type 文件名」后缺失「click 保存」，自动补全；发微信 type 消息后缺失发送，自动追加 keys Enter */
function completeA11ySteps(steps: A11yStep[]): A11yStep[] {
  let result = applyWeChatSearchFlow(steps);
  result = insertWeChatInputFocus(result);
  for (let i = 0; i < result.length; i++) {
    const s = result[i];
    if (s.type === "click" && /^(保存|另存为|Save|Save As)$/i.test((s.name ?? "").trim())) {
      for (let j = i + 1; j < result.length; j++) {
        const t = result[j];
        if (t.type === "type" && looksLikeFilename(t.text ?? "")) {
          const hasClickSave = result.slice(j + 1).some(
            (x) => x.type === "click" && /^(保存|Save)$/i.test((x.name ?? "").trim())
          );
          if (!hasClickSave) {
            result.splice(j + 1, 0, { type: "click", name: "保存" });
            console.log("[runA11ySequence] 链补全：type 文件名后自动追加 click 保存");
            return result;
          }
          break;
        }
      }
      break;
    }
  }
  // 发微信：type 消息后若无 keys/click 发送，自动追加 Enter
  if (isWeChatSendFlow(result) && !hasWeChatSendStep(result)) {
    result = [...result, { type: "keys", keys: "{ENTER}" }];
    console.log("[runA11ySequence] 链补全：发微信 type 消息后自动追加 keys Enter");
  }
  // 剪映：open_app 剪映 后若无 click 开始创作，自动插入（用户说「打开剪映」意指进入编辑界面）
  const jianyingOpenIdx = result.findIndex((s) => s.type === "open_app" && /剪映|JianyingPro|CapCut/i.test((s as { app?: string }).app ?? ""));
  if (jianyingOpenIdx >= 0) {
    const next = result[jianyingOpenIdx + 1] as { type?: string; name?: string } | undefined;
    const nextIsStartCreating =
      next?.type === "click" && /(开始创作|Start\s*Creating)/i.test((next?.name ?? "").trim());
    if (!nextIsStartCreating) {
      result.splice(jianyingOpenIdx + 1, 0, { type: "click", name: "开始创作" });
      console.log("[runA11ySequence] 链补全：open_app 剪映 后自动插入 click 开始创作");
      return result;
    }
  }
  // 剪映导出：click 导出 + type 文件名 后若无 click 导出/确定，自动追加
  const jianyingIdx = result.findIndex((s) => s.type === "open_app" && /剪映|JianyingPro|CapCut/i.test((s as { app?: string }).app ?? ""));
  if (jianyingIdx >= 0) {
    for (let i = jianyingIdx + 1; i < result.length; i++) {
      const si = result[i] as { type: string; name?: string };
      if (si.type === "click" && /^(导出|Export)$/i.test((si.name ?? "").trim())) {
        for (let j = i + 1; j < result.length; j++) {
          const sj = result[j] as { type: string; text?: string };
          if (sj.type === "type" && (looksLikeVideoFilename(sj.text ?? "") || looksLikeFilename(sj.text ?? ""))) {
            const hasExportConfirm = result.slice(j + 1).some(
              (x) => (x as { type: string; name?: string }).type === "click" && /^(导出|确定|Export|OK)$/i.test(((x as { name?: string }).name ?? "").trim())
            );
            if (!hasExportConfirm) {
              result.splice(j + 1, 0, { type: "click", name: "导出" });
              console.log("[runA11ySequence] 链补全：剪映 type 文件名后自动追加 click 导出");
              return result;
            }
            break;
          }
        }
        break;
      }
    }
  }
  return result;
}

/** 解析 step.name 或 target 中的窗口部分（如 "记事本|保存" -> "记事本"） */
function parseWindowPart(nameOrTarget: string): string {
  const s = (nameOrTarget ?? "").trim();
  const pipe = s.indexOf("|");
  return pipe >= 0 ? s.slice(0, pipe).trim() : "";
}

/** 定位「另存为」对话框 hwnd；带重试（对话框弹出有延迟）；notepadPid 时子窗口兜底（Win11 另存为可能是 Notepad 子窗口） */
async function resolveSaveDialogHwnd(notepadPid?: number): Promise<number> {
  const maxAttempts = 6;
  const intervalMs = 280;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hwnd = await findSaveDialogHwnd(notepadPid);
    if (hwnd) return hwnd;
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  throw new Error("未找到另存为对话框，请重试");
}

/** 定位剪映「导出」对话框 hwnd；带重试（对话框弹出有延迟）；excludeHwnd 用于主窗与导出框同标题时排除主窗 */
async function resolveExportDialogHwnd(jianyingPid?: number, excludeHwnd?: number): Promise<number> {
  const maxAttempts = 10;
  const intervalMs = 400;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hwnd = await findExportDialogHwnd(jianyingPid, excludeHwnd);
    if (hwnd) return hwnd;
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  throw new Error("未找到导出对话框，请重试");
}

/** 定位剪映「打开」对话框 hwnd（导入素材后弹出）；带重试 */
async function resolveImportDialogHwnd(jianyingPid?: number): Promise<number> {
  const maxAttempts = 10;
  const intervalMs = 400;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hwnd = await findOpenDialogHwnd(jianyingPid);
    if (hwnd) return hwnd;
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  throw new Error("未找到打开对话框，请重试");
}

/** 应用名 → 进程名（open_app 优先新窗时用于获取启动前已有 PID） */
const APP_TO_PROCESS: Record<string, string> = {
  记事本: "Notepad",
  Notepad: "Notepad",
  微信: "WeChat",
  WeChat: "WeChat",
  Excel: "EXCEL",
  WPS: "wps",
  wps: "wps",
  剪映: "JianyingPro",
  JianyingPro: "JianyingPro",
  CapCut: "CapCut",
  capcut: "CapCut",
  Word: "WINWORD",
  "Microsoft Word": "WINWORD",
};

type RetryOpts = { maxAttempts?: number; intervalMs?: number } | undefined;

/** 按应用名查窗：先尝试原名再别名，带重试；excludePids 时优先匹配新启动的窗口；人类逻辑：窗口一出现就继续 */
async function findWindowByAppWithRetry(
  app: string,
  options?: { processId?: number; excludePids?: number[] },
  retryOpts?: RetryOpts
): Promise<{ processId: number; name: string; nativeWindowHandle: number } | null> {
  const appTrim = app.trim();
  if (useSuperEye()) {
    const info = await findWindowByName(appTrim, { ...options, app: appTrim });
    if (info?.nativeWindowHandle) {
      return {
        processId: info.processId,
        name: info.name,
        nativeWindowHandle: info.nativeWindowHandle,
      };
    }
    return null;
  }
  const namesToTry = [appTrim, ...(WINDOW_NAME_ALIASES[appTrim] ?? [])];
  const maxAttempts = retryOpts?.maxAttempts ?? 6;
  const intervalMs = retryOpts?.intervalMs ?? 180;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const name of namesToTry) {
      const info = await findWindowByName(name, options);
      if (info?.nativeWindowHandle) {
        return {
          processId: info.processId,
          name: info.name,
          nativeWindowHandle: info.nativeWindowHandle,
        };
      }
    }
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  return null;
}

/** 按窗口名查窗（type/click 用）：先原名再别名，兼容中/英文系统 */
async function findWindowByWindowNameWithAliases(
  windowName: string,
  options?: { processId?: number }
): Promise<{ processId: number; name: string; nativeWindowHandle: number } | null> {
  const namesToTry = [windowName.trim(), ...(WINDOW_NAME_ALIASES[windowName.trim()] ?? [])];
  for (const name of namesToTry) {
    const info = await findWindowByName(name, options);
    if (info?.nativeWindowHandle) {
      return {
        processId: info.processId,
        name: info.name,
        nativeWindowHandle: info.nativeWindowHandle,
      };
    }
  }
  return null;
}

/** 执行单步：找-切-做 闭环；findWindowByName 为 null 时抛错触发重试；opts.nextStep 用于预填剪贴板 */
async function executeOneStep(
  step: A11yStep,
  state?: StepState,
  opts?: { nextStep?: A11yStep }
): Promise<StepState> {
  const timing = getExecutionTimingConfig();
  const isWeChatFlow = /微信|WeChat/i.test(state?.lastWindowName ?? "");
  const stepCooldown = isWeChatFlow ? 30 : timing.stepCooldownMs;
  let next: StepState = {
    lastWindowPid: state?.lastWindowPid,
    lastWindowName: state?.lastWindowName,
    lastWindowHwnd: state?.lastWindowHwnd,
    saveDialogHwnd: state?.saveDialogHwnd,
    lastTriggeredSave: state?.lastTriggeredSave,
    weChatPhase: state?.weChatPhase,
    weChatInputJustFocused: state?.weChatInputJustFocused,
    clipboardPreFilled: state?.clipboardPreFilled,
    exportDialogHwnd: state?.exportDialogHwnd,
    lastClickedExport: state?.lastClickedExport,
    importDialogHwnd: state?.importDialogHwnd,
    lastClickedImport: state?.lastClickedImport,
  };

  if (next.lastClickedImport) {
    await delay(1200);
    next.lastClickedImport = false;
    try {
      // 可灵/即梦：浏览器触发的文件对话框无 parentPid，全窗口搜索
      const pidForOpenDialog = /可灵|即梦|Kling|Jimeng/i.test(next.lastWindowName ?? "")
        ? undefined
        : next.lastWindowPid;
      const dialogHwnd = await resolveImportDialogHwnd(pidForOpenDialog);
      next = { ...next, importDialogHwnd: dialogHwnd };
    } catch (e) {
      console.warn("[runA11ySequence] 未找到打开对话框，继续尝试:", (e as Error)?.message);
      next = { ...next, importDialogHwnd: undefined };
    }
  }

  if (next.lastClickedExport) {
    await delay(1200);
    next.lastClickedExport = false;
    try {
      const dialogHwnd = await resolveExportDialogHwnd(next.lastWindowPid, next.lastWindowHwnd);
      next = { ...next, exportDialogHwnd: dialogHwnd };
    } catch (e) {
      console.warn("[runA11ySequence] 未找到导出对话框，继续尝试:", (e as Error)?.message);
      next = { ...next, exportDialogHwnd: undefined };
    }
  }

  if (next.lastTriggeredSave) {
    await delay(timing.afterSaveShortcutMs);
    next.lastTriggeredSave = false;
    const dialogHwnd = await resolveSaveDialogHwnd(next.lastWindowPid);
    next = { ...next, saveDialogHwnd: dialogHwnd };
  }

  if (step.type === "wait") {
    const ms = (step as { ms?: number }).ms ?? 1000;
    await delay(ms);
    return next;
  }

  if (step.type === "open_app") {
    const appTrim = step.app.trim();
    const isWeChat = /^(微信|WeChat)$/i.test(appTrim);
    const isJianying = /^(剪映|JianyingPro|CapCut)$/i.test(appTrim);
    // 剪映：已运行则不再启动，只置顶，避免打开两次
    if (isJianying) {
      const existing = await findWindowByName(appTrim);
      if (existing?.nativeWindowHandle) {
        await bringWindowToFront(existing.nativeWindowHandle);
        next = {
          ...next,
          lastWindowPid: existing.processId,
          lastWindowName: appTrim,
          lastWindowHwnd: existing.nativeWindowHandle,
        };
        await delay(stepCooldown);
        return next;
      }
    }
    let excludePids: number[] = [];
    const procName = APP_TO_PROCESS[appTrim];
    if (procName && !isWeChat) {
      excludePids = await getProcessIdsByProcessName(procName);
    }
    const result = await resolveAndLaunch(step.app);
    if (!result.ok) {
      throw new Error(`打开应用失败: ${step.app} — ${result.error ?? "未知"}`);
    }
    // 网页应用：页面加载与标题更新需 2～5 秒，start "" url 可能在已有浏览器新标签打开，标题延迟出现
    const targetUrl = resolveTarget(appTrim);
    const isWebApp = !!targetUrl && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"));
    const isWord = /Word|word|WINWORD/i.test(appTrim);
    const openWaitMs = isWeChat ? 500 : isWebApp ? 2500 : isWord ? 2800 : Math.max(timing.afterOpenAppMs, 400);
    await delay(openWaitMs);
    const retryOpts = isWeChat
      ? { maxAttempts: 10, intervalMs: 150 }
      : isWebApp
        ? { maxAttempts: 12, intervalMs: 300 }
        : isWord
          ? { maxAttempts: 15, intervalMs: 300 }
          : undefined;
    let info = await findWindowByAppWithRetry(appTrim, { excludePids }, retryOpts);
    if (!info?.nativeWindowHandle && excludePids.length > 0) {
      info = await findWindowByAppWithRetry(appTrim, undefined, retryOpts);
    }
    if (!info?.nativeWindowHandle) {
      throw new Error(`未找到窗口: ${step.app}，请重试`);
    }
    const ok = await bringWindowToFront(info.nativeWindowHandle);
    if (!ok) throw new Error(`置顶失败: ${step.app}`);
    next = {
      ...next,
      lastWindowPid: info.processId,
      lastWindowName: step.app.trim(),
      lastWindowHwnd: info.nativeWindowHandle,
    };
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "type") {
    const skipClipboard = next.clipboardPreFilled === step.text;
    if (skipClipboard) next = { ...next, clipboardPreFilled: undefined };
    const typeOptsBase = skipClipboard ? { skipSetClipboard: true } : {};
    const dialogHwnd = next.saveDialogHwnd ?? next.exportDialogHwnd ?? next.importDialogHwnd;
    if (dialogHwnd != null && dialogHwnd !== 0) {
      await bringWindowToFront(dialogHwnd);
      const context =
        next.importDialogHwnd ? "open_dialog_filename"
        : next.exportDialogHwnd ? "export_dialog_filename"
        : "save_dialog_filename";
      await typeText(step.text, "", {
        targetHwnd: dialogHwnd,
        context,
        ...typeOptsBase,
      });
    } else {
      const windowName = next.lastWindowName ?? "";
      // 微信：仅当 phase=input 且上步非 click 输入 时才聚焦（click 输入 已 focus 过，避免重复 UiaSniper 重试）
      const isWeChatInputPhase = /微信|WeChat/i.test(windowName) && next.lastWindowHwnd != null && next.lastWindowHwnd !== 0 && next.weChatPhase === "input" && !next.weChatInputJustFocused;
      if (isWeChatInputPhase) {
        await focusWeChatInputBox(next.lastWindowHwnd!, windowName, {
          processId: next.lastWindowPid,
        });
        await delay(100);
      }
      if (next.weChatInputJustFocused) next = { ...next, weChatInputJustFocused: false };
      if (!windowName) {
        await typeText(step.text, "", typeOptsBase);
      } else if (next.lastWindowHwnd != null && next.lastWindowHwnd !== 0) {
        await bringWindowToFront(next.lastWindowHwnd);
        await typeText(step.text, `${windowName}|编辑`, {
          targetHwnd: next.lastWindowHwnd,
          processId: next.lastWindowPid,
          ...typeOptsBase,
        });
      } else {
        const info = await findWindowByWindowNameWithAliases(windowName, { processId: next.lastWindowPid });
        if (!info?.nativeWindowHandle) {
          throw new Error(`未找到窗口: ${windowName}，请重试`);
        }
        await bringWindowToFront(info.nativeWindowHandle);
        await typeText(step.text, `${windowName}|编辑`, {
          targetHwnd: info.nativeWindowHandle,
          processId: info.processId,
          ...typeOptsBase,
        });
      }
    }
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "generate_and_type") {
    const prompt = (step.prompt ?? "").trim();
    if (!prompt) {
      await delay(stepCooldown);
      return next;
    }
    const content = await chatCompletion({
      baseURL: LOCAL_LLM.baseURL,
      apiKey: LOCAL_LLM.apiKey,
      model: LOCAL_LLM.model,
      messages: [
        { role: "system", content: "只输出正文内容，不要 markdown、不要解释、不要 JSON 包裹。" },
        { role: "user", content: prompt },
      ],
      maxTokens: 4096,
      timeoutMs: 60000,
    });
    const text = (content ?? "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
    if (!text) {
      await delay(stepCooldown);
      return next;
    }
    const CHUNK_SIZE = 1800;
    const chunks: string[] = text.length <= CHUNK_SIZE ? [text] : [];
    if (chunks.length === 0) {
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }
    }
    const windowName = next.lastWindowName ?? "";
    for (let i = 0; i < chunks.length; i++) {
      if (next.lastWindowHwnd != null && next.lastWindowHwnd !== 0) {
        await bringWindowToFront(next.lastWindowHwnd);
        await typeText(chunks[i], windowName ? `${windowName}|编辑` : "", {
          targetHwnd: next.lastWindowHwnd,
          processId: next.lastWindowPid,
        });
      } else {
        await typeText(chunks[i]);
      }
      if (i < chunks.length - 1) await delay(80);
    }
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "click") {
    const isWeChatInputFocus =
      /^(输入|输入框|请输入)$/.test((step.name ?? "").trim()) &&
      /微信|WeChat/i.test(next.lastWindowName ?? "") &&
      next.lastWindowHwnd != null &&
      next.lastWindowHwnd !== 0;
    const isJianyingModalDismiss =
      (step.name ?? "").trim() === CLICK_JIANYING_MODAL_START &&
      /剪映|JianyingPro|CapCut/i.test(next.lastWindowName ?? "") &&
      next.lastWindowPid != null &&
      next.lastWindowPid > 0;
    if (isJianyingModalDismiss) {
      const mainHwnd = await dismissJianyingProjectModal(next.lastWindowPid!, next.lastWindowHwnd ?? 0);
      if (mainHwnd != null) {
        await maximizeWindow(mainHwnd);
        console.log("[runA11ySequence] 剪映进入创作界面后已最大化窗口");
        // 弹窗关闭后重新查窗，确保后续「导出」步骤有有效 hwnd（避免焦点失效）
        await delay(600);
        const fresh = await findWindowByName("剪映", { processId: next.lastWindowPid });
        const hwndToUse = fresh?.nativeWindowHandle ?? mainHwnd;
        await delay(stepCooldown);
        return { ...next, lastWindowHwnd: hwndToUse };
      }
      await delay(stepCooldown);
      return next;
    }
    if (isWeChatInputFocus) {
      await focusWeChatInputBox(next.lastWindowHwnd!, next.lastWindowName ?? "微信", {
        processId: next.lastWindowPid,
      });
      next = { ...next, weChatPhase: "input", weChatInputJustFocused: true };
      await delay(stepCooldown);
      return next;
    }
    let targetHwnd: number | undefined = next.saveDialogHwnd ?? next.exportDialogHwnd;
    if (targetHwnd == null || targetHwnd === 0) {
      const windowPart = parseWindowPart(step.name);
      const windowName = windowPart || next.lastWindowName || "";
      const isJianyingExport = /^(导出|Export)$/i.test((step.name ?? "").trim()) && /剪映|JianyingPro|CapCut/i.test(next.lastWindowName ?? "");
      const isJianyingImport = /^(导入|添加素材|Import|\+)$/i.test((step.name ?? "").trim()) && /剪映|JianyingPro|CapCut/i.test(next.lastWindowName ?? "");
      const isWebUpload = /^(上传|参考导入)$/i.test((step.name ?? "").trim()) && /可灵|即梦|Kling|Jimeng/i.test(next.lastWindowName ?? "");
      if (!windowName) {
        const clickTarget = next.lastWindowName
          ? `${next.lastWindowName}|${step.name}`
          : step.name;
        // 有 lastWindowHwnd 时传入，确保剪映等坐标优先分支能正确执行（不依赖 resolveTargetHwnd 二次解析）
        const result = await clickByName(clickTarget, {
          targetHwnd: next.lastWindowHwnd ?? undefined,
          processId: next.lastWindowPid,
          preferShortcutFirst: true,
        });
        if (result.triggeredSave) next = { ...next, lastTriggeredSave: true };
        if (isJianyingExport) next = { ...next, lastClickedExport: true };
        if (result.triggeredImport && isJianyingImport) next = { ...next, lastClickedImport: true };
        if (isWebUpload) next = { ...next, lastClickedImport: true };
      } else if (next.lastWindowHwnd != null && next.lastWindowHwnd !== 0 && windowName === (next.lastWindowName ?? "")) {
        targetHwnd = next.lastWindowHwnd;
        // 剪映导出：弹窗关闭后主窗 hwnd 可能需刷新，优先用 findWindowByName 获取最新句柄
        if (isJianyingExport && next.lastWindowPid != null) {
          const fresh = await findWindowByName(next.lastWindowName ?? "剪映", { processId: next.lastWindowPid });
          if (fresh?.nativeWindowHandle) {
            targetHwnd = fresh.nativeWindowHandle;
            next = { ...next, lastWindowHwnd: targetHwnd };
          }
        }
        await bringWindowToFront(targetHwnd);
        // 传「窗口|名称」格式，确保 clickByName 内剪映等应用专用分支能匹配（如 isJianyingStartCreating 需 nameOrTarget 含 剪映）
        const sameWindowTarget = next.lastWindowName ? `${next.lastWindowName}|${step.name}` : step.name;
        const result = await clickByName(sameWindowTarget, {
          targetHwnd: targetHwnd,
          processId: next.lastWindowPid,
          preferShortcutFirst: true,
        });
        if (result.triggeredSave) next = { ...next, lastTriggeredSave: true };
        if (isJianyingExport) next = { ...next, lastClickedExport: true };
        if (result.triggeredImport && isJianyingImport) next = { ...next, lastClickedImport: true };
        if (isWebUpload) next = { ...next, lastClickedImport: true };
      } else {
        const info = await findWindowByWindowNameWithAliases(windowName, { processId: next.lastWindowPid });
        if (!info?.nativeWindowHandle) {
          throw new Error(`未找到窗口: ${windowName}，请重试`);
        }
        targetHwnd = info.nativeWindowHandle;
        await bringWindowToFront(targetHwnd);
        const result = await clickByName(step.name, {
          targetHwnd: info.nativeWindowHandle,
          processId: info.processId,
          preferShortcutFirst: true,
        });
        if (result.triggeredSave) next = { ...next, lastTriggeredSave: true };
        if (isJianyingExport) next = { ...next, lastClickedExport: true };
        if (result.triggeredImport && isJianyingImport) next = { ...next, lastClickedImport: true };
        if (isWebUpload) next = { ...next, lastClickedImport: true };
      }
    } else {
      await bringWindowToFront(targetHwnd);
      const isSaveButton = /^(保存|Save)$/i.test(step.name.trim());
      const isExportConfirm = /^(导出|确定|Export|OK)$/i.test(step.name.trim()) && next.exportDialogHwnd != null;
      const isDesktop = /^(桌面|Desktop)$/i.test(step.name.trim());
      const result = await clickByName(step.name, {
        targetHwnd,
        processId: next.lastWindowPid,
        saveDialogButton: isSaveButton,
        saveDialogDesktop: isDesktop,
        exportDialogConfirm: isExportConfirm,
        skipWaitForTarget: true,
      });
      if (isSaveButton) next = { ...next, saveDialogHwnd: undefined };
      if (isExportConfirm) next = { ...next, exportDialogHwnd: undefined };
    }
    // 剪映「开始创作」后自动全屏
    const isJianyingStartCreating =
      /开始创作|Start\s*Creating/i.test((step.name ?? "").trim()) &&
      /剪映|JianyingPro|CapCut/i.test(next.lastWindowName ?? "") &&
      next.lastWindowHwnd != null &&
      next.lastWindowHwnd > 0;
    if (isJianyingStartCreating && next.lastWindowHwnd) {
      await maximizeWindow(next.lastWindowHwnd);
      console.log("[runA11ySequence] 剪映开始创作后窗口最大化");
    }
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "scroll") {
    // 多窗时带 target + processId 锁定当前链窗口
    const scrollTarget = next.lastWindowName ? `${next.lastWindowName}|编辑` : "";
    const scrollOpts =
      next.lastWindowName && next.lastWindowPid
        ? { processId: next.lastWindowPid }
        : undefined;
    if (scrollTarget) {
      await scroll(step.direction, scrollTarget, scrollOpts);
    } else {
      await scroll(step.direction);
    }
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "drag") {
    await drag(step.from, step.to);
    await delay(stepCooldown);
    return next;
  }

  if (step.type === "keys") {
    const keys = (step as { keys?: string }).keys ?? "";
    const isWeChat = /微信|WeChat/i.test(next.lastWindowName ?? "");
    if (isWeChat && /[\^f]|f/.test(keys) && opts?.nextStep?.type === "type") {
      const preText = (opts.nextStep as { text?: string }).text?.trim();
      if (preText) {
        await setClipboardOnly(preText);
        next = { ...next, clipboardPreFilled: preText };
      }
    }
    // 导入对话框输入路径后需 Enter 确认：置顶导入对话框使按键发往正确窗口
    if (next.importDialogHwnd != null && next.importDialogHwnd !== 0 && /ENTER/i.test(keys)) {
      await bringWindowToFront(next.importDialogHwnd);
    } else if (next.lastWindowHwnd != null && next.lastWindowHwnd !== 0) {
      await bringWindowToFront(next.lastWindowHwnd);
    }
    if (keys) await sendKeys(keys);
    if (next.importDialogHwnd != null && /ENTER/i.test(keys)) {
      next = { ...next, importDialogHwnd: undefined };
    }
    if (isWeChat && /[\^f]|f/.test(keys)) {
      next = { ...next, weChatPhase: "search" };
      await delay(300);
    }
    if (keys.includes("ENTER") && isWeChat) {
      await delay(950);
    }
    await delay(stepCooldown);
    return next;
  }

  return next;
}

/** Ralph Loop：单步失败时重试（借鉴 vercel-labs/ralph-loop-agent），给对话框/窗口浮现时间 */
const RALPH_LOOP_MAX_RETRIES = 2;
const RALPH_LOOP_DELAY_MS = 800;

/** 执行 a11y_sequence 的共享逻辑 */
async function executeA11ySteps(steps: A11yStep[]): Promise<void> {
  const completed = completeA11ySteps(steps);
  let state: StepState = {};
  for (let i = 0; i < completed.length; i++) {
    const s = completed[i];
    const stepDesc = s.type === "open_app" ? `open_app ${(s as { app?: string }).app}` : s.type === "type" ? `type "${((s as { text?: string }).text ?? "").slice(0, 20)}…"` : s.type === "keys" ? `keys ${(s as { keys?: string }).keys}` : s.type === "click" ? `click ${(s as { name?: string }).name}` : s.type === "wait" ? `wait ${(s as { ms?: number }).ms}ms` : String(s.type);
    console.log("[runA11ySequence] 第 %s/%s 步: %s", i + 1, completed.length, stepDesc);
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= RALPH_LOOP_MAX_RETRIES + 1; attempt++) {
      try {
        state = await executeOneStep(completed[i], state, { nextStep: completed[i + 1] });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt <= RALPH_LOOP_MAX_RETRIES) {
          console.warn("[runA11ySequence] Ralph Loop 重试 %s/%s（上轮失败: %s）", attempt, RALPH_LOOP_MAX_RETRIES + 1, msg);
          await delay(RALPH_LOOP_DELAY_MS);
        } else {
          console.error("[runA11ySequence] 第 %s 步失败（%s 次尝试后）: %s", i + 1, RALPH_LOOP_MAX_RETRIES + 1, msg);
          throw err;
        }
      }
    }
  }
}

/** 直接执行 a11y_sequence payload（供 pipeline、脚本等调用） */
export async function runA11ySequence(payload: A11ySequencePayload): Promise<void> {
  if (!isA11ySequencePayload(payload)) throw new Error("payload 不是 a11y_sequence");
  await executeA11ySteps(payload.steps);
}

/** 执行 a11y_sequence 任务：找-切-做 闭环，保存对话框重定位，find 失败即抛错触发重试 */
export const a11ySequenceStep: ExecuteStepFn = async ({ task }) => {
  const payload = task.payload;
  if (!isA11ySequencePayload(payload)) {
    console.error("[runA11ySequence] payload 不是 a11y_sequence，taskId=%s", task.id);
    return;
  }
  await executeA11ySteps(payload.steps);
};
