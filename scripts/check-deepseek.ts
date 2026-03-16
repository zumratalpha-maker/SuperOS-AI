/**
 * 检查 DeepSeek Key 是否配置并可用
 * 运行: npx tsx scripts/check-deepseek.ts
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 优先用当前工作目录的 .env（与 npm scripts 行为一致），否则用脚本目录的上级
const envPath = resolve(process.cwd(), ".env");
const result = config({ path: envPath, encoding: "utf8", override: true });
// 若 dotenv 解析异常，尝试手动读取（兼容 Windows 编码/解析问题）
let key = process.env.CLOUD_API_KEY?.trim();
if (!key && result.parsed?.CLOUD_API_KEY) {
  key = String(result.parsed.CLOUD_API_KEY).trim();
}
if (!key) {
  const { readFileSync, existsSync } = await import("fs");
  const { dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const tryPaths = [envPath];
  if (typeof import.meta.url !== "undefined") {
    tryPaths.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
  }
  for (const p of tryPaths) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*CLOUD_API_KEY\s*=\s*(.+)$/);
      if (m) {
        const val = m[1].trim().replace(/^["']|["']$/g, "");
        if (val && val !== "ollama") {
          key = val;
          break;
        }
      }
    }
    if (key) break;
  }
}
const url = process.env.CLOUD_API_BASE_URL || "https://api.deepseek.com/v1";

console.log("=== DeepSeek 连接检查 ===");
console.log("CLOUD_API_KEY:", key ? `已设置 (sk-...${key.slice(-6)})` : "未设置");
console.log("CLOUD_API_BASE_URL:", url);
console.log("CLOUD_API_MODEL:", process.env.CLOUD_API_MODEL || "deepseek-chat");
console.log("");

if (!key || key === "ollama") {
  // 调试：直接读文件看实际内容（排查编码/缓存问题）
  try {
    const { readFileSync } = await import("fs");
    const buf = readFileSync(envPath);
    const raw = buf.toString("utf8");
    const line = raw.split(/\r?\n/).find((l) => l.includes("CLOUD_API_KEY"));
    console.log("[调试] 文件首字节:", buf[0], buf[1], buf[2], "| 找到行:", JSON.stringify(line?.slice(0, 60)));
  } catch (_) {}
  console.log("结论: 未配置或无效");
  console.log("请检查 .env 中 CLOUD_API_KEY=sk-xxx 是否正确填写");
  console.log("  → 确保已保存文件，且等号后有完整 Key（当前读取:", envPath, ")");
  process.exit(1);
}

console.log("正在测试 API 调用...");
try {
  const res = await fetch(url.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: process.env.CLOUD_API_MODEL || "deepseek-chat",
      messages: [{ role: "user", content: "回复ok" }],
      max_tokens: 5,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  console.log("结论: 连接成功");
  console.log("返回:", content?.trim());
} catch (e) {
  console.log("结论: 连接失败");
  console.log("错误:", (e as Error).message);
  if ((e as Error).message?.includes("401")) console.log("  → API Key 无效或已过期");
  if ((e as Error).message?.includes("403")) console.log("  → 无权限或余额不足");
  process.exit(1);
}
