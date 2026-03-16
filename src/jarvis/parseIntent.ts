/**
 * Jarvis 意图解析：自然语言 → IntentResult（多轮上下文 + 单步/多步任务链）
 * 混合架构：本地小模型守门（意图分类） + 云端大模型负责复杂 A11y 规划
 */

import OpenAI from "openai";
import { HYBRID_ENABLED } from "../config/llmConfig.js";
import { classifyWithLocal, planWithCloud, planWithLocal, type RouteClass } from "../llm/hybridRouter.js";
import { readCurrentA11ySnapshot } from "../tools/directShellBridge.js";
import { compressA11yForCloud } from "../tools/a11yCompress.js";
import {
  buildGeminiCopywritingSteps,
  buildTongyiWanxiangImageSteps,
  buildDoubaoImageSteps,
  runTongyiWanxiangViaPuppeteer,
  runDoubaoViaPuppeteer,
  runGeminiViaPuppeteer,
} from "../pipeline/webGenSteps.js";

export type SnapshotClickIntent = {
  kind: "snapshot_and_click_review";
  targetApp: string;
  buttonName: string;
};

export type OpenTargetIntent = { kind: "open_target"; targetName: string };

/** 全能资源猎人：搜索任意资源（电影、软件、文档等） */
export type ResourceHuntIntent = {
  kind: "resource_hunt";
  keywords: string;
  qualityOrType?: string;
  autoDownload?: boolean;
};

/** 本地文件管理：在桌面建文件夹等 */
export type ManageFileStep = {
  kind: "manage_file";
  action: "create_folder";
  folderName: string;
};

/** 多步任务链中的单步（可含 resource_hunt、manage_file） */
export type StepTask =
  | OpenTargetIntent
  | { kind: "run_next" }
  | SnapshotClickIntent
  | ManageFileStep
  | ResourceHuntIntent;

export type MultiStepIntent = { kind: "multi_step"; tasks: StepTask[] };

/** 基于 A11y 的连续操作链（打开应用 → 输入 → 点击 → …），用于无人值守确定性多步 */
export type A11ySequenceIntent = {
  kind: "a11y_sequence";
  steps: Array<
    | { type: "open_app"; app: string }
    | { type: "type"; text: string }
    | { type: "generate_and_type"; prompt: string }
    | { type: "click"; name: string }
    | { type: "keys"; keys: string }
    | { type: "scroll"; direction: "up" | "down" | "left" | "right" }
    | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
    | { type: "wait"; ms: number }
  >;
};

/** Puppeteer 网页创作意图：直接通过浏览器 DOM 控制，不走 UIA；deepseek 走 API */
export type PuppeteerWebGenIntent = {
  kind: "puppeteer_web_gen";
  tool: "tongyi_wanxiang" | "doubao" | "gemini" | "kling" | "jimeng" | "deepseek";
  prompt: string;
  imagePath?: string;
};

/** 长周期计划意图：3天内完成产品规划 → 拆成多阶段 */
export type LongPlanIntent = {
  kind: "long_plan";
  name: string;
  priority: "high" | "medium" | "low";
  deadline?: string;
  stages: Array<{
    name: string;
    kind: string;
    description: string;
    dependsOnStageIndex?: number[];
  }>;
  config?: {
    savePath?: string;
    format?: string;
    parallel?: boolean;
  };
};

export type IntentResult =
  | SnapshotClickIntent
  | { kind: "run_next" }
  | { kind: "help" }
  | OpenTargetIntent
  | ResourceHuntIntent
  | ManageFileStep
  | MultiStepIntent
  | A11ySequenceIntent
  | PuppeteerWebGenIntent
  | LongPlanIntent
  | null;

/** 对话历史条目，用于 LLM 上下文 */
export type ConversationMessage = { role: "user" | "assistant"; content: string };

const MAX_HISTORY_MESSAGES = 20;

const SYSTEM_PROMPT = `你是 Jarvis 的指令解析器。用户用中文或英文自然语言发出指令，你只输出一段合法 JSON，不要其他文字。
你会收到当前用户输入以及之前的对话历史，请结合上下文理解（如“再打开一个”“然后打开微信”指延续上文的操作序列）。

必须支持的意图与对应 JSON（严格按下列 schema 输出其一）：

1) 单步：打开某东西
   {"kind":"open_target","targetName":"<提取的名称>"}
   - 打开百度、打开微信、打开剪映、打开记事本 等 → targetName 为核心名称（如 "百度"、"微信"）

2) 多步：用户一句话里包含多个操作，或明确顺序（先…再…、…然后…、…接着…）
   {"kind":"multi_step","tasks":[<StepTask>, ...]}
   - 先打开百度再打开微信 → tasks 里两项 open_target
   - 搜法考资料并在桌面建一个文件夹保存下来 → 必须包含 manage_file（先）和 resource_hunt（后）：tasks:[{"kind":"manage_file","action":"create_folder","folderName":"法考资料"},{"kind":"resource_hunt","keywords":"法考资料","qualityOrType":"好评实用","autoDownload":false}]
   - 帮我找一些法考资料，必须是好评的、实用的，然后在桌面建一个文件夹保存下来 → 同上，folderName 从关键词提取（如"法考资料"），keywords 与 qualityOrType 填好
   StepTask 可选：open_target | run_next | snapshot_and_click_review | manage_file（action:"create_folder",folderName）| resource_hunt（keywords,qualityOrType,autoDownload）

3) 在 Cursor 内点击按钮（单步）
   {"kind":"snapshot_and_click_review","targetApp":"cursor","buttonName":"Search|Extensions|Review|Agents"}

4) 执行下一个待办
   {"kind":"run_next"}

5) 全能资源猎人（搜索电影、软件、文档等可下载资源）
   {"kind":"resource_hunt","keywords":"<搜索关键词>","qualityOrType":"<可选，如 1080p/高清/软件/文档>","autoDownload":<true|false>}
   - 帮我找某某电影、搜一下某某资源、下载某某 → keywords 为资源名，qualityOrType 按用户说的填（如 4K、蓝光、软件），autoDownload 仅当用户明确说“直接下”或“自动下载”时为 true

6) A11y 连续操作链（打开应用后依次输入、点击、保存等，基于无障碍树确定性执行）
   {"kind":"a11y_sequence","steps":[<Step>, ...]}
   Step 类型：{"type":"open_app","app":"应用名"} | {"type":"type","text":"要输入的文字"} | {"type":"click","name":"按钮/菜单名"} | {"type":"scroll","direction":"up|down|left|right"}
   - 打开记事本，输入「测试内容」，点击文件→保存，输入文件名 test.txt，点击保存 →
     {"kind":"a11y_sequence","steps":[
       {"type":"open_app","app":"记事本"},
       {"type":"type","text":"测试内容"},
       {"type":"click","name":"文件"},
       {"type":"click","name":"保存"},
       {"type":"type","text":"test.txt"},
       {"type":"click","name":"保存"}
     ]}
   - 用户说「打开记事本，在里面写一首诗然后保存到桌面」时，拆成 open_app + type + click 文件 + click 保存/另存为 + [click 桌面] + type 文件名 + click 保存；当用户明确说「到桌面」时，必须在 type 文件名前加 {"type":"click","name":"桌面"}（另存为对话框左侧栏点击桌面）。

7) 帮助/打招呼
   {"kind":"help"}

8) 无法解析（仅当完全无法理解或与上述无关时）
   {"kind":null}

重要：当用户描述「打开某应用 + 输入文字 + 点击菜单/保存」等连续操作时，优先输出 a11y_sequence（步骤按顺序）。若无法拆成步骤则 fallback 到 open_target。只输出能力范围内的部分，不要输出 null。

规则：只输出一行 JSON，不要 markdown 包裹，不要解释。多步时 tasks 数组按用户描述的顺序排列。`;

