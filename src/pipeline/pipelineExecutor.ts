/**
 * 流水线执行器 — 按模板步骤逐步执行，调用对应工具适配器
 * 支持：逐步执行、checkpoint 确认、失败切换备选工具、数据传递
 */

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { type PipelineTemplate, type PipelineStep } from "./pipelineTemplates.js";
import { getToolById, type CreativeTool, getToolsByCategory } from "./toolRegistry.js";
import { type PlanSession, type SayFn } from "./interactivePlanner.js";

export interface StepResult {
  stepId: string;
  toolId: string;
  success: boolean;
  outputPath?: string;
  text?: string;
  error?: string;
  durationMs: number;
}

export interface ExecutionReport {
  sessionId: string;
  templateId: string;
  topic: string;
  results: StepResult[];
  totalDurationMs: number;
  success: boolean;
}

type ToolAdapter = (input: ToolAdapterInput) => Promise<ToolAdapterResult>;

interface ToolAdapterInput {
  prompt?: string;
  imagePath?: string;
  audioPath?: string;
  text?: string;
  topic?: string;
  outputDir: string;
  extraParams?: Record<string, unknown>;
}

interface ToolAdapterResult {
  success: boolean;
  outputPath?: string;
  text?: string;
  error?: string;
}

// ─── 工具适配器注册 ───

const adapters = new Map<string, ToolAdapter>();

export function registerAdapter(toolId: string, adapter: ToolAdapter): void {
  adapters.set(toolId, adapter);
}

function getAdapter(toolId: string): ToolAdapter | undefined {
  return adapters.get(toolId);
}

// ─── 内置适配器 ───

function registerBuiltinAdapters(): void {
  registerAdapter("deepseek", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.deepseekCopywriting(input.prompt ?? input.text ?? input.topic ?? "");
  });

  registerAdapter("gemini_copywriting", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.geminiCopywriting(input.prompt ?? input.text ?? input.topic ?? "");
  });

  registerAdapter("tongyi_wanxiang", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.tongyiWanxiangTextToImage(input.prompt ?? "", input.outputDir);
  });

  registerAdapter("doubao", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.doubaoTextToImage(input.prompt ?? "", input.outputDir);
  });

  registerAdapter("kling", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.klingImageToVideo(input.imagePath ?? "", input.prompt, input.outputDir);
  });

  registerAdapter("jimeng", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.jimengImageToVideo(input.imagePath ?? "", input.prompt, input.outputDir);
  });

  registerAdapter("gemini_image", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    const result = await bb.geminiCopywriting(`Please generate an image based on: ${input.prompt}`);
    return result;
  });

  registerAdapter("grok", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.grokTextToImage(input.prompt ?? "", input.outputDir);
  });

  registerAdapter("chatgpt_dalle", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.chatgptTextToImage(input.prompt ?? "", input.outputDir);
  });

  registerAdapter("system_tts", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.systemTtsGenerate(input.text ?? "", input.outputDir);
  });

  registerAdapter("heygen", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.heygenLipsync(input.audioPath ?? "", input.extraParams?.avatarId as string, input.outputDir);
  });

  registerAdapter("runway", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.runwayImageToVideo(input.imagePath ?? "", input.prompt, input.outputDir);
  });

  registerAdapter("pika", async (input) => {
    const bb = await import("../tools/browserBridge.js");
    return bb.pikaImageToVideo(input.imagePath ?? "", input.prompt, input.outputDir);
  });

  registerAdapter("gpt", async (input) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, error: "OPENAI_API_KEY 未配置" };
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.GPT_MODEL ?? "gpt-4o",
        messages: [
          { role: "system", content: "你是一位专业的内容策划师。" },
          { role: "user", content: input.prompt ?? input.text ?? "" },
        ],
        temperature: 0.8,
      }),
    });
    if (!resp.ok) return { success: false, error: `API ${resp.status}` };
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { success: true, text } : { success: false, error: "空回复" };
  });

  registerAdapter("claude", async (input) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: "ANTHROPIC_API_KEY 未配置" };
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: input.prompt ?? input.text ?? "" }],
      }),
    });
    if (!resp.ok) return { success: false, error: `API ${resp.status}` };
    const data = await resp.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim();
    return text ? { success: true, text } : { success: false, error: "空回复" };
  });

  registerAdapter("qwen", async (input) => {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) return { success: false, error: "DASHSCOPE_API_KEY 未配置" };
    const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen-max",
        messages: [{ role: "user", content: input.prompt ?? input.text ?? "" }],
      }),
    });
    if (!resp.ok) return { success: false, error: `API ${resp.status}` };
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { success: true, text } : { success: false, error: "空回复" };
  });
}

