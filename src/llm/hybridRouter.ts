/**
 * 混合路由：本地小模型守门（意图分类） + 云端大模型干重活（复杂 A11y 规划）
 */

import { chatCompletion } from "./apiClient.js";
import { LOCAL_LLM, CLOUD_LLM, LOCAL_CLASSIFY_TIMEOUT_MS } from "../config/llmConfig.js";

export type RouteClass = "SIMPLE_OS_ACTION" | "CHAT" | "COMPLEX_A11Y_PLANNING";

export type A11yStep =
  | { type: "open_app"; app: string }
  | { type: "type"; text: string }
  | { type: "generate_and_type"; prompt: string }
  | { type: "click"; name: string }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right" };

const LOCAL_CLASSIFY_PROMPT = `你只做一件事：判断用户这句话属于哪一类，只输出一个英文标签，不要任何解释。
- SIMPLE_OS_ACTION：仅打开软件/网页、点搜索/扩展、执行、资源搜索、建文件夹等单一操作（句子里没有「写/输入/保存/点击/发/说」等后续动作）
- CHAT：仅限纯闲聊——如「你好」「在吗」「你能做什么」「今天天气怎样」，且句中没有「打开/发/写/点/发消息/给X说」等操作意图。一旦有明确动作（打开某应用、发消息给某人、给X说Y、写X、点X），必须标 COMPLEX 或 SIMPLE，不得标 CHAT。
- COMPLEX_A11Y_PLANNING：只要句子里同时有「打开」和「写/输入/保存/点击/点/另存为/发/发送/发消息/说」等任一动作词，必须标此类。例如：打开记事本写诗、打开微信给某人发消息、打开微信给阿尔法说我很忙、打开X输入Y保存到桌面、打开X点文件保存。

用户输入：`;

/**
 * 本地小模型（Ollama）做意图分类，仅返回三类之一
 */
export async function classifyWithLocal(userInput: string): Promise<RouteClass> {
  const content = await chatCompletion({
    baseURL: LOCAL_LLM.baseURL,
    apiKey: LOCAL_LLM.apiKey,
    model: LOCAL_LLM.model,
    messages: [
      { role: "system", content: "只输出一个标签：SIMPLE_OS_ACTION、CHAT 或 COMPLEX_A11Y_PLANNING。" },
      { role: "user", content: LOCAL_CLASSIFY_PROMPT + userInput },
    ],
    maxTokens: 32,
    timeoutMs: LOCAL_CLASSIFY_TIMEOUT_MS,
  });
  const label = (content || "").trim().toUpperCase().replace(/\s+/g, "_");
  if (label.includes("COMPLEX_A11Y") || label === "COMPLEX_A11Y_PLANNING") return "COMPLEX_A11Y_PLANNING";
  if (label.includes("CHAT")) return "CHAT";
  return "SIMPLE_OS_ACTION";
}

const CLOUD_PLAN_SYSTEM = `你输出 JSON，仅含 "steps" 数组。必须按用户指令拆分出所有步骤，不能省略。
例如「打开记事本写一首诗」必须输出至少 2 步：open_app 记事本 + type（含你创作的短诗全文）。
「打开X并写Y」类指令：第一步 open_app，第二步 type 或 generate_and_type，缺一不可。`;

