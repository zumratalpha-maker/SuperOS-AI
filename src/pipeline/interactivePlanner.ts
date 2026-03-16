/**
 * 交互式规划器 — 多轮对话状态机
 *
 * 状态流转：
 * classifying → selecting_type → selecting_tools → checking_login
 *   → waiting_login → confirming → executing → paused(checkpoint) → done
 *
 * 每个状态对应一个 handleXxx 函数，处理用户在该状态下的输入
 */

import {
  matchTemplate,
  formatTemplateChoices,
  getTemplateByIndex,
  type PipelineTemplate,
  type PipelineStep,
} from "./pipelineTemplates.js";
import {
  getToolsByCategory,
  getAvailableTools,
  recommendTool,
  formatToolChoices,
  getToolById,
  type CreativeTool,
  type ToolCategory,
} from "./toolRegistry.js";
import {
  checkLoginStatus,
  guideLogin,
  markAsLoggedIn,
  getToolsNeedingLogin,
} from "./loginManager.js";

// ─── 会话状态 ───

export type SessionState =
  | "classifying"
  | "selecting_type"
  | "selecting_tools"
  | "checking_login"
  | "waiting_login"
  | "confirming"
  | "ready_to_execute"
  | "executing"
  | "paused"
  | "done";

export interface PlanSession {
  id: string;
  state: SessionState;
  originalInput: string;
  topic: string;
  contentType?: string;
  selectedTemplate?: PipelineTemplate;
  toolChoices: Map<string, string>;
  currentToolStepIndex: number;
  loginQueue: string[];
  currentLoginToolId?: string;
  currentStepIndex: number;
  outputs: Map<string, unknown>;
  pauseReason?: string;
}

export type SayFn = (msg: string) => void;

// ─── 创建会话 ───

export function createSession(userInput: string): PlanSession {
  return {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    state: "classifying",
    originalInput: userInput,
    topic: userInput,
    toolChoices: new Map(),
    currentToolStepIndex: 0,
    loginQueue: [],
    currentStepIndex: 0,
    outputs: new Map(),
  };
}

// ─── 主路由 ───

/**
 * 处理用户输入，根据当前会话状态路由到对应处理函数
 * 返回 true 表示会话仍活跃，false 表示会话结束
 */
export async function handleInput(
  session: PlanSession,
  userInput: string,
  say: SayFn,
): Promise<boolean> {
  const trimmed = userInput.trim();

  if (/^(取消|算了|cancel|quit)$/i.test(trimmed)) {
    say("已取消。");
    session.state = "done";
    return false;
  }

  switch (session.state) {
    case "classifying":
      return handleClassifying(session, trimmed, say);
    case "selecting_type":
      return handleSelectingType(session, trimmed, say);
    case "selecting_tools":
      return handleSelectingTools(session, trimmed, say);
    case "checking_login":
      return handleCheckingLogin(session, trimmed, say);
    case "waiting_login":
      return handleWaitingLogin(session, trimmed, say);
    case "confirming":
      return handleConfirming(session, trimmed, say);
    case "paused":
      return handlePaused(session, trimmed, say);
    default:
      return false;
  }
}

// ─── 状态处理函数 ───

async function handleClassifying(session: PlanSession, _input: string, say: SayFn): Promise<boolean> {
  const matched = matchTemplate(session.originalInput);

  if (matched) {
    session.selectedTemplate = matched;
    session.contentType = matched.id;
    say(`识别为「${matched.name}」。`);
    say(`流程：${matched.description}`);
    say(`预计耗时约 ${matched.estimatedMinutes} 分钟。`);
    session.state = "selecting_tools";
    session.currentToolStepIndex = 0;
    return askNextToolChoice(session, say);
  }

  say("请问你想制作哪种类型的内容？");
  say(formatTemplateChoices());
  say("  5. 让我根据你的描述自动判断");
  say("请回复编号（1-5），或更详细地描述你想做什么。");
  session.state = "selecting_type";
  return true;
}

