/**
 * 快速测试 DeepSeek API 连接（CLOUD_API_KEY）
 * 运行: node scripts/test-deepseek.mjs
 */
import "dotenv/config";
import { chatCompletion } from "../dist/llm/apiClient.js";
import { CLOUD_LLM } from "../dist/config/llmConfig.js";

const key = process.env.CLOUD_API_KEY?.trim();
console.log("CLOUD_API_KEY 已配置:", !!key, key ? `(长度 ${key.length}，前缀 ${key.slice(0, 6)}...)` : "(未设置)");
console.log("CLOUD_API_BASE_URL:", CLOUD_LLM.baseURL);
console.log("CLOUD_API_MODEL:", CLOUD_LLM.model);
console.log("");

if (!key || key === "ollama") {
  console.log("❌ 未配置有效的 CLOUD_API_KEY，请在 .env 中设置");
  process.exit(1);
}

console.log("正在测试 API 连接...");
try {
  const content = await chatCompletion({
    baseURL: CLOUD_LLM.baseURL,
    apiKey: CLOUD_LLM.apiKey,
    model: CLOUD_LLM.model,
    messages: [{ role: "user", content: "只说一个字：好" }],
    maxTokens: 16,
    timeoutMs: 15000,
  });
  console.log("✅ DeepSeek 连接成功！");
  console.log("返回内容:", (content || "").trim().slice(0, 50));
} catch (err) {
  console.log("❌ 连接失败:", err.message);
  if (err.message?.includes("401")) console.log("   → 可能是 API Key 无效或已过期");
  if (err.message?.includes("403")) console.log("   → 可能是 Key 无权限或余额不足");
  process.exit(1);
}