const CLOUD_PLAN_PROMPT = `你根据「当前 UI 树摘要」和「用户指令」，输出一个 JSON，且只包含一个 key "steps"，值为步骤数组。
每一步只能是以下之一：
- {"type":"open_app","app":"应用名"}
- {"type":"type","text":"要输入的文字"}
- {"type":"generate_and_type","prompt":"生成指令（短篇小说约1500字、长文可指定字数）"}
- {"type":"click","name":"按钮/菜单/项的名称"}
- {"type":"scroll","direction":"up|down|left|right"}

要求：
1. 步骤顺序与用户描述一致；名称必须从 UI 树中出现的可交互元素里选（如「文件」「保存」「另存为」等）。
2. 关键：用户说「打开X写Y/写一首诗」时，steps 必须至少 2 步——第一步 open_app，第二步 type（写诗时在 text 中直接输出你创作的 4-8 行诗）或 generate_and_type（长文时用）。
   - 错误示例：仅 [{"type":"open_app","app":"记事本"}]  ❌
   - 正确示例：[{"type":"open_app","app":"记事本"},{"type":"type","text":"春风拂面暖\\n花开满枝头\\n..."}]  ✓
3. 写文案/文生图：必须 open_app 豆包或通义万相或 Gemini + wait + click 输入 + type prompt + click 生成，禁止 generate_and_type。
4. 若用户说「保存到桌面」，在 click 保存/另存为后加 click 桌面、type 文件名、再 click 保存。

只输出 JSON，不要 markdown 包裹，不要解释。

当前 UI 树摘要（仅可交互节点）：
`;

const LOCAL_PLAN_PROMPT = `根据用户指令，只输出一行 JSON，格式：{"kind":"a11y_sequence","steps":[步骤数组]}。
每一步只能是：{"type":"open_app","app":"应用名"} 或 {"type":"type","text":"文字"} 或 {"type":"generate_and_type","prompt":"生成指令"} 或 {"type":"click","name":"按钮/菜单名"} 或 {"type":"scroll","direction":"up|down|left|right"}。
按用户描述顺序写 steps。重要：当用户说「写一首诗」「写X」时，必须生成实际内容放进 type 的 text，不能省略或用占位符。
- 写诗：在 type 中输出你创作的一首短诗（4-8行），例如 [{"type":"type","text":"春风拂面暖\n花开满枝头\n..."}]
- 写小说/写文章/写长文：用 {"type":"generate_and_type","prompt":"写一个短篇小说，1500字左右"} 让系统后续生成
- 写文案/文生图/生成图片：必须用网页操作，禁止 generate_and_type。例如「写一篇关于春天的文案」→ open_app Gemini + wait + click 输入 + type "请写一段关于春天的短视频文案" + keys Enter；「用通义万相生成一张猫的图」→ open_app 通义万相 + wait + click 输入框 + type "一只橘色猫" + click 生成创意画作。
- 发微信：用户说「给X发消息：内容」或「打开微信给X发：内容」时，steps 必须包含 open_app 微信 + click X（或搜索选人） + {"type":"type","text":"用户说的内容"}。若用户已写出具体内容（冒号后），必须在 type.text 填入；若没说内容，text 可为空，系统会再问。
- Excel：打开 Excel + 输入 + 保存 → open_app Excel + type 内容 + click 文件 + click 另存为/保存 + [click 桌面] + type 文件名 + click 保存。文件名常用 .xlsx。
- 剪映：打开剪映 + 导出 → open_app 剪映 + click 导出（或 文件→导出） + type 文件名 + click 导出/确定。剪映菜单多为中文。
若用户说「保存到桌面」，在 click 保存打开另存为后必须加 {"type":"click","name":"桌面"} 再 type 文件名再 click 保存。
只输出 JSON，不要解释。

用户指令：`;