async function handleSelectingType(session: PlanSession, input: string, say: SayFn): Promise<boolean> {
  const num = parseInt(input, 10);

  if (num >= 1 && num <= 4) {
    const tmpl = getTemplateByIndex(num - 1);
    if (tmpl) {
      session.selectedTemplate = tmpl;
      session.contentType = tmpl.id;
      say(`好的，选择「${tmpl.name}」。`);
      session.state = "selecting_tools";
      session.currentToolStepIndex = 0;
      return askNextToolChoice(session, say);
    }
  }

  if (num === 5 || /自动|帮我选|你来选/i.test(input)) {
    const matched = matchTemplate(session.originalInput + " " + input);
    if (matched) {
      session.selectedTemplate = matched;
      session.contentType = matched.id;
      say(`根据你的描述，推荐「${matched.name}」。`);
      session.state = "selecting_tools";
      session.currentToolStepIndex = 0;
      return askNextToolChoice(session, say);
    }
    say("还是无法确定类型，请直接选择 1-4。");
    return true;
  }

  const matched = matchTemplate(input);
  if (matched) {
    session.selectedTemplate = matched;
    session.contentType = matched.id;
    say(`好的，「${matched.name}」。`);
    session.state = "selecting_tools";
    session.currentToolStepIndex = 0;
    return askNextToolChoice(session, say);
  }

  say("没有理解，请回复 1-4 选择类型，或说「取消」退出。");
  return true;
}

/**
 * 逐步询问每个步骤要用什么工具
 */
async function askNextToolChoice(session: PlanSession, say: SayFn): Promise<boolean> {
  const tmpl = session.selectedTemplate!;
  const steps = tmpl.steps;

  while (session.currentToolStepIndex < steps.length) {
    const step = steps[session.currentToolStepIndex];

    if (step.optional) {
      session.currentToolStepIndex++;
      continue;
    }

    const tools = await getAvailableTools(step.category);

    if (tools.length === 0) {
      say(`⚠ 步骤「${step.name}」没有可用的${categoryName(step.category)}工具。请先配置相关 API Key 或安装应用。`);
      session.currentToolStepIndex++;
      continue;
    }

    if (tools.length === 1) {
      session.toolChoices.set(step.id, tools[0].id);
      say(`步骤「${step.name}」→ 使用 ${tools[0].name}${tools[0].needsLogin ? "（需登录）" : ""}`);
      session.currentToolStepIndex++;
      continue;
    }

    const recommended = await recommendTool(step.category);
    say(`\n步骤「${step.name}」— ${step.description}`);
    say(`可选工具：`);
    say(formatToolChoices(tools));

    if (recommended) {
      const idx = tools.findIndex((t) => t.id === recommended.id);
      say(`  推荐: ${recommended.name}（回复编号选择，或直接回车用推荐的 ${idx + 1}）`);
    } else {
      say("  请回复编号选择。");
    }

    return true;
  }

  session.state = "checking_login";
  return handleCheckingLogin(session, "", say);
}

async function handleSelectingTools(session: PlanSession, input: string, say: SayFn): Promise<boolean> {
  const tmpl = session.selectedTemplate!;
  const step = tmpl.steps[session.currentToolStepIndex];
  const tools = await getAvailableTools(step.category);

  let selectedTool: CreativeTool | undefined;

  if (!input || input === "" || /^(默认|推荐|ok)$/i.test(input)) {
    const rec = await recommendTool(step.category);
    selectedTool = rec ?? tools[0];
  } else {
    const num = parseInt(input, 10);
    if (num >= 1 && num <= tools.length) {
      selectedTool = tools[num - 1];
    } else {
      const byName = tools.find((t) =>
        t.name.toLowerCase().includes(input.toLowerCase()) ||
        t.id.toLowerCase().includes(input.toLowerCase())
      );
      selectedTool = byName;
    }
  }

  if (!selectedTool) {
    say(`未识别工具选择，请回复 1-${tools.length}。`);
    return true;
  }

  session.toolChoices.set(step.id, selectedTool.id);
  say(`✓ ${step.name} → ${selectedTool.name}`);
  session.currentToolStepIndex++;
  return askNextToolChoice(session, say);
}

async function handleCheckingLogin(session: PlanSession, _input: string, say: SayFn): Promise<boolean> {
  const toolIds = [...new Set(session.toolChoices.values())];
  const needLogin = await getToolsNeedingLogin(toolIds);

  if (needLogin.length === 0) {
    session.state = "confirming";
    return showPlanAndConfirm(session, say);
  }

  session.loginQueue = needLogin.map((r) => r.toolId);
  return processNextLogin(session, say);
}

async function processNextLogin(session: PlanSession, say: SayFn): Promise<boolean> {
  if (session.loginQueue.length === 0) {
    session.state = "confirming";
    return showPlanAndConfirm(session, say);
  }

  const toolId = session.loginQueue[0];
  session.currentLoginToolId = toolId;
  const tool = getToolById(toolId);

  say(`\n⚠ ${tool?.name ?? toolId} 需要登录。`);
  const result = await guideLogin(toolId);
  if (result.opened) {
    say(`已打开 ${result.loginUrl}`);
    say(`请在浏览器中完成登录。登录好了说「好了」。`);
  } else {
    say(`请手动打开 ${tool?.loginUrl ?? ""} 完成登录。登录好了说「好了」。`);
  }

  session.state = "waiting_login";
  return true;
}

