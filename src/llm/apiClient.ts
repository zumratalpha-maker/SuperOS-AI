/**
 * 通用 OpenAI 兼容 API 客户端：支持本地 Ollama 与云端 DeepSeek/Groq 等
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 视觉消息：content 可为 string 或 文本+图片 数组（OpenAI 多模态格式） */
export type VisionContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface VisionChatMessage {
  role: "system" | "user" | "assistant";
  content: string | VisionContentPart[];
}

export interface ApiClientOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** 是否要求 JSON 输出（部分云端 API 支持） */
  jsonMode?: boolean;
}

/**
 * 调用 OpenAI 兼容的 chat 接口，返回 assistant 的 content 文本
 */
export async function chatCompletion(options: ApiClientOptions): Promise<string> {
  const {
    baseURL,
    apiKey,
    model,
    messages,
    maxTokens = 1024,
    timeoutMs = 30000,
    jsonMode = false,
  } = options;

  const url = baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey ? `Bearer ${apiKey}` : "Bearer ollama",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    return content;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

export interface VisionChatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: VisionChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

/**
 * 视觉 Chat：支持 image_url 的多模态调用（用于截图定位等）
 * 消息中 content 可为数组，含 type: "image_url" 的图片
 */
export async function visionChatCompletion(options: VisionChatOptions): Promise<string> {
  const {
    baseURL,
    apiKey,
    model,
    messages,
    maxTokens = 256,
    timeoutMs = 15000,
    jsonMode = true,
  } = options;

  const url = baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey ? `Bearer ${apiKey}` : "Bearer ollama",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vision API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}