/** 从原始文本中提取 steps 数组（阶段 3.2：JSON 格式轻微偏差时兜底） */
function extractStepsFromRaw(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: { steps?: unknown[]; a11y_sequence?: { steps?: unknown[] } };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    // 正则兜底：尝试提取 "steps":[ ... ] 或 "steps": [ ... ]
    const stepsMatch = trimmed.match(/"steps"\s*:\s*\[/);
    if (stepsMatch && stepsMatch.index != null) {
      const start = stepsMatch.index + stepsMatch[0].length - 1; // 从 [ 开始
      let depth = 0;
      let end = -1;
      for (let i = start; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end > start) {
        try {
          const arr = JSON.parse(trimmed.slice(start, end));
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      }
    }
    return [];
  }
  let steps: unknown[] = Array.isArray(parsed.steps) ? parsed.steps : [];
  if (steps.length === 0 && parsed?.a11y_sequence && Array.isArray(parsed.a11y_sequence.steps)) {
    steps = parsed.a11y_sequence.steps;
  }
  return steps;
}

/** 无云端 Key 时用本地小模型做 a11y 步骤规划（省显存、能跑完多步） */
export async function planWithLocal(userInput: string): Promise<A11yStep[]> {
  const content = await chatCompletion({
    baseURL: LOCAL_LLM.baseURL,
    apiKey: LOCAL_LLM.apiKey,
    model: LOCAL_LLM.model,
    messages: [
      { role: "system", content: "只输出一行合法 JSON，包含 kind 和 steps。" },
      { role: "user", content: LOCAL_PLAN_PROMPT + userInput },
    ],
    maxTokens: 512,
    timeoutMs: 15000,
  });
  const raw = (content || "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
  const steps = extractStepsFromRaw(raw);
  const out: A11yStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (o.type === "open_app" && typeof o.app === "string") {
      out.push({ type: "open_app", app: o.app.trim() });
    } else if (o.type === "type" && typeof o.text === "string") {
      out.push({ type: "type", text: o.text.trim() });
    } else if (o.type === "generate_and_type" && typeof o.prompt === "string") {
      out.push({ type: "generate_and_type", prompt: o.prompt.trim() });
    } else if (o.type === "click" && typeof o.name === "string") {
      out.push({ type: "click", name: o.name.trim() });
    } else if (o.type === "scroll" && typeof o.direction === "string") {
      const d = (o.direction as string).toLowerCase();
      if (["up", "down", "left", "right"].includes(d)) {
        out.push({ type: "scroll", direction: d as "up" | "down" | "left" | "right" });
      }
    }
  }
  return out;
}

/**
 * 云端大模型根据压缩后的 A11y 树 + 用户指令，生成 a11y_sequence 的 steps
 */
export async function planWithCloud(
  userInput: string,
  compressedA11yJson: string
): Promise<A11yStep[]> {
  if (!CLOUD_LLM.apiKey || CLOUD_LLM.apiKey === "ollama") {
    throw new Error("CLOUD_API_KEY 未配置，无法进行复杂 A11y 规划");
  }
  const content = await chatCompletion({
    baseURL: CLOUD_LLM.baseURL,
    apiKey: CLOUD_LLM.apiKey,
    model: CLOUD_LLM.model,
    messages: [
      {
        role: "system",
        content:
          '你输出 A11y 步骤数组。规则：用户说「打开X并写Y」时必须至少2步：{"type":"open_app","app":"X"} 和 {"type":"type","text":"Y内容"}。写诗时在 type.text 中直接输出完整诗句，不能只有 open_app。',
      },
      {
        role: "user",
        content: CLOUD_PLAN_PROMPT + compressedA11yJson + "\n\n用户指令：" + userInput,
      },
    ],
    maxTokens: 1024,
    timeoutMs: 25000,
    jsonMode: true,
  });
  const raw = (content || "").trim();
  const parsed = JSON.parse(raw) as { steps?: unknown[] };
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const out: A11yStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (o.type === "open_app" && typeof o.app === "string") {
      out.push({ type: "open_app", app: o.app.trim() });
    } else if (o.type === "type" && typeof o.text === "string") {
      out.push({ type: "type", text: o.text.trim() });
    } else if (o.type === "generate_and_type" && typeof o.prompt === "string") {
      out.push({ type: "generate_and_type", prompt: o.prompt.trim() });
    } else if (o.type === "click" && typeof o.name === "string") {
      out.push({ type: "click", name: o.name.trim() });
    } else if (o.type === "scroll" && typeof o.direction === "string") {
      const d = (o.direction as string).toLowerCase();
      if (["up", "down", "left", "right"].includes(d)) {
        out.push({ type: "scroll", direction: d as "up" | "down" | "left" | "right" });
      }
    }
  }
  return out;
}
