/**
 * 技能执行器 — 将技能库中的结构化技能转化为实际操作
 *
 * 支持的 step action 类型：
 *   url_replace    — URL 字符串替换后用浏览器打开或下载
 *   shell          — 执行 PowerShell/Batch 命令
 *   puppeteer_goto — 用 Puppeteer 打开网页
 *   puppeteer_click — 用 Puppeteer 点击按钮
 *   puppeteer_type — 用 Puppeteer 输入文本
 *   download       — 调用 aria2 下载
 *   install_tool   — 安装命令行工具
 *   note           — 纯知识展示（不执行）
 */

import { type Skill, type SkillStep, recordSuccess, recordFailure } from "./skillLibrary.js";
import { checkSafety, checkScript } from "./safetyGuard.js";

export interface SkillExecutionResult {
  skillId: number;
  skillName: string;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  outputs: Map<string, unknown>;
  error?: string;
  needsUserConfirm?: boolean;
  confirmReason?: string;
}

export type SayFn = (msg: string) => void;

/**
 * 执行一个技能的所有步骤
 */
export async function executeSkill(
  skill: Skill,
  context: { userInput: string; say: SayFn; variables?: Record<string, string> },
): Promise<SkillExecutionResult> {
  const { say, variables = {} } = context;
  const outputs = new Map<string, unknown>();
  let stepsCompleted = 0;

  say(`正在执行技能「${skill.name}」…`);

  const cautionSteps = skill.steps.filter((s) => {
    if (s.action === "shell") {
      const cmd = String(s.params.command ?? "");
      const check = checkScript(cmd);
      return check.level === "caution";
    }
    return false;
  });

  if (cautionSteps.length > 0) {
    return {
      skillId: skill.id,
      skillName: skill.name,
      success: false,
      stepsCompleted: 0,
      totalSteps: skill.steps.length,
      outputs,
      needsUserConfirm: true,
      confirmReason: `技能包含 ${cautionSteps.length} 个需确认的命令操作`,
    };
  }

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    say(`  [${i + 1}/${skill.steps.length}] ${step.description ?? step.action}…`);

    try {
      const result = await executeStep(step, variables, outputs);
      if (!result.success) {
        say(`  ✗ 步骤失败: ${result.error ?? "未知错误"}`);
        recordFailure(skill.id);
        return {
          skillId: skill.id,
          skillName: skill.name,
          success: false,
          stepsCompleted,
          totalSteps: skill.steps.length,
          outputs,
          error: `步骤 ${i + 1} 失败: ${result.error}`,
        };
      }

      if (result.output !== undefined) {
        outputs.set(`step_${i}`, result.output);
        if (typeof result.output === "string") {
          variables[`step_${i}_output`] = result.output;
        }
      }

      stepsCompleted++;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      say(`  ✗ 步骤异常: ${msg.slice(0, 80)}`);
      recordFailure(skill.id);
      return {
        skillId: skill.id,
        skillName: skill.name,
        success: false,
        stepsCompleted,
        totalSteps: skill.steps.length,
        outputs,
        error: msg,
      };
    }
  }

  say(`✓ 技能「${skill.name}」执行完成（${stepsCompleted} 步）`);
  recordSuccess(skill.id);
  return {
    skillId: skill.id,
    skillName: skill.name,
    success: true,
    stepsCompleted,
    totalSteps: skill.steps.length,
    outputs,
  };
}

// ─── 单步执行 ───

interface StepExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

async function executeStep(
  step: SkillStep,
  variables: Record<string, string>,
  _prevOutputs: Map<string, unknown>,
): Promise<StepExecutionResult> {
  const params = resolveVariables(step.params, variables);

  switch (step.action) {
    case "url_replace":
      return executeUrlReplace(params);
    case "shell":
      return executeShell(params);
    case "puppeteer_goto":
      return executePuppeteerGoto(params);
    case "puppeteer_click":
      return executePuppeteerClick(params);
    case "puppeteer_type":
      return executePuppeteerType(params);
    case "download":
      return executeDownload(params);
    case "install_tool":
      return executeInstallTool(params);
    case "note":
      return { success: true, output: params.text ?? "知识备注" };
    default:
      return { success: false, error: `未知 action: ${step.action}` };
  }
}