let builtinsRegistered = false;
function ensureBuiltins(): void {
  if (builtinsRegistered) return;
  registerBuiltinAdapters();
  builtinsRegistered = true;
}

// ─── 步骤数据构建 ───

function buildStepInput(
  step: PipelineStep,
  session: PlanSession,
  outputDir: string,
): ToolAdapterInput {
  const input: ToolAdapterInput = {
    topic: session.topic,
    outputDir,
  };

  if (step.promptTemplate) {
    let prompt = step.promptTemplate;
    prompt = prompt.replace("{topic}", session.topic);
    if (step.inputFrom) {
      const prev = session.outputs.get(step.inputFrom);
      if (typeof prev === "string") {
        prompt = prompt.replace("{input}", prev);
      }
    }
    input.prompt = prompt;
  } else if (step.inputFrom) {
    const prev = session.outputs.get(step.inputFrom);
    if (typeof prev === "string") {
      if (step.category === "video" || step.category === "lipsync") {
        if (prev.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
          input.imagePath = prev;
        } else if (prev.match(/\.(mp3|wav|ogg|m4a)$/i)) {
          input.audioPath = prev;
        } else {
          input.prompt = prev;
        }
      } else if (step.category === "voice") {
        input.text = prev;
      } else {
        input.prompt = prev;
      }
    }
  } else {
    input.prompt = session.topic;
  }

  return input;
}

// ─── 主执行函数 ───

export interface ExecuteCallbacks {
  say: SayFn;
  onCheckpoint: (stepId: string, result: StepResult) => Promise<"continue" | "redo" | "abort">;
  onProgress?: (stepIndex: number, totalSteps: number, stepName: string) => void;
}

/**
 * 执行流水线。从 session.currentStepIndex 开始逐步执行。
 * checkpoint 步骤暂停交由 onCheckpoint 回调决定是否继续。
 */
export async function executePipeline(
  session: PlanSession,
  callbacks: ExecuteCallbacks,
): Promise<ExecutionReport> {
  ensureBuiltins();

  const tmpl = session.selectedTemplate!;
  const outputBase = join(process.cwd(), "output", `pipeline_${session.id}`);
  await mkdir(outputBase, { recursive: true });

  const results: StepResult[] = [];
  const totalStart = Date.now();

  callbacks.say(`\n开始执行「${tmpl.name}」…`);

  while (session.currentStepIndex < tmpl.steps.length) {
    const step = tmpl.steps[session.currentStepIndex];
    const toolId = session.toolChoices.get(step.id);

    if (step.optional && !toolId) {
      session.currentStepIndex++;
      continue;
    }

    const stepDir = join(outputBase, step.id);
    await mkdir(stepDir, { recursive: true });

    callbacks.onProgress?.(session.currentStepIndex, tmpl.steps.length, step.name);
    callbacks.say(`\n[${session.currentStepIndex + 1}/${tmpl.steps.length}] ${step.name}…`);

    const result = await executeStep(step, toolId!, session, stepDir, callbacks.say);
    results.push(result);

    if (!result.success) {
      const fallbackResult = await tryFallback(step, toolId!, session, stepDir, callbacks.say);
      if (fallbackResult) {
        results[results.length - 1] = fallbackResult;
        storeOutput(session, step, fallbackResult);
        callbacks.say(`✓ ${step.name} 完成（使用备选工具）`);
      } else {
        callbacks.say(`✗ ${step.name} 失败：${result.error ?? "未知错误"}`);
        if (!step.optional) {
          return buildReport(session, tmpl, results, totalStart, false);
        }
        session.currentStepIndex++;
        continue;
      }
    } else {
      storeOutput(session, step, result);
      callbacks.say(`✓ ${step.name} 完成`);
    }

    if (step.requiresUserConfirm) {
      const action = await callbacks.onCheckpoint(step.id, results[results.length - 1]);
      if (action === "redo") {
        callbacks.say("重新执行这一步…");
        continue;
      }
      if (action === "abort") {
        callbacks.say("用户终止流水线。");
        return buildReport(session, tmpl, results, totalStart, false);
      }
    }

    session.currentStepIndex++;
  }

  callbacks.say(`\n全部 ${tmpl.steps.length} 步已完成。输出目录：${outputBase}`);

  const report = buildReport(session, tmpl, results, totalStart, true);
  await saveReport(outputBase, report);
  return report;
}

