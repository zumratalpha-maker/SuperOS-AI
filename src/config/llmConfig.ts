/**
 * 本地小模型 + 云端大模型 混合架构配置
 * 从 .env 读取，支持 OpenAI 兼容的 BASE_URL + API_KEY + MODEL
 *
 * 环境变量一览：
 * - 本地守门：OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
 * - 云端规划：CLOUD_API_BASE_URL (= API_BASE_URL), CLOUD_API_KEY (= API_KEY), CLOUD_API_MODEL (= API_MODEL_NAME)
 * - 开关：HYBRID_ROUTER=1 启用混合路由
 */

function env(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v !== undefined && v !== "" ? v : fallback;
}

/** 本地守门模型（Ollama，如 Llama3.2 3B）：仅做意图分类，省显存 */
export const LOCAL_LLM = {
  baseURL: env("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
  apiKey: env("OPENAI_API_KEY", "ollama"),
  model: env("OPENAI_MODEL", "llama3.2"),
};

/** 云端大模型 API（DeepSeek/Groq/OpenAI 等，OpenAI 兼容格式）：复杂 A11y 规划 */
export const CLOUD_LLM = {
  baseURL: env("CLOUD_API_BASE_URL", env("OPENAI_BASE_URL", "https://api.deepseek.com/v1")),
  apiKey: env("CLOUD_API_KEY", process.env.OPENAI_API_KEY ?? ""),
  model: env("CLOUD_API_MODEL", env("OPENAI_MODEL", "deepseek-chat")),
};

/** 是否启用混合路由（本地分类 + 云端复杂规划） */
export const HYBRID_ENABLED = env("HYBRID_ROUTER", "1") === "1" || process.env.HYBRID_ROUTER === "true";

/** 本地分类超时（毫秒） */
export const LOCAL_CLASSIFY_TIMEOUT_MS = Math.max(5000, parseInt(env("LOCAL_CLASSIFY_TIMEOUT_MS", "10000"), 10));

/** 视觉模型（Ollama llava）：截图定位、微信输入框视觉兜底，Local-First */
export const VISION_LLM = {
  baseURL: env("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
  apiKey: env("OPENAI_API_KEY", "ollama"),
  model: env("VISION_MODEL", "llava"),
};
