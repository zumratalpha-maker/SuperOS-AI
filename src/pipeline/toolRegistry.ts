/**
 * 创作工具注册表 — 统一管理所有文案/图片/视频/配音/口型/剪辑工具
 * 每个工具声明：类型、访问方式、是否需登录、登录URL、可用性检测
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_LLM } from "../config/llmConfig.js";

/**
 * 检测桌面是否有某个应用的快捷方式
 */
function hasDesktopShortcut(name: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    const desktop = join(process.env.USERPROFILE ?? "C:\\Users\\Administrator", "Desktop");
    const files = readdirSync(desktop);
    return files.some((f) => f.toLowerCase().includes(name.toLowerCase()) && f.endsWith(".lnk"));
  } catch { return false; }
}

function hasStartMenuEntry(name: string): boolean {
  if (process.platform !== "win32") return false;
  const dirs = [
    join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  ];
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir, { recursive: true }) as string[];
      if (files.some((f) => f.toLowerCase().includes(name.toLowerCase()))) return true;
    } catch { /* skip */ }
  }
  return false;
}

export type ToolCategory = "copywriting" | "image" | "video" | "voice" | "lipsync" | "editing";
export type AccessMethod = "api" | "puppeteer" | "local_app";

export interface CreativeTool {
  id: string;
  name: string;
  category: ToolCategory;
  accessMethod: AccessMethod;
  loginUrl?: string;
  needsLogin: boolean;
  isFree: boolean;
  limitations?: string;
  checkAvailable: () => Promise<boolean>;
}

// ─── 文案工具 ───

const deepseekCopywriting: CreativeTool = {
  id: "deepseek",
  name: "DeepSeek",
  category: "copywriting",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "按 token 计费，极低成本",
  checkAvailable: async () => !!(CLOUD_LLM.apiKey && CLOUD_LLM.apiKey !== "ollama"),
};

const gptCopywriting: CreativeTool = {
  id: "gpt",
  name: "ChatGPT",
  category: "copywriting",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "需 OpenAI API Key",
  checkAvailable: async () => !!(process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes("ollama")),
};

const claudeCopywriting: CreativeTool = {
  id: "claude",
  name: "Claude",
  category: "copywriting",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "需 Anthropic API Key",
  checkAvailable: async () => !!process.env.ANTHROPIC_API_KEY,
};

const geminiCopywriting: CreativeTool = {
  id: "gemini_copywriting",
  name: "Gemini 文案",
  category: "copywriting",
  accessMethod: "puppeteer",
  loginUrl: "https://gemini.google.com",
  needsLogin: true,
  isFree: true,
  limitations: "需 Google 账号，有每日限额",
  checkAvailable: async () => true,
};

const qwenCopywriting: CreativeTool = {
  id: "qwen",
  name: "通义千问",
  category: "copywriting",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "需 DashScope API Key",
  checkAvailable: async () => !!process.env.DASHSCOPE_API_KEY,
};

// ─── 图片生成工具 ───

const tongyiWanxiang: CreativeTool = {
  id: "tongyi_wanxiang",
  name: "通义万相",
  category: "image",
  accessMethod: "puppeteer",
  loginUrl: "https://tongyi.aliyun.com/wanxiang",
  needsLogin: true,
  isFree: true,
  limitations: "每天有免费额度",
  checkAvailable: async () => true,
};

const doubaoImage: CreativeTool = {
  id: "doubao",
  name: "豆包",
  category: "image",
  accessMethod: hasDesktopShortcut("豆包") || hasStartMenuEntry("豆包") ? "local_app" : "puppeteer",
  loginUrl: "https://www.doubao.com",
  needsLogin: hasDesktopShortcut("豆包") ? false : true,
  isFree: true,
  limitations: hasDesktopShortcut("豆包") ? "桌面已安装" : "免费，效果稳定",
  checkAvailable: async () => true,
};

const geminiImage: CreativeTool = {
  id: "gemini_image",
  name: "Gemini 图片",
  category: "image",
  accessMethod: "puppeteer",
  loginUrl: "https://gemini.google.com",
  needsLogin: true,
  isFree: true,
  limitations: "需 Google 账号",
  checkAvailable: async () => true,
};