async function executeStep(
  step: PipelineStep,
  toolId: string,
  session: PlanSession,
  outputDir: string,
  say: SayFn,
): Promise<StepResult> {
  const adapter = getAdapter(toolId);
  if (!adapter) {
    return { stepId: step.id, toolId, success: false, error: `工具 ${toolId} 无适配器`, durationMs: 0 };
  }

  const input = buildStepInput(step, session, outputDir);
  const start = Date.now();

  try {
    say(`  使用 ${getToolById(toolId)?.name ?? toolId}…`);
    const result = await adapter(input);
    const durationMs = Date.now() - start;
    return {
      stepId: step.id,
      toolId,
      success: result.success,
      outputPath: result.outputPath,
      text: result.text,
      error: result.error,
      durationMs,
    };
  } catch (e) {
    return {
      stepId: step.id,
      toolId,
      success: false,
      error: (e as Error).message ?? String(e),
      durationMs: Date.now() - start,
    };
  }
}

async function tryFallback(
  step: PipelineStep,
  failedToolId: string,
  session: PlanSession,
  outputDir: string,
  say: SayFn,
): Promise<StepResult | null> {
  const allTools = getToolsByCategory(step.category);
  const alternatives = allTools.filter((t) => t.id !== failedToolId);

  for (const alt of alternatives) {
    const adapter = getAdapter(alt.id);
    if (!adapter) continue;

    const available = await alt.checkAvailable();
    if (!available) continue;

    say(`  尝试备选工具 ${alt.name}…`);
    const input = buildStepInput(step, session, outputDir);
    const start = Date.now();

    try {
      const result = await adapter(input);
      if (result.success) {
        session.toolChoices.set(step.id, alt.id);
        return {
          stepId: step.id,
          toolId: alt.id,
          success: true,
          outputPath: result.outputPath,
          text: result.text,
          durationMs: Date.now() - start,
        };
      }
    } catch {
      // try next
    }
  }

  return null;
}

function storeOutput(session: PlanSession, step: PipelineStep, result: StepResult): void {
  if (result.text) {
    session.outputs.set(step.id, result.text);
  } else if (result.outputPath) {
    session.outputs.set(step.id, result.outputPath);
  }
}

function buildReport(
  session: PlanSession,
  tmpl: PipelineTemplate,
  results: StepResult[],
  totalStart: number,
  success: boolean,
): ExecutionReport {
  return {
    sessionId: session.id,
    templateId: tmpl.id,
    topic: session.topic,
    results,
    totalDurationMs: Date.now() - totalStart,
    success,
  };
}

async function saveReport(outputDir: string, report: ExecutionReport): Promise<void> {
  try {
    const reportPath = join(outputDir, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  } catch (e) {
    console.warn("[pipelineExecutor] 保存报告失败:", (e as Error).message);
  }
}