function keywordFallback(input: string): IntentResult {
  const t = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (t === "点搜索" || t === "点 search" || t === "搜索") {
    return { kind: "snapshot_and_click_review", targetApp: "cursor", buttonName: "Search" };
  }
  if (t === "点扩展" || t === "点 extensions" || t === "扩展") {
    return { kind: "snapshot_and_click_review", targetApp: "cursor", buttonName: "Extensions" };
  }
  if (t === "执行" || t === "run" || t === "next") {
    return { kind: "run_next" };
  }
  if (
    t === "help" ||
    t === "帮助" ||
    t === "你能做什么" ||
    t === "ni neng zuo shen me" ||
    t === "有什么功能" ||
    t === "ni hao" ||
    t === "你好"
  ) {
    return { kind: "help" };
  }
  return null;
}

/** 复合动作关键词：与「打开」同现时严禁走 SIMPLE，必须产出 a11y_sequence */
const COMPOUND_ACTION_KEYWORDS = [
  "写", "输入", "保存", "点击", "点", "另存为", "打字", "写入", "到桌面",
  "导出", "发", "发送", "发微信", "发消息", "回复", "留言", "发给", "发給",
  "说", "生成", // 给X说Y、文生图、图生视频
];

/** 网页创作意图（写文案/文生图/图生视频），不要求「打开」也可触发规则兜底 */
function hasWebGenIntent(input: string): boolean {
  const t = input.trim().toLowerCase();
  return (
    /写文案|生成文案|写一篇/.test(t) ||
    /文生图|生成图片|生成一张图|画一张|根据.*生成图/.test(t) ||
    /图生视频|图片转视频|用可灵|用即梦/.test(t) ||
    /用豆包|用通义|用gemini|用可灵|用即梦/.test(t)
  );
}

function looksLikeFilename(text: string): boolean {
  const s = (text ?? "").trim();
  if (!s || s.length > 80) return false;
  return /\.(txt|md|json|log|csv|html|xml|pdf)$/i.test(s) || (s.length <= 40 && /^[\w\u4e00-\u9fa5.\-]+$/.test(s));
}

/** 发微信信息：一次性说完时提取「联系人」与「消息内容」 */
export type WeChatSendInfo = { contact: string; message?: string };