const grokImage: CreativeTool = {
  id: "grok",
  name: "Grok",
  category: "image",
  accessMethod: hasDesktopShortcut("Grok") || hasDesktopShortcut("grok") ? "local_app" : "puppeteer",
  loginUrl: "https://x.com/i/grok",
  needsLogin: hasDesktopShortcut("Grok") ? false : true,
  isFree: true,
  limitations: hasDesktopShortcut("Grok") ? "桌面已安装" : "需 X/Twitter 账号",
  checkAvailable: async () => true,
};

const chatgptImage: CreativeTool = {
  id: "chatgpt_dalle",
  name: "ChatGPT / DALL-E",
  category: "image",
  accessMethod: "puppeteer",
  loginUrl: "https://chat.openai.com",
  needsLogin: true,
  isFree: false,
  limitations: "需 ChatGPT Plus 订阅",
  checkAvailable: async () => true,
};

const midjourneyImage: CreativeTool = {
  id: "midjourney",
  name: "Midjourney",
  category: "image",
  accessMethod: "puppeteer",
  loginUrl: "https://www.midjourney.com",
  needsLogin: true,
  isFree: false,
  limitations: "需付费订阅",
  checkAvailable: async () => true,
};

const localSD: CreativeTool = {
  id: "stable_diffusion",
  name: "Stable Diffusion (本地)",
  category: "image",
  accessMethod: "local_app",
  needsLogin: false,
  isFree: true,
  limitations: "需本地安装 SD WebUI，需显卡",
  checkAvailable: async () => {
    try {
      const r = await fetch("http://127.0.0.1:7860/sdapi/v1/options", { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  },
};

// ─── 视频生成工具 ───

const klingVideo: CreativeTool = {
  id: "kling",
  name: "可灵",
  category: "video",
  accessMethod: "puppeteer",
  loginUrl: "https://klingai.kuaishou.com",
  needsLogin: true,
  isFree: false,
  limitations: "每天有免费额度",
  checkAvailable: async () => true,
};

const jimengVideo: CreativeTool = {
  id: "jimeng",
  name: "即梦",
  category: "video",
  accessMethod: "puppeteer",
  loginUrl: "https://jimeng.jianying.com",
  needsLogin: true,
  isFree: true,
  limitations: "免费额度较多",
  checkAvailable: async () => true,
};

const runwayVideo: CreativeTool = {
  id: "runway",
  name: "Runway",
  category: "video",
  accessMethod: "puppeteer",
  loginUrl: "https://app.runwayml.com",
  needsLogin: true,
  isFree: false,
  limitations: "需付费，画质高",
  checkAvailable: async () => true,
};

const pikaVideo: CreativeTool = {
  id: "pika",
  name: "Pika",
  category: "video",
  accessMethod: "puppeteer",
  loginUrl: "https://pika.art",
  needsLogin: true,
  isFree: false,
  limitations: "有免费试用额度",
  checkAvailable: async () => true,
};

// ─── 配音工具 ───

const systemTTS: CreativeTool = {
  id: "system_tts",
  name: "系统 TTS",
  category: "voice",
  accessMethod: "local_app",
  needsLogin: false,
  isFree: true,
  limitations: "Windows 内置，质量一般",
  checkAvailable: async () => process.platform === "win32",
};

const xunfeiTTS: CreativeTool = {
  id: "xunfei",
  name: "讯飞语音合成",
  category: "voice",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "需讯飞 API Key",
  checkAvailable: async () => !!process.env.XUNFEI_API_KEY,
};

const elevenLabsTTS: CreativeTool = {
  id: "elevenlabs",
  name: "ElevenLabs",
  category: "voice",
  accessMethod: "api",
  needsLogin: false,
  isFree: false,
  limitations: "需 ElevenLabs API Key，质量最高",
  checkAvailable: async () => !!process.env.ELEVENLABS_API_KEY,
};

// ─── 口型同步工具 ───

const heygenLipsync: CreativeTool = {
  id: "heygen",
  name: "HeyGen 数字人",
  category: "lipsync",
  accessMethod: "puppeteer",
  loginUrl: "https://app.heygen.com",
  needsLogin: true,
  isFree: false,
  limitations: "有免费试用额度",
  checkAvailable: async () => true,
};

const didLipsync: CreativeTool = {
  id: "d_id",
  name: "D-ID",
  category: "lipsync",
  accessMethod: "puppeteer",
  loginUrl: "https://studio.d-id.com",
  needsLogin: true,
  isFree: false,
  limitations: "有免费试用额度",
  checkAvailable: async () => true,
};

// ─── 剪辑工具 ───

const jianyingEditor: CreativeTool = {
  id: "jianying",
  name: "剪映",
  category: "editing",
  accessMethod: "local_app",
  needsLogin: false,
  isFree: true,
  limitations: "需本地安装",
  checkAvailable: async () => {
    const paths = [
      "C:\\Program Files\\JianyingPro\\JianyingPro.exe",
      "C:\\Program Files (x86)\\JianyingPro\\JianyingPro.exe",
    ];
    return paths.some(existsSync);
  },
};

// ─── 注册表 ───

const ALL_TOOLS: CreativeTool[] = [
  deepseekCopywriting, gptCopywriting, claudeCopywriting, geminiCopywriting, qwenCopywriting,
  tongyiWanxiang, doubaoImage, geminiImage, grokImage, chatgptImage, midjourneyImage, localSD,
  klingVideo, jimengVideo, runwayVideo, pikaVideo,
  systemTTS, xunfeiTTS, elevenLabsTTS,
  heygenLipsync, didLipsync,
  jianyingEditor,
];

const toolMap = new Map<string, CreativeTool>();
for (const t of ALL_TOOLS) toolMap.set(t.id, t);

export function getToolById(id: string): CreativeTool | undefined {
  return toolMap.get(id);
}

export function getToolsByCategory(category: ToolCategory): CreativeTool[] {
  return ALL_TOOLS.filter((t) => t.category === category);
}

export async function getAvailableTools(category: ToolCategory): Promise<CreativeTool[]> {
  const tools = getToolsByCategory(category);
  const results: CreativeTool[] = [];
  for (const t of tools) {
    if (await t.checkAvailable()) results.push(t);
  }
  return results;
}

export function getAllTools(): CreativeTool[] {
  return [...ALL_TOOLS];
}

/**
 * 为指定类别推荐最优工具（优先 API > 免费 > Puppeteer）
 */
export async function recommendTool(category: ToolCategory): Promise<CreativeTool | null> {
  const available = await getAvailableTools(category);
  if (available.length === 0) return null;

  const apiTools = available.filter((t) => t.accessMethod === "api");
  if (apiTools.length > 0) return apiTools[0];

  const freeTools = available.filter((t) => t.isFree);
  if (freeTools.length > 0) return freeTools[0];

  return available[0];
}

/**
 * 格式化工具列表供用户选择
 */
export function formatToolChoices(tools: CreativeTool[]): string {
  return tools.map((t, i) => {
    const tags: string[] = [];
    if (t.isFree) tags.push("免费");
    if (t.accessMethod === "local_app") tags.push("桌面App");
    else if (t.needsLogin) tags.push("需登录");
    if (t.accessMethod === "api") tags.push("API");
    const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `  ${i + 1}. ${t.name}${tagStr}${t.limitations ? " — " + t.limitations : ""}`;
  }).join("\n");
}

/**
 * 扫描用户桌面已安装的创作类应用
 */
export function scanDesktopApps(): { found: string[]; tools: CreativeTool[] } {
  const knownApps = ["豆包", "Grok", "剪映", "Canva", "ChatGPT", "Claude"];
  const found: string[] = [];
  for (const app of knownApps) {
    if (hasDesktopShortcut(app) || hasStartMenuEntry(app)) {
      found.push(app);
    }
  }
  const matchedTools = ALL_TOOLS.filter((t) =>
    found.some((f) => t.name.toLowerCase().includes(f.toLowerCase())),
  );
  return { found, tools: matchedTools };
}
