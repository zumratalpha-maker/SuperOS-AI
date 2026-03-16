/**
 * 懒加载场景拓展 — 遇到未知场景时，用 LLM 自动生成插件代码
 *
 * 流程：
 * 1. 用户输入无法被现有插件/意图识别
 * 2. 调用 LLM 分析场景需求，生成 IPlugin 实现代码
 * 3. 动态编译并注册到 PluginManager
 * 4. 持久化到 plugins/ 目录，后续启动自动加载
 */

import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { CLOUD_LLM } from "../config/llmConfig.js";
import { getPluginManager, type IPlugin } from "./pluginManager.js";

const GENERATED_DIR = join(import.meta.dirname ?? ".", "..", "plugins", "generated");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    const { mkdirSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 用 LLM 生成插件代码
 */
async function generatePluginCode(sceneName: string, userDescription: string): Promise<string | null> {
  if (!CLOUD_LLM.apiKey) {
    console.warn("[pluginGen] 无 Cloud API Key，无法生成插件");
    return null;
  }

  const systemPrompt = `你是 SuperOS 插件代码生成器。根据用户描述的场景，生成一个符合 IPlugin 接口的 TypeScript 插件。

插件接口定义：
\`\`\`typescript
interface IPlugin {
  manifest: {
    name: string;
    version: string;
    description: string;
    supportedKinds: string[];
    intentPatterns: RegExp[];
  };
  initialize(): Promise<void>;
  execute(context: { kind: string; payload: Record<string, unknown>; onProgress?: (p: number) => void }): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
  cleanup?(): Promise<void>;
}
\`\`\`

要求：
1. 输出完整可执行的 TypeScript 代码
2. export default 一个实现了 IPlugin 的对象
3. 使用 try-catch 包裹所有外部调用
4. 不要使用任何第三方库（只用 Node.js 内置模块和项目已有的模块）
5. 只输出代码，不要输出任何解释文字
6. 代码中不要包含 import 语句（运行时会通过 dynamic import 注入依赖）`;

  const userPrompt = `场景名称：${sceneName}
用户描述：${userDescription}

请生成对应的 IPlugin 插件代码。`;

  try {
    const resp = await fetch(`${CLOUD_LLM.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLOUD_LLM.apiKey}`,
      },
      body: JSON.stringify({
        model: CLOUD_LLM.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!resp.ok) {
      console.error("[pluginGen] LLM 请求失败:", resp.status, await resp.text().catch(() => ""));
      return null;
    }

    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "";

    const codeMatch = content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    return codeMatch ? codeMatch[1].trim() : content.trim();
  } catch (e) {
    console.error("[pluginGen] LLM 调用异常:", (e as Error).message);
    return null;
  }
}

/**
 * 将生成的代码保存到文件并尝试动态加载
 */
async function saveAndLoad(sceneName: string, code: string): Promise<IPlugin | null> {
  ensureDir(GENERATED_DIR);

  const safeName = sceneName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 30);
  const fileName = `gen_${safeName}_${Date.now()}.ts`;
  const filePath = join(GENERATED_DIR, fileName);

  writeFileSync(filePath, code, "utf-8");
  console.log(`[pluginGen] 插件代码已保存: ${filePath}`);

  try {
    const mod = await import(filePath);
    const plugin: IPlugin = mod.default ?? mod;

    if (!plugin.manifest || typeof plugin.execute !== "function") {
      console.error("[pluginGen] 生成的插件缺少 manifest 或 execute");
      return null;
    }

    return plugin;
  } catch (e) {
    console.error("[pluginGen] 动态加载失败:", (e as Error).message);
    return null;
  }
}

/**
 * 自动加载 generated/ 目录下的所有持久化插件
 */
export async function loadGeneratedPlugins(): Promise<number> {
  if (!existsSync(GENERATED_DIR)) return 0;

  const pm = getPluginManager();
  const files = readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  let loaded = 0;

  for (const file of files) {
    try {
      const mod = await import(join(GENERATED_DIR, file));
      const plugin: IPlugin = mod.default ?? mod;
      if (plugin.manifest && typeof plugin.execute === "function") {
        pm.register(plugin);
        loaded++;
      }
    } catch (e) {
      console.warn(`[pluginGen] 加载 ${file} 失败:`, (e as Error).message);
    }
  }

  if (loaded > 0) console.log(`[pluginGen] 已加载 ${loaded} 个自动生成的插件`);
  return loaded;
}

/**
 * 核心入口：尝试为未知场景生成并注册插件
 * 返回生成的插件（可立即执行），或 null（生成失败）
 */
export async function tryGeneratePlugin(
  sceneName: string,
  userDescription: string,
): Promise<IPlugin | null> {
  console.log(`[pluginGen] 尝试为场景「${sceneName}」自动生成插件…`);

  const code = await generatePluginCode(sceneName, userDescription);
  if (!code) {
    console.warn("[pluginGen] LLM 未返回有效代码");
    return null;
  }

  const plugin = await saveAndLoad(sceneName, code);
  if (!plugin) return null;

  const pm = getPluginManager();
  pm.register(plugin);
  console.log(`[pluginGen] 插件「${plugin.manifest.name}」已自动注册`);
  return plugin;
}

/**
 * 检查是否有匹配的生成插件能处理该输入
 */
export function hasGeneratedPluginFor(input: string): boolean {
  const pm = getPluginManager();
  const match = pm.matchByInput(input);
  return match !== null;
}