export function extractWeChatSendInfo(input: string): WeChatSendInfo | null {
  const t = (input ?? "").trim();
  const hasSendIntent = /(发微信|发消息|发给|发送)/.test(t) || /给[^\s，。：:]+说/.test(t);
  if (!t || !hasSendIntent) return null;
  // 发消息说 Y、发送消息说 Y（优先，避免与 给X说Y 误匹配）：给X发(送)?消息说 Y
  const withSay1 = t.match(/给([^\s，。：:]+)发(?:送)?消息说\s*(.+)/);
  if (withSay1 && withSay1[2]?.trim()) return { contact: withSay1[1].trim(), message: withSay1[2].trim() };
  const withSay2 = t.match(/(?:打开)?微信给([^\s，。：:]+)发(?:送)?消息说\s*(.+)/);
  if (withSay2 && withSay2[2]?.trim()) return { contact: withSay2[1].trim(), message: withSay2[2].trim() };
  // 给X说Y（无「发」字）：打开微信,给阿尔法说我很忙
  const withSay0 = t.match(/给([^\s，。：:]+)说\s*(.+)/);
  if (withSay0 && withSay0[2]?.trim()) return { contact: withSay0[1].trim(), message: withSay0[2].trim() };
  // 带消息：给X发(消息)?[：:]内容、发给X[：:]内容
  const withMsg1 = t.match(/给([^\s，。：:]+)发(?:消息)?[：:]\s*(.+)/);
  if (withMsg1 && withMsg1[2]?.trim()) return { contact: withMsg1[1].trim(), message: withMsg1[2].trim() };
  const withMsg2 = t.match(/发给([^\s，。：:]+)[：:]\s*(.+)/);
  if (withMsg2 && withMsg2[2]?.trim()) return { contact: withMsg2[1].trim(), message: withMsg2[2].trim() };
  const withMsg3 = t.match(/(?:打开)?微信给([^\s，。：:]+)发(?:消息)?[：:]\s*(.+)/);
  if (withMsg3 && withMsg3[2]?.trim()) return { contact: withMsg3[1].trim(), message: withMsg3[2].trim() };
  // 引号格式：给X发"内容"、给X发「内容」
  const withQuote1 = t.match(/给([^\s，。：:"「」]+)发["「]([^"」]+)["」]/);
  if (withQuote1 && withQuote1[2]?.trim()) return { contact: withQuote1[1].trim(), message: withQuote1[2].trim() };
  const withQuote2 = t.match(/(?:打开)?微信给([^\s，。：:"「」]+)发["「]([^"」]+)["」]/);
  if (withQuote2 && withQuote2[2]?.trim()) return { contact: withQuote2[1].trim(), message: withQuote2[2].trim() };
  // 仅联系人（无消息）
  const noMsg1 = t.match(/给([^\s，。：:]+)发(?:消息)?\s*$/);
  if (noMsg1) return { contact: noMsg1[1].trim() };
  const noMsg2 = t.match(/发给([^\s，。：:]+)\s*$/);
  if (noMsg2) return { contact: noMsg2[1].trim() };
  const noMsg3 = t.match(/(?:打开)?微信给([^\s，。：:]+)发(?:消息)?\s*$/);
  if (noMsg3) return { contact: noMsg3[1].trim() };
  return null;
}

/** 步骤链是否为「发微信给某人」流程（含 open_app 微信 + 需输入消息的 type 步） */
export function isWeChatSendFlow(steps: A11ySequenceIntent["steps"]): boolean {
  const hasWeChat = steps.some((s) => s.type === "open_app" && /微信|WeChat/i.test(s.app));
  const hasSendIntent = steps.some((s) => s.type === "click" || s.type === "type");
  return hasWeChat && hasSendIntent;
}

/** 发微信流程中是否已有非空消息（type 步） */
export function hasMessageInWeChatFlow(steps: A11ySequenceIntent["steps"]): boolean {
  const weChatIdx = steps.findIndex((s) => s.type === "open_app" && /微信|WeChat/i.test(s.app));
  if (weChatIdx < 0) return false;
  for (let i = weChatIdx + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "type" && (s.text ?? "").trim().length > 0) return true;
  }
  return false;
}

/** 发微信流程中是否已有搜索步骤（keys ^f 或已有 type 联系人 前有 keys） */
function hasWeChatSearchFlow(steps: A11ySequenceIntent["steps"]): boolean {
  return steps.some((s) => s.type === "keys" && ((s as { keys?: string }).keys ?? "").includes("f"));
}

/** 云端可能把 open_app 误产出为「微信+联系人」(如 微信阿尔法)，修正为 open_app 微信 */
export function fixWeChatOpenAppStep(
  steps: A11ySequenceIntent["steps"],
  contact: string
): A11ySequenceIntent["steps"] {
  const c = (contact ?? "").trim();
  if (!c) return steps;
  let fixedApp = "";
  const out = steps.map((s) => {
    if (s.type !== "open_app") return s;
    const app = ((s as { app?: string }).app ?? "").trim();
    if (!/微信|WeChat/i.test(app)) return s;
    if (app === "微信" || app === "WeChat") return s;
    fixedApp = app;
    return { ...s, app: "微信" as const };
  });
  if (fixedApp) console.log("[parseIntent] 发微信：修正 open_app「" + fixedApp + "」→ open_app 微信");
  return fixedApp ? out : steps;
}

/** 有 contact 时强制插入搜索流程：keys ^f + type 联系人 + keys Enter，避免直接给当前聊天发消息；移除冗余 click 联系人/type 联系人，避免重复搜索 */
export function ensureWeChatSearchFlowWithContact(
  steps: A11ySequenceIntent["steps"],
  contact: string
): A11ySequenceIntent["steps"] {
  const c = (contact ?? "").trim();
  if (!c || !isWeChatSendFlow(steps) || hasWeChatSearchFlow(steps)) return steps;
  const wechatIdx = steps.findIndex((s) => s.type === "open_app" && /微信|WeChat/i.test((s as { app?: string }).app ?? ""));
  if (wechatIdx < 0) return steps;
  const firstTypeIdx = steps.findIndex((s, i) => i > wechatIdx && s.type === "type");
  if (firstTypeIdx < 0) return steps;
  const firstTypeText = ((steps[firstTypeIdx] as { text?: string }).text ?? "").trim();
  const beforeFirstType = steps.slice(0, firstTypeIdx).filter((s) => {
    if (s.type === "click") {
      const name = (s as { name?: string }).name?.trim() ?? "";
      return !name || name.toLowerCase() !== c.toLowerCase();
    }
    return true;
  });
  const afterFirstType = firstTypeText.toLowerCase() === c.toLowerCase() ? steps.slice(firstTypeIdx + 1) : steps.slice(firstTypeIdx);
  const searchSteps = [
    { type: "keys" as const, keys: "^f" },
    { type: "type" as const, text: c },
    { type: "keys" as const, keys: "{ENTER}" },
  ];
  const out = [...beforeFirstType, ...searchSteps, ...afterFirstType];
  console.log("[parseIntent] 发微信：强制插入搜索流程 Ctrl+F → type " + c + " → Enter（去重 click/type 联系人）");
  return out;
}

/** 将消息内容注入发微信流程：替换最后一个空 type，或追加（仅当无任何 type 时）；已有消息内容则不再 push，避免重复 */
export function injectWeChatMessage(
  steps: A11ySequenceIntent["steps"],
  message: string
): A11ySequenceIntent["steps"] {
  const text = (message ?? "").trim();
  if (!text) return steps;
  const out = [...steps];
  let lastTypeIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].type === "type") lastTypeIdx = i;
  }
  if (lastTypeIdx >= 0) {
    const last = out[lastTypeIdx] as { text?: string };
    if (!last.text?.trim()) {
      out[lastTypeIdx] = { type: "type", text };
    }
    // else: 最后一 type 已有内容，视为消息已注入，不 push（避免「我很忙我很忙」重复）
  } else {
    out.push({ type: "type", text });
  }
  return out;
}

/** 重排步骤：type 文件名 必须在 click 保存（打开另存为）之后，否则会输入到主编辑区 */
function reorderStepsForSaveFlow(steps: A11ySequenceIntent["steps"]): A11ySequenceIntent["steps"] {
  let firstClickSaveIdx = -1;
  let typeFilenameIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "click" && /^(保存|另存为|Save|Save As)$/i.test((s.name ?? "").trim()) && firstClickSaveIdx < 0) {
      firstClickSaveIdx = i;
    }
    if (s.type === "type" && looksLikeFilename(s.text ?? "") && typeFilenameIdx < 0) {
      typeFilenameIdx = i;
    }
  }
  if (typeFilenameIdx >= 0 && firstClickSaveIdx >= 0 && typeFilenameIdx < firstClickSaveIdx) {
    const typeStep = steps[typeFilenameIdx];
    const out = steps.filter((_, i) => i !== typeFilenameIdx);
    const insertAt = firstClickSaveIdx - 1;
    out.splice(insertAt + 1, 0, typeStep);
    console.log("[parseIntent] 步骤重排：type 文件名 移至 click 保存（打开对话框）之后");
    return out;
  }
  return steps;
}

/** 保存流程步骤修复：先重排 type 文件名 到正确位置，再按需插入 click 桌面 */
function applySaveFlowFixes(
  userInput: string,
  steps: A11ySequenceIntent["steps"]
): A11ySequenceIntent["steps"] {
  return ensureDesktopStepInSaveFlow(userInput, reorderStepsForSaveFlow(steps));
}

/** 用户说「保存到桌面」时，若链中缺少 click 桌面，在 type 文件名前插入 */
function ensureDesktopStepInSaveFlow(
  userInput: string,
  steps: A11ySequenceIntent["steps"]
): A11ySequenceIntent["steps"] {
  const t = (userInput ?? "").trim();
  if (!t || (!t.includes("桌面") && !t.includes("到桌面"))) return steps;

  const wantsDesktop = /桌面|到桌面/.test(t);
  if (!wantsDesktop) return steps;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "click" && /^(保存|另存为|Save|Save As)$/i.test((s.name ?? "").trim())) {
      for (let j = i + 1; j < steps.length; j++) {
        const u = steps[j];
        if (u.type === "type" && looksLikeFilename(u.text ?? "")) {
          const hasDesktop = steps.slice(i + 1, j).some(
            (x) => x.type === "click" && /^(桌面|Desktop)$/i.test((x.name ?? "").trim())
          );
          if (!hasDesktop) {
            const out = [...steps];
            out.splice(j, 0, { type: "click", name: "桌面" });
            console.log("[parseIntent] 保存到桌面：在 type 文件名前插入 click 桌面");
            return out;
          }
          break;
        }
      }
      break;
    }
  }
  return steps;
}

