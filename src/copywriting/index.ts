/**
 * 短视频文案生成模块
 * Phase C 场景一：输入话题 → LLM 生成短视频文案 + 分镜
 * 支持 Ollama（本地）、豆包/DeepSeek（.env 配置 CLOUD_*）
 */

import { chatCompletion } from "../llm/apiClient.js";
import { CLOUD_LLM, LOCAL_LLM } from "../config/llmConfig.js";

const SYSTEM_PROMPT = `你是短视频文案撰稿人。根据用户给的话题，写一段适合短视频口播或配字的文案。
要求：
- 时长约 30～60 秒（100～200 字）
- 口语化、有节奏感
- 开门见山、结尾有记忆点
- 只输出正文，不要标题、不要解释、不要 markdown
- 若有分句，用换行分隔`;

/**
 * 根据话题生成短视频文案
 * @param topic 话题（如「春天的第一杯奶茶」「如何提高效率」）
 * @returns 文案正文（纯文本）
 */
export async function generateCopywriting(topic: string): Promise<string> {
  const t = (topic ?? "").trim();
  if (!t) throw new Error("话题不能为空");

  const userContent = `请为以下话题写一段短视频文案：${t}`;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: userContent },
  ];

  // 优先云端（DeepSeek/豆包等）创意更好；无配置则用本地 Ollama
  const configs = [CLOUD_LLM, LOCAL_LLM];
  for (const cfg of configs) {
    const base = (cfg.baseURL ?? "").trim();
    if (!base) continue;
    try {
      const content = await chatCompletion({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey ?? "ollama",
        model: cfg.model,
        messages,
        maxTokens: 512,
        timeoutMs: 45000,
      });
      const text = (content ?? "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
      if (text) return text;
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (base.includes("127.0.0.1") || base.includes("localhost")) {
        console.warn("[copywriting] 本地 LLM 失败，尝试下一配置:", msg.slice(0, 80));
      } else {
        console.warn("[copywriting] 云端 LLM 失败，回退本地:", msg.slice(0, 80));
      }
    }
  }
  throw new Error("文案生成失败：请确认 Ollama 已启动，或 .env 中 CLOUD_API_BASE_URL 与 API Key 正确");
}

/** 分镜项：scene 为旁白/文案，prompt 为文生图描述 */
export interface StoryboardItem {
  scene: string;
  prompt: string;
}

const STORYBOARD_SYSTEM = `你是短视频分镜师。将文案按句/段拆分为多个镜头，每个镜头输出：
- scene：该镜头旁白/台词原文（中文）
- prompt：该镜头画面的英文描述，供文生图（SD/通义万相等），约 30～80 词，含风格、构图、光影
只输出 JSON 数组：[{"scene":"...","prompt":"..."}]，不要 markdown 包裹、不要解释`;

/**
 * 将文案拆分为分镜数组（供后续文生图使用）
 * @param copywriting 完整文案
 * @returns [{ scene, prompt }]
 */
export async function generateStoryboard(copywriting: string): Promise<StoryboardItem[]> {
  const text = (copywriting ?? "").trim();
  if (!text) throw new Error("文案不能为空");

  const messages = [
    { role: "system" as const, content: STORYBOARD_SYSTEM },
    { role: "user" as const, content: `请将以下文案拆分为分镜：\n\n${text}` },
  ];

  const configs = [CLOUD_LLM, LOCAL_LLM];
  for (const cfg of configs) {
    const base = (cfg.baseURL ?? "").trim();
    if (!base) continue;
    try {
      const content = await chatCompletion({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey ?? "ollama",
        model: cfg.model,
        messages,
        maxTokens: 1024,
        timeoutMs: 45000,
      });
      const raw = (content ?? "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
      const arr = parseStoryboardJson(raw);
      if (arr.length > 0) return arr;
    } catch (_) {
      /* 解析失败，继续尝试下一 config */
    }
  }
  // 兜底：将文案整体作为单镜头
  const lines = text.split(/\n+/).filter((l) => l.trim());
  if (lines.length > 0) {
    return lines.map((scene) => ({ scene, prompt: `${scene}, cinematic, storytelling atmosphere` }));
  }
  return [{ scene: text, prompt: "cinematic scene, storytelling atmosphere" }];
}

function parseStoryboardJson(raw: string): StoryboardItem[] {
  const out: StoryboardItem[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        parsed = JSON.parse(arrMatch[0]);
      } catch {
        return [];
      }
    } else return [];
  }
  let arr: unknown[] = Array.isArray(parsed) ? parsed : [];
  if (arr.length === 0 && parsed && typeof parsed === "object" && "shots" in parsed) {
    arr = Array.isArray((parsed as { shots: unknown }).shots) ? (parsed as { shots: unknown[] }).shots : [];
  }
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const scene = typeof o.scene === "string" ? o.scene.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    if (scene && prompt) out.push({ scene, prompt });
  }
  return out;
}