async function handleWaitingLogin(session: PlanSession, input: string, say: SayFn): Promise<boolean> {
  if (/^(好了|登录了|ok|done|完成|搞定)/i.test(input)) {
    const toolId = session.currentLoginToolId!;
    markAsLoggedIn(toolId);
    const tool = getToolById(toolId);
    say(`✓ ${tool?.name ?? toolId} 已标记为已登录。`);
    session.loginQueue.shift();
    return processNextLogin(session, say);
  }

  if (/^(跳过|skip)/i.test(input)) {
    const toolId = session.currentLoginToolId!;
    say(`跳过 ${getToolById(toolId)?.name ?? toolId} 登录，该步骤执行时可能失败。`);
    session.loginQueue.shift();
    return processNextLogin(session, say);
  }

  say("请在浏览器中完成登录后说「好了」，或说「跳过」跳过此工具。");
  return true;
}

function showPlanAndConfirm(session: PlanSession, say: SayFn): boolean {
  const tmpl = session.selectedTemplate!;
  say("\n══════ 执行计划 ══════");
  say(`类型：${tmpl.name}`);
  say(`话题：${session.topic}`);
  say(`步骤：`);

  for (let i = 0; i < tmpl.steps.length; i++) {
    const step = tmpl.steps[i];
    const toolId = session.toolChoices.get(step.id);
    const tool = toolId ? getToolById(toolId) : undefined;
    const toolName = tool?.name ?? (step.optional ? "跳过" : "待定");
    const confirm = step.requiresUserConfirm ? " [需确认]" : "";
    const est = step.estimatedSeconds ? ` (~${step.estimatedSeconds}s)` : "";
    say(`  ${i + 1}. ${step.name} → ${toolName}${confirm}${est}`);
  }

  say(`预计总时间：约 ${tmpl.estimatedMinutes} 分钟`);
  say("══════════════════════");
  say("\n确认开始执行？回复「开始」。执行期间请放开鼠标和键盘。");
  say("或说「修改」更改工具选择。");
  return true;
}

async function handleConfirming(session: PlanSession, input: string, say: SayFn): Promise<boolean> {
  if (/^(开始|确认|执行|go|start|ok)$/i.test(input)) {
    session.state = "ready_to_execute";
    say("好的，开始执行。请放开鼠标和键盘…");
    return false;
  }

  if (/^(修改|改|change)/i.test(input)) {
    session.state = "selecting_tools";
    session.currentToolStepIndex = 0;
    session.toolChoices.clear();
    return askNextToolChoice(session, say);
  }

  say("回复「开始」执行，或「修改」更改工具，或「取消」退出。");
  return true;
}

async function handlePaused(session: PlanSession, input: string, say: SayFn): Promise<boolean> {
  if (/^(继续|满意|ok|good|可以|没问题)/i.test(input)) {
    session.state = "executing";
    say("继续执行下一步…");
    return false;
  }

  if (/^(重新生成|不满意|再来|重做|redo)/i.test(input)) {
    say("好的，重新执行这一步…");
    session.currentStepIndex = Math.max(0, session.currentStepIndex - 1);
    session.state = "executing";
    return false;
  }

  if (session.pauseReason) {
    say(session.pauseReason);
  }
  say("回复「继续」接受并进入下一步，或「重新生成」重做这一步。");
  return true;
}

// ─── 辅助 ───

function categoryName(cat: ToolCategory): string {
  const map: Record<ToolCategory, string> = {
    copywriting: "文案", image: "图片生成", video: "视频生成",
    voice: "配音", lipsync: "口型同步", editing: "剪辑",
  };
  return map[cat] ?? cat;
}

/**
 * 检查会话是否已就绪可执行
 */
export function isReadyToExecute(session: PlanSession): boolean {
  return session.state === "ready_to_execute";
}

export function isSessionActive(session: PlanSession): boolean {
  return session.state !== "done";
}

export function getSessionTemplate(session: PlanSession): PipelineTemplate | undefined {
  return session.selectedTemplate;
}

export function getSessionToolChoices(session: PlanSession): Map<string, string> {
  return session.toolChoices;
}