/** 判断是否为「打开 + 写/点击/保存」类复合指令，必须 100% 走 COMPLEX_A11Y_PLANNING */
function hasCompoundActionKeywords(input: string): boolean {
  const t = input.trim();
  if (!t || !t.includes("打开")) return false;
  return COMPOUND_ACTION_KEYWORDS.some((kw) => t.includes(kw));
}

/** 阶段 4 规则兜底：当「打开记事本+写/输入+保存」且 planWithLocal 未产出时，构造最小 steps */
function buildRuleFallbackStepsNotepad(input: string): A11ySequenceIntent["steps"] | null {
  const t = input.trim().toLowerCase();
  if (!t.includes("打开") || (!t.includes("记事本") && !t.includes("notepad"))) return null;
  if (!COMPOUND_ACTION_KEYWORDS.some((kw) => t.includes(kw))) return null;

  const app = t.includes("notepad") ? "Notepad" : "记事本";
  const defaultPoem = "春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少";
  const hasWrite = /写|输入|录入|打字/.test(t);
  const wantsDesktop = /桌面|到桌面/.test(t);

  const steps: A11ySequenceIntent["steps"] = [
    { type: "open_app", app },
    { type: "type", text: hasWrite ? defaultPoem : "测试内容" },
    { type: "click", name: "文件" },
    { type: "click", name: "另存为" },
  ];
  if (wantsDesktop) steps.push({ type: "click", name: "桌面" });
  steps.push({ type: "type", text: "未命名.txt" }, { type: "click", name: "保存" });
  console.log("[parseIntent] 规则兜底：构造 a11y_sequence（打开记事本+写+保存）");
  return steps;
}

