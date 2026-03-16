/**
 * 文生图模块
 * Phase C 场景一：分镜 prompt → 生成图片 → 保存路径
 * 支持：SD WebUI 本地、通义万相 API、Replicate API
 * 优先级：SD WebUI（Local-First）> 通义万相 > Replicate
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

function env(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v !== undefined && v !== "" ? v : fallback;
}

const SD_WEBUI_URL = env("SD_WEBUI_URL", "http://127.0.0.1:7860");
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN?.trim() ?? "";

/** Replicate FLUX Schnell：可用 REPLICATE_FLUX_VERSION 覆盖，格式 owner/name:hash */
const REPLICATE_FLUX_VERSION =
  env("REPLICATE_FLUX_VERSION", "black-forest-labs/flux-schnell:9945f2ac64073452f2c2e0c71a88cb8f8c64af26c97e46d58a05d8b94c2c3c24");

export interface TextToImageOptions {
  /** 输出目录，默认 process.cwd()/output/images */
  outDir?: string;
  /** 输出文件名前缀，默认 scene_ */
  prefix?: string;
  /** 第几张图（用于生成 scene_001.png 等） */
  index?: number;
}

/**
 * 文生图：prompt → 图片文件路径
 * @param prompt 文生图提示词（英文，分镜 prompt）
 * @param options 输出选项
 * @returns 保存后的绝对路径
 */
export async function textToImage(
  prompt: string,
  options?: TextToImageOptions
): Promise<string> {
  const p = (prompt ?? "").trim();
  if (!p) throw new Error("文生图 prompt 不能为空");

  const outDir = options?.outDir ?? join(process.cwd(), "output", "images");
  const prefix = options?.prefix ?? "scene_";
  const index = options?.index ?? 0;
  const filename = `${prefix}${String(index).padStart(3, "0")}.png`;
  const outPath = join(outDir, filename);

  let imageData: Buffer | null = null;

  // 1. SD WebUI（本地，无需 Key）
  if (!imageData) {
    try {
      imageData = await textToImageSDWebUI(p, SD_WEBUI_URL);
    } catch (err) {
      console.warn("[mediaGen] SD WebUI 失败:", (err as Error)?.message?.slice(0, 80));
    }
  }

  // 2. 通义万相
  if (!imageData && DASHSCOPE_API_KEY) {
    try {
      imageData = await textToImageDashScope(p, DASHSCOPE_API_KEY);
    } catch (err) {
      console.warn("[mediaGen] 通义万相 失败:", (err as Error)?.message?.slice(0, 80));
    }
  }

  // 3. Replicate
  if (!imageData && REPLICATE_API_TOKEN) {
    try {
      imageData = await textToImageReplicate(p, REPLICATE_API_TOKEN);
    } catch (err) {
      console.warn("[mediaGen] Replicate 失败:", (err as Error)?.message?.slice(0, 80));
    }
  }

  if (!imageData) {
    throw new Error(
      "文生图失败：请确认 ① SD WebUI 已启动（--api）② 或配置 DASHSCOPE_API_KEY ③ 或配置 REPLICATE_API_TOKEN"
    );
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, imageData);
  return outPath;
}

/** SD WebUI：POST /sdapi/v1/txt2img，返回 base64 解码后 Buffer */
async function textToImageSDWebUI(prompt: string, baseUrl: string): Promise<Buffer> {
  const url = baseUrl.replace(/\/+$/, "") + "/sdapi/v1/txt2img";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      steps: 20,
      width: 1024,
      height: 1024,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`SD WebUI ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { images?: string[] };
  const b64 = json.images?.[0];
  if (!b64) throw new Error("SD WebUI 未返回 images");
  return Buffer.from(b64, "base64");
}

/** 通义万相 wan2.6：HTTP 同步调用 */
async function textToImageDashScope(prompt: string, apiKey: string): Promise<Buffer> {
  const url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "wan2.6-t2i",
      input: {
        messages: [{ role: "user", content: [{ text: prompt }] }],
      },
      parameters: {
        prompt_extend: true,
        watermark: false,
        n: 1,
        size: "1280*1280",
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`通义万相 ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    output?: { results?: Array<{ url?: string; message?: { content?: Array<{ image?: string }> } }> };
    code?: string;
  };
  if (json.code && json.code !== "") throw new Error(`通义万相 ${json.code}`);

  const results = json.output?.results;
  if (!results?.length) throw new Error("通义万相 未返回图片");

  const r0 = results[0];
  if (r0.url) {
    const imgRes = await fetch(r0.url, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`通义万相 图片下载失败 ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  const b64 = r0.message?.content?.[0]?.image;
  if (b64) return Buffer.from(b64, "base64");
  throw new Error("通义万相 未解析到图片");
}

/** Replicate：创建 prediction，Prefer: wait 同步等待 */
async function textToImageReplicate(prompt: string, token: string): Promise<Buffer> {
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Prefer: "wait=60",
    },
    body: JSON.stringify({
      version: REPLICATE_FLUX_VERSION,
      input: { prompt },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${await res.text()}`);

  const pred = (await res.json()) as {
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (pred.error) throw new Error(`Replicate: ${pred.error}`);
  if (pred.status !== "succeeded") throw new Error(`Replicate 未完成: ${pred.status}`);

  const out = pred.output;
  const url = Array.isArray(out) ? out[0] : out;
  if (!url || typeof url !== "string") throw new Error("Replicate 未返回图片 URL");

  const imgRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) throw new Error(`Replicate 图片下载失败 ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}