function resolveVariables(
  params: Record<string, unknown>,
  variables: Record<string, string>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      let v = value;
      for (const [varName, varValue] of Object.entries(variables)) {
        v = v.replace(`{${varName}}`, varValue);
      }
      resolved[key] = v;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ─── 各 action 实现 ───

async function executeUrlReplace(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const from = String(params.from ?? "");
  const to = String(params.to ?? "");
  const url = String(params.url ?? "");

  if (!from || !to) return { success: false, error: "缺少 from/to 参数" };
  const newUrl = url ? url.replace(from, to) : `(URL 替换规则: ${from} → ${to})`;

  try {
    const { spawn } = await import("node:child_process");
    if (newUrl.startsWith("http")) {
      spawn("cmd", ["/c", "start", "", newUrl], { shell: false, stdio: "ignore" });
    }
    return { success: true, output: newUrl };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executeShell(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const command = String(params.command ?? "");
  if (!command) return { success: false, error: "空命令" };

  const safety = checkScript(command);
  if (safety.level === "blocked") {
    return { success: false, error: `安全拦截: ${safety.reason}` };
  }

  try {
    const { executePowerShell } = await import("../tools/UniversalExecutor.js");
    const result = await executePowerShell(command);
    if (result.ok) {
      return { success: true, output: result.stdout?.slice(0, 500) };
    }
    return { success: false, error: result.stderr?.slice(0, 200) ?? "执行失败" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executePuppeteerGoto(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const url = String(params.url ?? "");
  if (!url) return { success: false, error: "缺少 URL" };

  try {
    const { spawn } = await import("node:child_process");
    spawn("cmd", ["/c", "start", "", url], { shell: false, stdio: "ignore" });
    return { success: true, output: url };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executePuppeteerClick(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const text = String(params.text ?? "");
  if (!text) return { success: false, error: "缺少点击目标" };

  try {
    const dsb = await import("../tools/directShellBridge.js");
    const result = await dsb.clickByName(text);
    return { success: result.done, error: result.done ? undefined : "点击未完成" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executePuppeteerType(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const text = String(params.text ?? "");
  if (!text) return { success: false, error: "缺少输入内容" };

  try {
    const dsb = await import("../tools/directShellBridge.js");
    await dsb.typeText(text, String(params.placeholder ?? ""));
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executeDownload(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const url = String(params.url_pattern ?? params.url ?? "");
  if (!url || !url.startsWith("http")) return { success: false, error: "缺少有效 URL" };

  try {
    const { downloadWithAria2 } = await import("../tools/downloadExecutor.js");
    const result = await downloadWithAria2(url);
    if (result.ok) return { success: true, output: "下载已加入队列" };
    return { success: false, error: result.message ?? "下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function executeInstallTool(params: Record<string, unknown>): Promise<StepExecutionResult> {
  const name = String(params.name ?? "");
  const installCommand = String(params.install_command ?? "");

  if (!name) return { success: false, error: "缺少工具名" };

  try {
    const { ensureTool } = await import("../tools/UniversalExecutor.js");
    const toolPath = await ensureTool(name, {});
    if (toolPath) return { success: true, output: `${name} 已就绪: ${toolPath}` };

    if (installCommand) {
      const safety = checkScript(installCommand);
      if (safety.level === "blocked") {
        return { success: false, error: `安装命令被安全拦截` };
      }
      const { executePowerShell } = await import("../tools/UniversalExecutor.js");
      const result = await executePowerShell(installCommand);
      return result.ok
        ? { success: true, output: `${name} 安装完成` }
        : { success: false, error: `安装失败: ${result.stderr?.slice(0, 100)}` };
    }

    return { success: false, error: `${name} 未找到且无安装命令` };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 格式化技能预览（展示给用户确认用）
 */
export function formatSkillPreview(skill: Skill): string {
  const lines: string[] = [
    `技能: ${skill.name}`,
    `类型: ${skill.type}`,
    `来源: ${skill.source}${skill.sourceUrl ? ` (${skill.sourceUrl})` : ""}`,
    `置信度: ${(skill.confidence * 100).toFixed(0)}%`,
    `说明: ${skill.description}`,
    `步骤:`,
  ];

  for (let i = 0; i < skill.steps.length; i++) {
    const s = skill.steps[i];
    lines.push(`  ${i + 1}. [${s.action}] ${s.description ?? JSON.stringify(s.params).slice(0, 60)}`);
  }

  return lines.join("\n");
}