/** Phase C P0：打开剪映 + 导出（到桌面/指定路径）规则兜底 */
function buildRuleFallbackStepsJianying(input: string): A11ySequenceIntent["steps"] | null {
  const t = input.trim().toLowerCase();
  if (!t.includes("打开") || (!t.includes("剪映") && !t.includes("jianying") && !t.includes("capcut"))) return null;
  if (!/导出|export/.test(t)) return null;

  const wantsDesktop = /桌面|到桌面/.test(t);
  const m = t.match(/导出\s*(?:到|为)?\s*[\"'【"]?([^\s，,。、\"'】]+)/);
  const filename = m?.[1]?.trim() || "视频导出.mp4";
  const steps: A11ySequenceIntent["steps"] = [
    { type: "open_app", app: "剪映" },
    { type: "click", name: "开始创作" },
    { type: "wait", ms: 3500 },
    { type: "click", name: "导出" },
  ];
  if (wantsDesktop) steps.push({ type: "click", name: "桌面" });
  steps.push({ type: "type", text: filename }, { type: "click", name: "导出" });
  console.log("[parseIntent] 规则兜底：构造 a11y_sequence（打开剪映+导出）");
  return steps;
}

/** 打开 Word + 写报告/文章 规则兜底：open_app → Ctrl+N 新建 → generate_and_type 生成长文 */
function buildRuleFallbackStepsWord(input: string): A11ySequenceIntent["steps"] | null {
  const t = input.trim();
  const lower = t.toLowerCase();
  if (!t.includes("打开") || (!lower.includes("word") && !t.includes("文档") && !t.includes("微软") && !t.includes("office"))) return null;
  if (!/写|输入|给我写|撰写|生成/.test(t)) return null;

  // 提取主题（关于XXX的、XXX研究报告、写一个关于XXX）
  let topic = "通用主题";
  const aboutMatch = t.match(/(?:关于|主题)?([^\s，,。、]{2,40}?)(?:的)?(?:研究)?报告|发展|分析|方向/);
  if (aboutMatch) topic = aboutMatch[1].trim();
  else {
    const simpleMatch = t.match(/写\s*(?:一个|一篇)?(?:关于)?([^\s，,。、]{2,30})/);
    if (simpleMatch) topic = simpleMatch[1].trim();
  }

  // 提取字数
  const wordMatch = t.match(/(?:不低于|不少于|至少|以上)?\s*(\d{3,5})\s*字/);
  const minWords = wordMatch ? parseInt(wordMatch[1], 10) : 2500;

  // 是否要求正规排版
  const wantsFormat = /正规|格式|排版|公文|学术/.test(t);

  const formatHint = wantsFormat
    ? "，按正规公文/学术格式：标题居中加粗、正文首行缩进2字符、段落分明、小标题加粗，不要 markdown 符号。"
    : "，段落分明，不要 markdown 符号。";

  const prompt = `请写一篇关于「${topic}」的研究报告，字数不低于 ${minWords} 字${formatHint}只输出正文，不要解释、不要 JSON。`;

  const steps: A11ySequenceIntent["steps"] = [
    { type: "open_app", app: "Microsoft Word" },
    { type: "keys", keys: "^n" },
    { type: "wait", ms: 2000 },
    { type: "generate_and_type", prompt },
  ];
  console.log("[parseIntent] 规则兜底：构造 a11y_sequence（打开 Word+新建+写报告）");
  return steps;
}

/** Phase B 阶段 3.1：打开 Excel + 输入/保存 规则兜底 */
function buildRuleFallbackStepsExcel(input: string): A11ySequenceIntent["steps"] | null {
  const t = input.trim().toLowerCase();
  if (!t.includes("打开") || (!t.includes("excel") && !t.includes("表格"))) return null;
  if (!COMPOUND_ACTION_KEYWORDS.some((kw) => t.includes(kw))) return null;

  const hasWrite = /写|输入|录入|打字/.test(t);
  const wantsDesktop = /桌面|到桌面/.test(t);

  const steps: A11ySequenceIntent["steps"] = [
    { type: "open_app", app: "Excel" },
    { type: "type", text: hasWrite ? "测试数据" : "测试" },
    { type: "click", name: "文件" },
    { type: "click", name: "另存为" },
  ];
  if (wantsDesktop) steps.push({ type: "click", name: "桌面" });
  steps.push({ type: "type", text: "未命名.xlsx" }, { type: "click", name: "保存" });
  console.log("[parseIntent] 规则兜底：构造 a11y_sequence（打开 Excel+输入+保存）");
  return steps;
}

/** 网页创作 Puppeteer 优先：返回 PuppeteerWebGenIntent 或 null；文案有 DeepSeek key 时走 API */
function buildPuppeteerWebGenIntent(input: string): PuppeteerWebGenIntent | null {
  const t = input.trim();
  const hasDeepseekKey = !!process.env.CLOUD_API_KEY;
  const copywritingTool = hasDeepseekKey ? "deepseek" as const : "gemini" as const;

  const copyMatch = t.match(/(?:写|生成)(?:一篇?)?(?:关于)?(.{2,50}?)(?:的)?文案/);
  if (copyMatch) {
    const topic = (copyMatch[1] ?? "热点").trim() || "热点";
    return { kind: "puppeteer_web_gen", tool: copywritingTool, prompt: `请写一段关于「${topic}」的短视频文案，100～200字，口语化，有节奏感。` };
  }
  if (/写文案|生成文案|帮我写/.test(t)) {
    const topic = t.replace(/^.*(?:关于|主题)?([^\s，。]+).*$/, "$1").trim() || "热点";
    return { kind: "puppeteer_web_gen", tool: copywritingTool, prompt: `请写一段关于「${topic}」的短视频文案，100～200字。` };
  }
  const imgMatch = t.match(/(?:生成|画)(?:一张?|一幅?)?(.{2,80}?)(?:的)?(?:图|图片)?$/);
  if (imgMatch || /文生图|生成图片|画一张|生成一张图/.test(t)) {
    const prompt = (imgMatch?.[1] ?? t.replace(/^(?:用|打开)?(?:通义万相|豆包)?.*?(?:生成|画)(?:一张?|一幅?)?/, "").replace(/(?:的)?(?:图|图片)?$/g, "")).trim() || "一只橘色短毛猫，趴在窗台上晒太阳，写实风格";
    const tool = /豆包|doubao/i.test(t) ? "doubao" as const : "tongyi_wanxiang" as const;
    return { kind: "puppeteer_web_gen", tool, prompt };
  }
  return null;
}

/** 网页创作规则兜底（UIA 路径）：写文案、文生图，作为 Puppeteer 失败时的 fallback */
function buildRuleFallbackStepsWebGen(input: string): A11ySequenceIntent["steps"] | null {
  const t = input.trim();
  const copyMatch = t.match(/(?:写|生成)(?:一篇?)?(?:关于)?(.{2,50}?)(?:的)?文案/);
  if (copyMatch) {
    const topic = (copyMatch[1] ?? "热点").trim() || "热点";
    const prompt = `请写一段关于「${topic}」的短视频文案，100～200字，口语化，有节奏感。`;
    const steps = buildGeminiCopywritingSteps(prompt);
    console.log("[parseIntent] 规则兜底：构造 a11y_sequence（Gemini 写文案）");
    return steps as A11ySequenceIntent["steps"];
  }
  if (/写文案|生成文案|帮我写/.test(t)) {
    const topic = t.replace(/^.*(?:关于|主题)?([^\s，。]+).*$/, "$1").trim() || "热点";
    const prompt = `请写一段关于「${topic}」的短视频文案，100～200字。`;
    const steps = buildGeminiCopywritingSteps(prompt);
    console.log("[parseIntent] 规则兜底：构造 a11y_sequence（Gemini 写文案）");
    return steps as A11ySequenceIntent["steps"];
  }
  const imgMatch = t.match(/(?:生成|画)(?:一张?|一幅?)?(.{2,80}?)(?:的)?(?:图|图片)?$/);
  if (imgMatch || /文生图|生成图片|画一张|生成一张图/.test(t)) {
    const prompt = (imgMatch?.[1] ?? t.replace(/^(?:用|打开)?(?:通义万相|豆包)?.*?(?:生成|画)(?:一张?|一幅?)?/, "").replace(/(?:的)?(?:图|图片)?$/g, "")).trim() || "一只橘色短毛猫，趴在窗台上晒太阳，写实风格";
    const steps = /豆包|doubao/i.test(t) ? buildDoubaoImageSteps(prompt) : buildTongyiWanxiangImageSteps(prompt);
    console.log("[parseIntent] 规则兜底：构造 a11y_sequence（" + (/豆包/i.test(t) ? "豆包" : "通义万相") + " 文生图）");
    return steps as A11ySequenceIntent["steps"];
  }
  return null;
}

/** 阶段 4 规则兜底：统一入口，按应用类型分发 */
function buildRuleFallbackSteps(input: string): A11ySequenceIntent["steps"] | null {
  return buildRuleFallbackStepsWebGen(input) ?? buildRuleFallbackStepsWord(input) ?? buildRuleFallbackStepsNotepad(input) ?? buildRuleFallbackStepsExcel(input) ?? buildRuleFallbackStepsJianying(input);
}

/** 当 LLM 返回 null 时，若输入明显包含「打开XXX」，则尽量解析为 open_target（避免混合指令被整句判为未识别） */
function openTargetFallback(input: string): IntentResult | null {
  const t = input.trim();
  if (!t || !t.includes("打开")) return null;
  const known: string[] = ["记事本", "计算器", "画图", "百度", "微信", "剪映", "Excel", "WPS", "Word", "word", "资源管理器", "豆包", "通义万相", "可灵", "即梦", "Gemini", "notepad", "calc", "mspaint", "excel", "wps"];
  for (const name of known) {
    if (t.includes(name)) return { kind: "open_target", targetName: name };
  }
  const m = t.match(/打开\s*([^\s，,。、]+)/);
  if (m && m[1]) return { kind: "open_target", targetName: m[1].trim() };
  return null;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

function parseOneStep(raw: unknown): StepTask | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "open_target" && typeof o.targetName === "string" && o.targetName.trim()) {
    return { kind: "open_target", targetName: o.targetName.trim() };
  }
  if (o.kind === "run_next") return { kind: "run_next" };
  if (
    o.kind === "snapshot_and_click_review" &&
    typeof o.buttonName === "string" &&
    ["Search", "Extensions", "Review", "Agents"].includes(o.buttonName)
  ) {
    return {
      kind: "snapshot_and_click_review",
      targetApp: (typeof o.targetApp === "string" && o.targetApp) ? o.targetApp : "cursor",
      buttonName: o.buttonName,
    };
  }
  if (
    o.kind === "manage_file" &&
    o.action === "create_folder" &&
    typeof o.folderName === "string" &&
    o.folderName.trim()
  ) {
    return { kind: "manage_file", action: "create_folder", folderName: o.folderName.trim() };
  }
  if (o.kind === "resource_hunt" && typeof o.keywords === "string" && o.keywords.trim()) {
    return {
      kind: "resource_hunt",
      keywords: o.keywords.trim(),
      qualityOrType: typeof o.qualityOrType === "string" ? o.qualityOrType.trim() : undefined,
      autoDownload: Boolean(o.autoDownload),
    };
  }
  return null;
}

function parseLLMResponse(text: string): IntentResult {
  const rawText = extractJson(text);
  try {
    const raw = JSON.parse(rawText) as {
      kind?: string | null;
      targetApp?: string;
      buttonName?: string;
      targetName?: string;
      tasks?: unknown[];
      steps?: unknown[];
      keywords?: string;
      qualityOrType?: string;
      autoDownload?: boolean;
      action?: string;
      folderName?: string;
    };
    if (raw.kind === null || raw.kind === undefined) return null;
    if (raw.kind === "run_next") return { kind: "run_next" };
    if (raw.kind === "help") return { kind: "help" };
    if (raw.kind === "resource_hunt" && typeof raw.keywords === "string" && raw.keywords.trim()) {
      return {
        kind: "resource_hunt",
        keywords: raw.keywords.trim(),
        qualityOrType: typeof raw.qualityOrType === "string" ? raw.qualityOrType.trim() : undefined,
        autoDownload: Boolean(raw.autoDownload),
      };
    }
    if (raw.kind === "open_target" && typeof raw.targetName === "string" && raw.targetName.trim()) {
      return { kind: "open_target", targetName: raw.targetName.trim() };
    }
    if (raw.kind === "multi_step" && Array.isArray(raw.tasks) && raw.tasks.length > 0) {
      const tasks: StepTask[] = [];
      for (const item of raw.tasks) {
        const step = parseOneStep(item);
        if (step) tasks.push(step);
      }
      if (tasks.length > 0) return { kind: "multi_step", tasks };
    }
    if (raw.kind === "a11y_sequence" && Array.isArray(raw.steps) && raw.steps.length > 0) {
      const steps: A11ySequenceIntent["steps"] = [];
      for (const s of raw.steps as unknown[]) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        if (o.type === "open_app" && typeof o.app === "string") {
          steps.push({ type: "open_app", app: o.app.trim() });
        } else if (o.type === "type" && typeof o.text === "string") {
          steps.push({ type: "type", text: o.text.trim() });
        } else if (o.type === "generate_and_type" && typeof o.prompt === "string") {
          steps.push({ type: "generate_and_type", prompt: o.prompt.trim() });
        } else if (o.type === "click" && typeof o.name === "string") {
          steps.push({ type: "click", name: o.name.trim() });
        } else if (o.type === "scroll" && typeof o.direction === "string") {
          const d = o.direction.toLowerCase();
          if (["up", "down", "left", "right"].includes(d)) {
            steps.push({ type: "scroll", direction: d as "up" | "down" | "left" | "right" });
          }
        } else if (o.type === "drag" && o.from && o.to) {
          const from = o.from as Record<string, number>;
          const to = o.to as Record<string, number>;
          if (typeof from?.x === "number" && typeof from?.y === "number" && typeof to?.x === "number" && typeof to?.y === "number") {
            steps.push({ type: "drag", from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
          }
        } else if (o.type === "wait" && typeof o.ms === "number" && o.ms > 0) {
          steps.push({ type: "wait", ms: o.ms });
        }
      }
      if (steps.length > 0) return { kind: "a11y_sequence", steps };
    }
    if (
      raw.kind === "manage_file" &&
      raw.action === "create_folder" &&
      typeof raw.folderName === "string" &&
      raw.folderName.trim()
    ) {
      return { kind: "manage_file", action: "create_folder", folderName: raw.folderName.trim() };
    }
    if (
      raw.kind === "snapshot_and_click_review" &&
      typeof raw.targetApp === "string" &&
      typeof raw.buttonName === "string"
    ) {
      const buttonName = ["Search", "Extensions", "Review", "Agents"].includes(raw.buttonName)
        ? raw.buttonName
        : "Search";
      return {
        kind: "snapshot_and_click_review",
        targetApp: raw.targetApp || "cursor",
        buttonName,
      };
    }
  } catch (_) {
    // ignore parse error
  }
  return null;
}

/**
 * 自然语言 → IntentResult。支持对话历史与多步任务链。
 * @param input 当前轮用户输入
 * @param conversationHistory 近期对话历史（可选），用于上下文理解
 */
export async function parseIntent(
  input: string,
  conversationHistory: ConversationMessage[] = []
): Promise<IntentResult> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const rawURL = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1").trim();
  const baseURL = rawURL.replace(/localhost/gi, "127.0.0.1");
  const model = process.env.OPENAI_MODEL ?? "llama3.2";
  const isOllama = baseURL.includes("11434") || baseURL.includes("ollama");
  const useLLM = Boolean(apiKey) || baseURL.includes("11434") || baseURL.includes("ollama");

  if (!useLLM) {
    return keywordFallback(input);
  }

  if (baseURL.includes("127.0.0.1")) {
    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
    const add = "127.0.0.1,localhost";
    if (add.split(",").some((h) => !noProxy.includes(h))) {
      process.env.NO_PROXY = [noProxy, add].filter(Boolean).join(",");
      process.env.no_proxy = process.env.NO_PROXY;
    }
  }

  let route: RouteClass = "SIMPLE_OS_ACTION";
  if (HYBRID_ENABLED) {
    try {
      route = await classifyWithLocal(trimmed);
      console.log("[parseIntent] 混合路由分类:", route);
    } catch (err) {
      console.warn("[parseIntent] 本地分类失败，走全量解析:", err);
    }
  }

  if (hasCompoundActionKeywords(trimmed)) {
    route = "COMPLEX_A11Y_PLANNING";
    console.log("[parseIntent] 关键词强判：复合指令，强制 COMPLEX_A11Y_PLANNING");
  }
  if (hasWebGenIntent(trimmed)) {
    route = "COMPLEX_A11Y_PLANNING";
    console.log("[parseIntent] 网页创作意图，强制 COMPLEX_A11Y_PLANNING");
  }

  if (route === "CHAT") {
    return { kind: "help" };
  }

  // ─── 长计划检测：「3天内完成产品规划」「每天发3条小红书」等长周期任务 ───
  const longPlan = await detectLongPlanIntent(trimmed);
  if (longPlan) {
    console.log("[parseIntent] 识别为长周期计划:", longPlan.name, "阶段数:", longPlan.stages.length);
    return longPlan;
  }

  if (route === "COMPLEX_A11Y_PLANNING") {
    // 网页创作优先走 Puppeteer（直接控制浏览器 DOM，稳定性远高于 UIA/OCR）
    if (hasWebGenIntent(trimmed)) {
      const puppeteerIntent = buildPuppeteerWebGenIntent(trimmed);
      if (puppeteerIntent) {
        console.log("[parseIntent] 网页创作 Puppeteer 优先:", puppeteerIntent.tool);
        return puppeteerIntent;
      }
      const webSteps = buildRuleFallbackStepsWebGen(trimmed);
      if (webSteps && webSteps.length > 0) {
        console.log("[parseIntent] 网页创作 UIA 兜底，steps 数:", webSteps.length);
        return { kind: "a11y_sequence", steps: webSteps };
      }
    }
    const hasCloudKey = process.env.CLOUD_API_KEY?.trim() && process.env.CLOUD_API_KEY !== "ollama";
    if (hasCloudKey) {
      try {
        const snapshot = await readCurrentA11ySnapshot();
        const compressed = compressA11yForCloud(snapshot);
        const steps = await planWithCloud(trimmed, compressed);
        if (steps.length > 0) {
          const onlyOpenApp = steps.length === 1 && steps[0]?.type === "open_app";
          const hasWriteIntent = /(写|输入|录入|一首诗|写诗)/.test(trimmed);
          const hasEmptyTypeStep = steps.some(
            (s) => s?.type === "type" && typeof (s as { text?: string }).text === "string" && !(s as { text: string }).text.trim()
          );
          const needLocalFallback =
            (onlyOpenApp && hasWriteIntent) || (hasWriteIntent && hasEmptyTypeStep);
          if (needLocalFallback) {
            console.log("[parseIntent] 云端规划不完整（缺写/输入步骤或 type 为空），改用本地规划");
          } else {
            console.log("[parseIntent] 产出 a11y_sequence，steps 数:", steps.length);
            return { kind: "a11y_sequence", steps: applySaveFlowFixes(trimmed, steps) };
          }
        } else {
          console.log("[parseIntent] 云端规划 steps 为空，改用本地规划");
        }
      } catch (err) {
        console.warn("[parseIntent] 云端 A11y 规划失败，改用本地规划:", err);
      }
    }
    try {
      const steps = await planWithLocal(trimmed);
      if (steps.length > 0) {
        console.log("[parseIntent] 产出 a11y_sequence，steps 数:", steps.length);
        return { kind: "a11y_sequence", steps: applySaveFlowFixes(trimmed, steps) };
      }
    } catch (err) {
      console.warn("[parseIntent] 本地 A11y 规划失败，回退全量解析:", err);
    }
  }

  const recentHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: trimmed },
  ];

  console.log("[parseIntent] 调用开始（含", recentHistory.length, "条历史）", trimmed);

  try {
    const client = new OpenAI({
      apiKey: apiKey || "ollama",
      baseURL,
    });
    const completion = await client.chat.completions.create({
      model,
      messages,
      ...(isOllama ? {} : { response_format: { type: "json_object" as const } }),
      max_tokens: 512,
    });
    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      console.log("[parseIntent] 返回结果", "(content 为空，尝试回退)");
      if (hasCompoundActionKeywords(trimmed)) {
        try {
          const steps = await planWithLocal(trimmed);
          if (steps.length > 0) {
            console.log("[parseIntent] 产出 a11y_sequence（content 空时 planWithLocal），steps 数:", steps.length);
            return { kind: "a11y_sequence", steps: applySaveFlowFixes(trimmed, steps) };
          }
        } catch (e) {
          console.warn("[parseIntent] content 空时 planWithLocal 失败:", e);
        }
      }
      const ruleSteps = (hasCompoundActionKeywords(trimmed) || hasWebGenIntent(trimmed)) ? buildRuleFallbackSteps(trimmed) : null;
      if (ruleSteps && ruleSteps.length > 0) {
        const steps = applySaveFlowFixes(trimmed, ruleSteps);
        console.log("[parseIntent] 产出 a11y_sequence，steps 数:", steps.length, "（规则兜底）");
        return { kind: "a11y_sequence", steps };
      }
      const openFallback = openTargetFallback(trimmed);
      if (openFallback !== null) return openFallback;
      return keywordFallback(input);
    }
    const result = parseLLMResponse(content);
    console.log("[parseIntent] 返回结果", result);
    if (result !== null) {
      if (result.kind === "a11y_sequence" && result.steps.length > 0) {
        return { ...result, steps: applySaveFlowFixes(trimmed, result.steps) };
      }
      return result;
    }
    if (hasCompoundActionKeywords(trimmed)) {
      try {
        const steps = await planWithLocal(trimmed);
        if (steps.length > 0) {
          console.log("[parseIntent] 产出 a11y_sequence（LLM null 时 planWithLocal），steps 数:", steps.length);
          return { kind: "a11y_sequence", steps: applySaveFlowFixes(trimmed, steps) };
        }
      } catch (e) {
        console.warn("[parseIntent] LLM null 时 planWithLocal 失败:", e);
      }
    }
    const ruleSteps = (hasCompoundActionKeywords(trimmed) || hasWebGenIntent(trimmed)) ? buildRuleFallbackSteps(trimmed) : null;
    if (ruleSteps && ruleSteps.length > 0) {
      const steps = applySaveFlowFixes(trimmed, ruleSteps);
      console.log("[parseIntent] 产出 a11y_sequence，steps 数:", steps.length, "（规则兜底）");
      return { kind: "a11y_sequence", steps };
    }
    const openFallback = openTargetFallback(trimmed);
    if (openFallback !== null) {
      console.log("[parseIntent] LLM 返回 null，使用 open_target 回退", openFallback);
      return openFallback;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parseIntent] LLM 调用失败，回退关键词:", msg);
    if (msg.includes("Connection")) {
      console.error("[parseIntent] 提示：请确认 Ollama 已启动，且 .env 中 OPENAI_BASE_URL 为 http://127.0.0.1:11434/v1");
    }
  }
  if (hasCompoundActionKeywords(trimmed)) {
    try {
      const steps = await planWithLocal(trimmed);
      if (steps.length > 0) {
        console.log("[parseIntent] 产出 a11y_sequence（异常后 planWithLocal），steps 数:", steps.length);
        return { kind: "a11y_sequence", steps: applySaveFlowFixes(trimmed, steps) };
      }
    } catch (e) {
      console.warn("[parseIntent] 异常后 planWithLocal 失败:", e);
    }
  }
  const ruleSteps = (hasCompoundActionKeywords(trimmed) || hasWebGenIntent(trimmed)) ? buildRuleFallbackSteps(trimmed) : null;
  if (ruleSteps && ruleSteps.length > 0) {
    const steps = applySaveFlowFixes(trimmed, ruleSteps);
    console.log("[parseIntent] 产出 a11y_sequence，steps 数:", steps.length, "（规则兜底）");
    return { kind: "a11y_sequence", steps };
  }
  const openFallback = openTargetFallback(trimmed);
  if (openFallback !== null) return openFallback;
  return keywordFallback(input);
}

/** 判断是否为可创建任务的 payload（非 run_next） */
export function isCreateTaskIntent(intent: IntentResult): intent is SnapshotClickIntent {
  return intent !== null && intent.kind === "snapshot_and_click_review";
}

/** 判断是否为多步任务链 */
export function isMultiStepIntent(intent: IntentResult): intent is MultiStepIntent {
  return intent !== null && intent.kind === "multi_step";
}

/** 判断是否为资源猎人意图 */
export function isResourceHuntIntent(intent: IntentResult): intent is ResourceHuntIntent {
  return intent !== null && intent.kind === "resource_hunt";
}

/** 判断是否为长周期计划意图 */
export function isLongPlanIntent(intent: IntentResult): intent is LongPlanIntent {
  return intent !== null && intent.kind === "long_plan";
}

// ─── 长计划检测：通过 DeepSeek 云端 LLM 解析复杂长周期任务 ───

const LONG_PLAN_KEYWORDS = [
  /(\d+)\s*天内/, /(\d+)\s*小时内/, /一周内/, /本周/, /今天/,
  /每天/, /每周/, /定时/, /定期/, /长期/,
  /收集.*整理/, /下载.*整理/, /生产.*发布/,
  /阶段/, /步骤/, /计划/,
];

function looksLikeLongPlan(input: string): boolean {
  const t = input.trim();
  if (t.length < 10) return false;
  let score = 0;
  for (const re of LONG_PLAN_KEYWORDS) {
    if (re.test(t)) score++;
  }
  if (/完成.*[，,].*[，,]/.test(t)) score++;
  if (t.length > 40) score++;
  return score >= 2;
}

function extractPriority(input: string): "high" | "medium" | "low" {
  const t = input.toLowerCase();
  if (/紧急|马上|立刻|immediately|urgent|赶紧|尽快/.test(t)) return "high";
  if (/不急|空了再|有空|low|低优先/.test(t)) return "low";
  return "medium";
}

function extractDeadline(input: string): string | undefined {
  const dayMatch = input.match(/(\d+)\s*天内/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }
  const hourMatch = input.match(/(\d+)\s*小时内/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1], 10);
    const d = new Date();
    d.setHours(d.getHours() + hours);
    return d.toISOString();
  }
  if (/今天/.test(input)) return new Date().toISOString().split("T")[0];
  if (/本周|一周内/.test(input)) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split("T")[0];
  }
  return undefined;
}

const LONG_PLAN_SYSTEM_PROMPT = `你是任务规划引擎。用户描述一个复杂任务，你将其拆解为多阶段执行计划。
输出严格的 JSON，格式：
{
  "name": "计划名称",
  "stages": [
    { "name": "阶段名", "kind": "阶段类型", "description": "具体描述", "dependsOnStageIndex": [] }
  ],
  "config": { "savePath": "保存路径(可选)", "format": "输出格式(可选)" }
}

阶段 kind 可选值：
- "collect_resources": 搜索/收集资料
- "download": 下载文件/资源
- "write_document": 撰写文档/材料
- "generate_content": AI 生成内容（文案/图片/视频）
- "organize_files": 整理/分类文件
- "publish": 发布到平台
- "export": 导出文件
- "verify": 校验结果
- "a11y_sequence": 桌面自动化操作链

dependsOnStageIndex：数组，填写本阶段依赖的前置阶段序号（0开始），如 [0] 表示依赖第1阶段完成后才执行。
无依赖时填 []。

规则：
1. 按逻辑顺序拆解，不能遗漏用户提到的每个环节
2. 合理设置依赖关系（如"写文档"依赖"收集资料"完成）
3. 可并行的阶段不要设置依赖（如"下载视频"和"搜索素材"可并行）
4. savePath 按用户说的路径填（如"D盘/规划"→"D:\\规划"），用户没说则不填

只输出 JSON，不要 markdown 包裹。`;

async function detectLongPlanIntent(input: string): Promise<LongPlanIntent | null> {
  if (!looksLikeLongPlan(input)) return null;

  const hasCloudKey = process.env.CLOUD_API_KEY?.trim() && process.env.CLOUD_API_KEY !== "ollama";
  if (!hasCloudKey) {
    return buildLocalLongPlan(input);
  }

  try {
    const { chatCompletion } = await import("../llm/apiClient.js");
    const { CLOUD_LLM } = await import("../config/llmConfig.js");

    const content = await chatCompletion({
      baseURL: CLOUD_LLM.baseURL,
      apiKey: CLOUD_LLM.apiKey,
      model: CLOUD_LLM.model,
      messages: [
        { role: "system", content: LONG_PLAN_SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      maxTokens: 2000,
      timeoutMs: 20000,
      jsonMode: true,
    });

    const raw = (content || "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(raw) as {
      name?: string;
      stages?: Array<{ name?: string; kind?: string; description?: string; dependsOnStageIndex?: number[] }>;
      config?: { savePath?: string; format?: string };
    };

    if (!parsed.stages || !Array.isArray(parsed.stages) || parsed.stages.length === 0) {
      return buildLocalLongPlan(input);
    }

    return {
      kind: "long_plan",
      name: parsed.name || input.slice(0, 30),
      priority: extractPriority(input),
      deadline: extractDeadline(input),
      stages: parsed.stages.map((s) => ({
        name: s.name || "未命名阶段",
        kind: s.kind || "a11y_sequence",
        description: s.description || "",
        dependsOnStageIndex: s.dependsOnStageIndex,
      })),
      config: {
        savePath: parsed.config?.savePath,
        format: parsed.config?.format,
      },
    };
  } catch (e) {
    console.warn("[parseIntent] 云端长计划解析失败，使用本地规则:", (e as Error).message);
    return buildLocalLongPlan(input);
  }
}

/** 本地规则兜底：简单拆解长计划 */
function buildLocalLongPlan(input: string): LongPlanIntent | null {
  const t = input.trim();
  const stages: LongPlanIntent["stages"] = [];

  if (/收集|搜索|查找|找/.test(t)) {
    stages.push({ name: "收集资料", kind: "collect_resources", description: "搜索和收集相关资料" });
  }
  if (/下载/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "下载资源", kind: "download", description: "下载目标资源", dependsOnStageIndex: idx });
  }
  if (/整理|分类|归档/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "整理文件", kind: "organize_files", description: "按类型/主题整理文件", dependsOnStageIndex: idx });
  }
  if (/写|撰写|编写|完成.*文档|完成.*材料|完成.*规划/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "撰写文档", kind: "write_document", description: "撰写目标文档", dependsOnStageIndex: idx });
  }
  if (/生成.*图|文生图|画/.test(t)) {
    stages.push({ name: "生成图片", kind: "generate_content", description: "AI 生成图片素材" });
  }
  if (/生成.*视频|图生视频/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "生成视频", kind: "generate_content", description: "生成短视频", dependsOnStageIndex: idx });
  }
  if (/导出|输出/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "导出", kind: "export", description: "导出最终文件", dependsOnStageIndex: idx });
  }
  if (/发布|发小红书|发抖音/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "发布", kind: "publish", description: "发布到目标平台", dependsOnStageIndex: idx });
  }
  if (/校验|检查|确认/.test(t)) {
    const idx = stages.length > 0 ? [stages.length - 1] : [];
    stages.push({ name: "校验结果", kind: "verify", description: "校验最终输出", dependsOnStageIndex: idx });
  }

  if (stages.length < 2) return null;

  const savePath = t.match(/(?:存|保存|导出)(?:到|至)\s*([A-Za-z]盘[\\/]?[\w\u4e00-\u9fa5/\\]*)/)?.[1]?.replace(/\//g, "\\");

  return {
    kind: "long_plan",
    name: t.slice(0, 40),
    priority: extractPriority(t),
    deadline: extractDeadline(t),
    stages,
    config: { savePath },
  };
}
