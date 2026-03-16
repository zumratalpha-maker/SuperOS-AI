/**
 * J.A.R.V.I.S. 持久多轮对话：持续监听 + 上下文记忆 + 多步任务链按序执行
 */
import "dotenv/config";

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { createTask, runNextTask } from "./agents/orchestrator.js";
import { snapshotAndClickStep } from "./runSnapshotAndClickReview.js";
import { a11ySequenceStep, runA11ySequence } from "./runA11ySequence.js";
import {
  parseIntent,
  isCreateTaskIntent,
  isMultiStepIntent,
  isResourceHuntIntent,
  isLongPlanIntent,
  extractWeChatSendInfo,
  isWeChatSendFlow,
  hasMessageInWeChatFlow,
  injectWeChatMessage,
  ensureWeChatSearchFlowWithContact,
  fixWeChatOpenAppStep,
  type ConversationMessage,
  type StepTask,
  type IntentResult,
  type ResourceHuntIntent,
  type A11ySequenceIntent,
  type PuppeteerWebGenIntent,
  type LongPlanIntent,
} from "./jarvis/parseIntent.js";
import { getScheduler } from "./core/taskScheduler.js";
import * as memoryGraph from "./core/memoryGraph.js";
import * as habit from "./core/habitLearner.js";
import { getPluginManager } from "./core/pluginManager.js";
import * as browserBridge from "./tools/browserBridge.js";
import { resolveAndLaunch } from "./tools/appExecutor.js";
import { huntResources, type HuntResult } from "./tools/ResourceHunter.js";
import { downloadWithAria2 } from "./tools/downloadExecutor.js";
import { createFolderOnDesktop, saveLinksToFile } from "./tools/fsExecutor.js";
import { research } from "./agents/ResearchAgent.js";
import { executePowerShell, executeBatch, ensureTool } from "./tools/UniversalExecutor.js";
import { parseVoiceCommandToAction, executeVoiceAction, speak, speakReply, setTtsEnabled, startListening, stopListening, isListening } from "./voice/index.js";
import { safetyGate, markAsConfirmed, type RiskLevel } from "./core/safetyGuard.js";
import { tryGeneratePlugin, loadGeneratedPlugins } from "./core/pluginGenerator.js";
import * as wfr from "./core/workflowRecorder.js";
import { showOverlay, updateOverlay, hideOverlay } from "./core/progressOverlay.js";
import {
  createSession,
  handleInput as handlePlanInput,
  isReadyToExecute,
  isSessionActive,
  type PlanSession,
} from "./pipeline/interactivePlanner.js";
import { executePipeline, type StepResult } from "./pipeline/pipelineExecutor.js";
import { matchTemplate } from "./pipeline/pipelineTemplates.js";
import { findSkills } from "./core/skillLibrary.js";
import { findOrLearn } from "./core/skillLearner.js";
import { executeSkill, formatSkillPreview } from "./core/skillExecutor.js";
import {
  startWeChatMonitor,
  stopWeChatMonitor,
  isMonitorRunning,
  initWeChatChat,
  isWeChatRunning,
} from "./wechat/wechatMonitor.js";
import {
  addNaturalJob,
  listJobs,
  removeJob,
  startCronScheduler,
  formatJobList,
} from "./core/cronScheduler.js";

const JARVIS_PREFIX = "J.A.R.V.I.S.";
const PROMPT = "您 > ";
const STEP_DELAY_MS = 400;
const CLOUD_LLM_KEY_AVAILABLE = !!(process.env.CLOUD_API_KEY || process.env.OPENAI_API_KEY);

function say(line: string): void {
  console.log(`${JARVIS_PREFIX} ${line}`);
  speak(line);
}

const HELP_TEXT = `示例：打开应用、多步操作（如打开记事本写诗保存）、资源搜索、自主研究等。你好/ni hao 显示本帮助。你可用自然语言描述想做的事，我会尽量执行。`;

function openUrlInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    if (isWin) {
      const child = spawn("cmd", ["/c", "start", "", url], { shell: false, stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    } else {
      const open = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(open, [url], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHuntTable(results: HuntResult[]): void {
  const header = "| 编号 | 资源名 | 清晰度/大小 | 安全评分 | 来源 |";
  const sep = "|------|--------|--------------|----------|------|";
  const rows = results.map(
    (r) => `| ${r.index} | ${r.name.slice(0, 24)} | ${r.qualityOrSize} | ${r.safetyScore} | ${r.source.slice(0, 12)} |`
  );
  console.log("\n" + header + "\n" + sep + "\n" + rows.join("\n") + "\n");
}

function parseResourceChoice(line: string): "none" | "retry" | number | null {
  const t = line.trim();
  if (/^全部不要|都不要|取消$/i.test(t)) return "none";
  if (/^再搜搜看|再搜|换一批$/i.test(t)) return "retry";
  const m = t.match(/^下\s*第\s*(\d+)\s*个$/i) || t.match(/^(\d+)\s*$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1) return n;
  }
  return null;
}

/** 多步执行时的上下文（如桌面新建文件夹路径，供 resource_hunt 保存链接） */
export type RunContext = { desktopFolderPath?: string };

/** 待发微信：用户说「发消息给X」但未说内容，等待下一轮输入作为消息 */
let pendingWechatSend: { contact: string; steps: A11ySequenceIntent["steps"] } | null = null;
/** 安全确认等待：灰名单操作需用户确认后重新执行 */
let pendingSafetyConfirm: { originalInput: string; actionKey: string } | null = null;
/** 创作流水线会话：交互式多轮对话，激活时所有输入路由到规划器 */
let activePlanSession: PlanSession | null = null;

async function runResourceHuntConfirmation(
  rl: readline.Interface,
  sayFn: (s: string) => void,
  results: HuntResult[],
  params: { keywords: string; qualityOrType?: string },
  context?: RunContext
): Promise<void> {
  const CONFIRM_PROMPT = "资源猎人 > ";
  const folderPath = context?.desktopFolderPath;

  function ask(): Promise<void> {
    return new Promise((resolve) => {
      sayFn("请选择：下第 X 个 / 全部不要 / 再搜搜看");
      rl.question(CONFIRM_PROMPT, async (line) => {
        const choice = parseResourceChoice(line ?? "");
        if (choice === "none") {
          sayFn("已取消。");
          resolve();
          return;
        }
        if (choice === "retry") {
          sayFn("正在重新检索…");
          try {
            const next = await huntResources(params);
            if (next.length === 0) {
              sayFn("未找到新结果。");
              resolve();
              return;
            }
            printHuntTable(next);
            await runResourceHuntConfirmation(rl, sayFn, next, params, context);
          } catch (e) {
            console.error("[jarvis] 再搜异常:", e);
            sayFn("检索异常，请查看日志。");
          }
          resolve();
          return;
        }
        if (typeof choice === "number") {
          const r = results[choice - 1];
          if (!r) {
            sayFn("无效编号，请重选。");
            await ask();
            resolve();
            return;
          }
          if (folderPath) {
            const saveResult = saveLinksToFile(folderPath, [r.url]);
            if (saveResult.ok) sayFn("链接已写入桌面文件夹 links.txt。");
            else console.error("[jarvis] 写入 links.txt 失败:", saveResult.error);
          }
          sayFn("正在通过 aria2 下载第 " + choice + " 个…");
          const dl = await downloadWithAria2(r.url);
          if (dl.needInstallPrompt && dl.message) {
            sayFn(dl.message);
          } else if (dl.ok) {
            sayFn("已加入下载队列。");
          } else {
            sayFn("下载失败：" + (dl.message ?? "未知错误"));
          }
          resolve();
          return;
        }
        sayFn("未识别，请输入：下第 X 个 / 全部不要 / 再搜搜看");
        await ask();
        resolve();
      });
    });
  }

  await ask();
}

/**
 * 执行单步任务（含 manage_file）；context 用于多步时传递桌面文件夹路径
 */
async function executeStep(step: StepTask | IntentResult, context?: RunContext): Promise<void> {
  if (!step || step.kind === "help") return;

  if (step.kind === "manage_file" && step.action === "create_folder") {
    const name = step.folderName.trim() || "新建文件夹";
    const result = createFolderOnDesktop(name);
    if (result.ok && result.path) {
      say("已在桌面创建文件夹：" + name + "。");
      if (context) context.desktopFolderPath = result.path;
    } else {
      say("创建文件夹失败：" + (result.error ?? "未知错误"));
    }
    return;
  }

  if (step.kind === "open_target") {
    const targetName = step.targetName.trim();
    // 剪映：用户说「打开剪映」意指进入编辑界面，需 open_app + 点击开始创作
    if (/剪映|CapCut|JianyingPro/i.test(targetName)) {
      say("正在打开剪映并进入创作界面…");
      try {
        await runA11ySequence({
          kind: "a11y_sequence",
          steps: [
            { type: "open_app", app: "剪映" },
            { type: "click", name: "开始创作" },
          ],
        });
        say("已打开剪映并进入创作界面。");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[jarvis] 打开剪映 失败:", err);
        say("打开剪映时出错：" + (msg.slice(0, 80) || "请查看日志。"));
      }
      return;
    }
    say("正在打开 " + targetName + "…");
    const result = await resolveAndLaunch(targetName);
    if (result.ok) {
      if (result.usedFallback && result.fallbackMessage) say(result.fallbackMessage);
      else say("已打开。");
    } else {
      console.error("[jarvis] resolveAndLaunch 失败:", result.error);
      say("打开 " + targetName + " 时出错，请查看日志或检查 appRegistry / 缓存。");
    }
    return;
  }

  if (step.kind === "run_next") {
    say("正在执行下一个待办…");
    await runNextTask(snapshotAndClickStep);
    say("待办已执行。");
    return;
  }

  if (step.kind === "snapshot_and_click_review") {
    say("正在执行 Cursor 内点击任务…");
    createTask(step);
    await runNextTask(snapshotAndClickStep);
    say("点击任务已执行。");
    return;
  }
}

/** 将本轮执行结果总结为简短描述，写入对话历史 */
function summarizeIntent(intent: IntentResult): string {
  if (!intent) return "未识别";
  if (intent.kind === "help") return "已回复帮助";
  if (intent.kind === "open_target") return "已执行：打开 " + intent.targetName;
  if (intent.kind === "run_next") return "已执行：run_next";
  if (intent.kind === "snapshot_and_click_review") return "已执行：点击 " + intent.buttonName;
  if (intent.kind === "multi_step") {
    const parts = intent.tasks.map((t) => {
      if (t.kind === "open_target") return "打开" + t.targetName;
      if (t.kind === "manage_file" && t.action === "create_folder") return "建文件夹" + t.folderName;
      if (t.kind === "resource_hunt") return "资源猎人" + t.keywords;
      return String(t.kind);
    });
    return "已执行 " + intent.tasks.length + " 步：" + parts.join("、");
  }
  if (intent.kind === "resource_hunt") return "已执行：资源猎人 " + intent.keywords;
  if (intent.kind === "manage_file" && intent.action === "create_folder") return "已执行：建文件夹 " + intent.folderName;
  if (intent.kind === "a11y_sequence") return "已执行 A11y 链 " + intent.steps.length + " 步";
  if (intent.kind === "puppeteer_web_gen") return "已执行网页创作：" + intent.tool;
  if (intent.kind === "long_plan") return "已创建长计划：" + intent.name + "（" + intent.stages.length + " 阶段）";
  return "已执行";
}

async function dispatch(
  input: string,
  conversationHistory: ConversationMessage[],
  rl: readline.Interface
): Promise<void> {
  const trimmed = input.trim();
  // 去除粘贴时可能带入的提示前缀（如「您 > 」），避免「您 > 点击保存」无法命中语音规则
  const forVoice = trimmed.replace(/^您\s*>\s*/u, "").trim();

  // ─── 创作流水线会话路由 ───
  if (activePlanSession && isSessionActive(activePlanSession)) {
    const stillActive = await handlePlanInput(activePlanSession, forVoice, say);

    if (isReadyToExecute(activePlanSession)) {
      const session = activePlanSession;
      session.state = "executing";
      showOverlay();
      updateOverlay("开始创作流水线", 0);
      try {
        const report = await executePipeline(session, {
          say,
          onProgress: (idx, total, name) => {
            updateOverlay(`[${idx + 1}/${total}] ${name}`, Math.round(((idx + 1) / total) * 100));
          },
          onCheckpoint: async (stepId, result) => {
            session.state = "paused";
            session.pauseReason = result.text
              ? `请查看生成的内容，满意请说「继续」，不满意说「重新生成」。\n预览：${result.text.slice(0, 200)}…`
              : result.outputPath
                ? `已生成文件：${result.outputPath}。满意请说「继续」，不满意说「重新生成」。`
                : "请确认结果。满意说「继续」，不满意说「重新生成」。";
            say(session.pauseReason);
            return new Promise<"continue" | "redo" | "abort">((resolve) => {
              const checkpointHandler = (answer: string) => {
                const a = answer.trim();
                if (/^(继续|满意|ok|good|可以|没问题)/i.test(a)) { resolve("continue"); return; }
                if (/^(重新生成|不满意|再来|重做|redo)/i.test(a)) { resolve("redo"); return; }
                if (/^(取消|算了|cancel|quit)/i.test(a)) { resolve("abort"); return; }
                say("请回复「继续」「重新生成」或「取消」。");
                rl.question(PROMPT, checkpointHandler);
              };
              rl.question(PROMPT, checkpointHandler);
            });
          },
        });
        if (report.success) {
          say("创作流水线全部完成！");
          speakReply("done");
        } else {
          say("流水线未完全完成，部分步骤失败。");
        }
        const scene = memoryGraph.ensureNode("scene", "创作:" + (session.selectedTemplate?.name ?? "未知"));
        const action = memoryGraph.ensureNode("action", "pipeline");
        const result = memoryGraph.ensureNode("result", report.success ? "成功" : "失败");
        memoryGraph.recordExecution(scene, action, result, {
          success: report.success,
          durationMs: report.totalDurationMs,
          engine: "pipeline",
        });
      } catch (e) {
        say("流水线执行异常：" + ((e as Error).message ?? "").slice(0, 80));
      }
      updateOverlay(activePlanSession.state === "done" ? "完成" : "结束", 100);
      setTimeout(hideOverlay, 2000);
      activePlanSession = null;
    } else if (!stillActive) {
      activePlanSession = null;
    }

    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "创作会话交互" });
    return;
  }

  // ─── 安全确认回复处理 ───
  if (pendingSafetyConfirm && forVoice) {
    const reply = forVoice.toLowerCase();
    if (/^(确认|是|yes|ok|继续|执行)$/i.test(reply)) {
      const orig = pendingSafetyConfirm.originalInput;
      markAsConfirmed(pendingSafetyConfirm.actionKey);
      pendingSafetyConfirm = null;
      say("已确认，正在执行…");
      return dispatch(orig, conversationHistory, rl);
    }
    pendingSafetyConfirm = null;
    say("已取消。");
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "用户取消了操作" });
    return;
  }

  // ─── 工作流录制/回放 ───
  if (/^开始录制\s*(.*)$/u.test(forVoice)) {
    const name = forVoice.replace(/^开始录制\s*/u, "").trim();
    wfr.startRecording(name || "未命名工作流");
    say("录制已开始。执行操作后说「结束录制」保存。");
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "录制开始" });
    return;
  }
  if (/^结束录制/u.test(forVoice)) {
    const workflow = wfr.stopRecording();
    if (workflow) {
      say(`已保存工作流「${workflow.name}」（${workflow.steps.length} 步）。下次说「回放 ${workflow.name}」即可重复执行。`);
    } else {
      say("没有正在录制的工作流，或未录到任何步骤。");
    }
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "录制结束" });
    return;
  }
  if (/^(回放|重放|replay)\s+(.+)$/iu.test(forVoice)) {
    const m = forVoice.match(/^(?:回放|重放|replay)\s+(.+)$/iu);
    const name = m?.[1]?.trim() ?? "";
    const workflow = wfr.findWorkflowByName(name);
    if (!workflow) {
      say(`未找到名为「${name}」的工作流。`);
      conversationHistory.push({ role: "user", content: input });
      return;
    }
    say(`正在回放工作流「${workflow.name}」（${workflow.steps.length} 步）…`);
    const result = await wfr.replayWorkflow(workflow, async (step, _idx) => {
      const dsb = await import("./tools/directShellBridge.js");
      if (step.type === "open_app") {
        const r = await resolveAndLaunch(step.target ?? "");
        return r.ok;
      }
      if (step.type === "click" && step.target) {
        const r = await dsb.clickByName(step.target);
        return r.done;
      }
      if (step.type === "type" && step.value) {
        await dsb.typeText(step.value, step.target ?? "");
        return true;
      }
      if (step.type === "key" && step.value) {
        return await dsb.sendKeys(step.value);
      }
      return false;
    });
    say(result.success ? "回放完成！" : `回放在第 ${result.stepsCompleted + 1} 步失败：${result.error}`);
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: result.success ? "回放成功" : "回放失败" });
    return;
  }
  if (/^(列出|查看)工作流/u.test(forVoice)) {
    const workflows = wfr.listWorkflows(10);
    if (workflows.length === 0) {
      say("还没有保存的工作流。说「开始录制 名称」来创建。");
    } else {
      say("已保存的工作流：");
      for (const w of workflows) {
        say(`  - 「${w.name}」${w.steps.length}步，成功率 ${w.useCount > 0 ? Math.round((w.successCount / w.useCount) * 100) : 0}%，已用 ${w.useCount} 次`);
      }
    }
    conversationHistory.push({ role: "user", content: input });
    return;
  }

  // ─── 微信远程监控 ───
  if (/^(启动|开启|打开)微信监控/u.test(forVoice)) {
    if (isMonitorRunning()) {
      say("微信监控已在运行中。说「停止微信监控」可关闭。");
    } else if (!isWeChatRunning()) {
      say("未检测到微信进程，请先打开微信并登录。");
    } else {
      say("正在初始化微信监控…请确保已打开「文件传输助手」聊天。");
      const ok = await initWeChatChat();
      if (ok) {
        startWeChatMonitor(
          async (cmd) => {
            const capturedLines: string[] = [];
            const origLog = console.log;
            console.log = (...args: unknown[]) => {
              const line = args.map(String).join(" ");
              if (line.startsWith(JARVIS_PREFIX)) capturedLines.push(line.replace(JARVIS_PREFIX, "").trim());
              origLog(...args);
            };
            try {
              await dispatch(cmd, conversationHistory, rl);
            } finally {
              console.log = origLog;
            }
            return capturedLines.join("\n") || "指令已执行";
          },
          say,
        );
        say("微信监控已启动！你可以在手机上给「文件传输助手」发指令了。");
      } else {
        say("切换到文件传输助手失败，请手动打开该聊天再试。");
      }
    }
    conversationHistory.push({ role: "user", content: input });
    return;
  }
  if (/^(停止|关闭|关掉)微信监控/u.test(forVoice)) {
    stopWeChatMonitor();
    say("微信监控已停止。");
    conversationHistory.push({ role: "user", content: input });
    return;
  }
  if (/^微信监控状态/u.test(forVoice)) {
    say(isMonitorRunning() ? "微信监控正在运行中（每 3 秒检查一次）" : "微信监控未启动。说「启动微信监控」开启。");
    conversationHistory.push({ role: "user", content: input });
    return;
  }

  // ─── 语音识别控制 ───
  if (/^(启动|开启|打开)语音(识别|监听|模式)/u.test(forVoice)) {
    if (isListening()) {
      say("语音识别已在运行中。说「停止语音识别」可关闭。");
    } else {
      const ok = startListening(async (text) => {
        say(`[语音] 听到: ${text}`);
        await dispatch(text, conversationHistory, rl);
      });
      say(ok ? "语音识别已启动，对着麦克风说话即可。" : "语音识别启动失败（仅支持 Windows）。");
    }
    conversationHistory.push({ role: "user", content: input });
    return;
  }
  if (/^(停止|关闭|关掉)语音(识别|监听|模式)/u.test(forVoice)) {
    stopListening();
    say("语音识别已停止。");
    conversationHistory.push({ role: "user", content: input });
    return;
  }

  // ─── 定时任务 ───
  const cronMatch = forVoice.match(/^(每天|每周.|每月\d+[号日]|每\d+分钟|每\d+小时)\s*(\d{1,2}[点时:：]\d{0,2})?\s*(.+)$/u);
  if (cronMatch) {
    const timeExpr = (cronMatch[1] + (cronMatch[2] ? cronMatch[2] : "")).trim();
    const command = cronMatch[3]?.trim();
    if (command && command.length > 1) {
      const job = addNaturalJob(timeExpr, command);
      if (job) {
        say(`定时任务已创建: 「${job.name}」\nCron: ${job.cron}\n下次执行: ${job.nextRun ? new Date(job.nextRun).toLocaleString("zh-CN") : "计算中"}`);
      } else {
        say(`无法解析时间表达式「${timeExpr}」。支持格式：每天19点、每30分钟、每周一9点 等`);
      }
      conversationHistory.push({ role: "user", content: input });
      return;
    }
  }
  if (/^(查看|列出)定时任务/u.test(forVoice)) {
    const jobList = listJobs();
    say("当前定时任务：\n" + formatJobList(jobList));
    conversationHistory.push({ role: "user", content: input });
    return;
  }
  if (/^(删除|取消)定时任务\s*(\d+)/u.test(forVoice)) {
    const m = forVoice.match(/(\d+)/);
    const idx = m ? parseInt(m[1], 10) - 1 : -1;
    const jobList = listJobs();
    if (idx >= 0 && idx < jobList.length) {
      removeJob(jobList[idx].id);
      say(`已删除定时任务「${jobList[idx].name}」`);
    } else {
      say("未找到该定时任务。说「查看定时任务」查看列表。");
    }
    conversationHistory.push({ role: "user", content: input });
    return;
  }

  // 语音模式（VOICE_MODE=1）：简短命令优先走 voice 规则映射，命中则直接执行
  if (process.env.VOICE_MODE === "1" && forVoice) {
    const action = parseVoiceCommandToAction(forVoice);
    if (action) {
      conversationHistory.push({ role: "user", content: input });
      say("语音命令已识别，正在执行…");
      try {
        const ok = await executeVoiceAction(action);
        say(ok ? "已执行。" : "执行未完成。");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        say("执行失败：" + (msg.slice(0, 60) || "请查看日志"));
      }
      conversationHistory.push({ role: "assistant", content: "语音命令已执行" });
      return;
    }
  }

  // 两轮发送：上一轮问了「要发什么内容？」，本轮输入即为消息
  if (pendingWechatSend && trimmed) {
    const message = trimmed;
    const steps = injectWeChatMessage(pendingWechatSend.steps, message);
    pendingWechatSend = null;
    conversationHistory.push({ role: "user", content: input });
    say("正在执行 A11y 连续操作链（" + steps.length + " 步）…");
    try {
      createTask({ kind: "a11y_sequence", steps });
      await runNextTask(a11ySequenceStep, {
        stepTimeoutMs: 90000,
        useStepFallback: false,
      });
      say("A11y 多步链已执行。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[jarvis] a11y_sequence 异常:", err);
      say("执行 A11y 链时出错：" + (msg.slice(0, 80) || "请确认 directshell 与目标窗口可用。"));
    }
    conversationHistory.push({ role: "assistant", content: "已执行发消息" });
    return;
  }
  if (pendingWechatSend && !trimmed) {
    pendingWechatSend = null;
    say("已取消。");
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "已取消发消息" });
    return;
  }

  // ─── 安全网关：在执行前检查操作风险 ───
  const gate = safetyGate(trimmed);
  if (!gate.proceed) {
    if (gate.riskLevel === "blocked") {
      say(gate.message ?? "操作被安全策略拦截。");
      conversationHistory.push({ role: "user", content: input });
      conversationHistory.push({ role: "assistant", content: "安全拦截：" + (gate.message ?? "已阻止") });
      return;
    }
    if (gate.needsConfirmation) {
      say(gate.message ?? "该操作需要确认。");
      pendingSafetyConfirm = { originalInput: input, actionKey: trimmed.slice(0, 60).toLowerCase() };
      conversationHistory.push({ role: "user", content: input });
      conversationHistory.push({ role: "assistant", content: gate.message ?? "等待确认" });
      return;
    }
  }

  // ─── 直接进入创作流水线：关键词触发 ───
  const CREATIVE_TRIGGERS = /^(做|制作|生成|创作|生产)\s*(一[个条段篇]|几[个条段篇])?\s*(口播|图文|漫剧|动画|广告|视频|短视频|帖子|小红书)/u;
  if (CREATIVE_TRIGGERS.test(forVoice)) {
    say("检测到创作需求，启动交互式创作引擎…");
    activePlanSession = createSession(trimmed);
    activePlanSession.topic = trimmed;
    await handlePlanInput(activePlanSession, trimmed, say);
    conversationHistory.push({ role: "user", content: input });
    conversationHistory.push({ role: "assistant", content: "启动创作流水线" });
    return;
  }

  const intent = await parseIntent(input, conversationHistory);
  conversationHistory.push({ role: "user", content: input });

  if (!intent) {
    // ─── 懒加载：尝试匹配或生成场景插件 ───
    const pm = getPluginManager();
    const existingPlugin = pm.matchByInput(trimmed);
    if (existingPlugin) {
      say("匹配到场景插件「" + existingPlugin.manifest.name + "」，正在执行…");
      try {
        await existingPlugin.init?.();
        const pluginCtx: import("./core/pluginManager.js").PluginContext = {
          task: { id: "inline_" + Date.now(), kind: existingPlugin.manifest.supportedKinds[0], status: "running", priority: "medium", payload: { userInput: trimmed }, progress: 0, totalSteps: 1, currentStep: 0, parentId: null, dependsOn: [], scheduledAt: null, startedAt: Date.now(), completedAt: null, error: null, result: null, createdAt: Date.now(), updatedAt: Date.now() },
          stepIndex: 0,
          say,
          askUser: async (q: string) => { say(q); return ""; },
        };
        const result = await existingPlugin.execute(pluginCtx);
        say(result.success ? "插件执行完成。" : "插件执行失败：" + (result.error ?? "未知错误"));
      } catch (e) {
        say("插件执行异常：" + ((e as Error).message ?? "").slice(0, 80));
      }
      conversationHistory.push({ role: "assistant", content: "通过插件执行" });
      return;
    }

    if (CLOUD_LLM_KEY_AVAILABLE && trimmed.length > 8) {
      say("未找到匹配的场景，尝试自动生成插件…");
      const generated = await tryGeneratePlugin(trimmed.slice(0, 30), trimmed).catch(() => null);
      if (generated) {
        say("已自动生成插件「" + generated.manifest.name + "」，正在执行…");
        try {
          await generated.init?.();
          const genCtx: import("./core/pluginManager.js").PluginContext = {
            task: { id: "gen_" + Date.now(), kind: generated.manifest.supportedKinds[0], status: "running", priority: "medium", payload: { userInput: trimmed }, progress: 0, totalSteps: 1, currentStep: 0, parentId: null, dependsOn: [], scheduledAt: null, startedAt: Date.now(), completedAt: null, error: null, result: null, createdAt: Date.now(), updatedAt: Date.now() },
            stepIndex: 0,
            say,
            askUser: async (q: string) => { say(q); return ""; },
          };
          const result = await generated.execute(genCtx);
          say(result.success ? "执行完成。" : "执行失败：" + (result.error ?? "未知错误"));
        } catch (e) {
          say("自动生成的插件执行异常：" + ((e as Error).message ?? "").slice(0, 80));
        }
        conversationHistory.push({ role: "assistant", content: "自动生成插件并执行" });
        return;
      }
    }

    // ─── 技能库：先查已学技能，没有就上网自学 ───
    if (trimmed.length > 4) {
      const existingSkills = findSkills(trimmed, 3);
      if (existingSkills.length > 0) {
        const bestSkill = existingSkills[0];
        say(`技能库命中「${bestSkill.name}」（置信度 ${(bestSkill.confidence * 100).toFixed(0)}%），准备执行…`);
        say(formatSkillPreview(bestSkill));
        const execResult = await executeSkill(bestSkill, { userInput: trimmed, say });
        if (execResult.needsUserConfirm) {
          say(`⚠ ${execResult.confirmReason ?? "该技能需要确认"}。请确认后重新输入。`);
        } else if (execResult.success) {
          say("技能执行成功！");
        } else {
          say("技能执行失败，将尝试其他方式…");
        }
        if (execResult.success || execResult.needsUserConfirm) {
          conversationHistory.push({ role: "assistant", content: "技能库执行: " + bestSkill.name });
          return;
        }
      }

      if (CLOUD_LLM_KEY_AVAILABLE) {
        say("技能库未命中，正在上网搜索学习…");
        const learnResult = await findOrLearn(trimmed);
        if (learnResult.length > 0) {
          const learned = learnResult[0];
          say(`已学到新技能「${learned.name}」，正在执行…`);
          const execResult = await executeSkill(learned, { userInput: trimmed, say });
          if (execResult.success) {
            say("自学的技能执行成功！下次遇到类似任务会直接使用。");
            conversationHistory.push({ role: "assistant", content: "自学并执行: " + learned.name });
            return;
          }
          say("自学的技能执行未成功，继续研究其他方案…");
        } else {
          say("未能从网上学到可用技巧，继续研究…");
        }
      }
    }

    say("正在研究最优方案…");
    try {
      const res = await research(input);
      if (res.needsUserConsent) {
        say("先生，该操作涉及付费、扫码或隐私，请确认后再试。");
        conversationHistory.push({ role: "assistant", content: "需用户确认" });
        return;
      }
      if (res.suggestedApproach === "powershell" && res.scriptSnippet) {
        const out = await executePowerShell(res.scriptSnippet);
        if (out.ok) say("已按研究方案执行 PowerShell。");
        else say("执行失败：" + (out.stderr || out.stdout).slice(0, 120));
        conversationHistory.push({ role: "assistant", content: "自主执行 PowerShell" });
        return;
      }
      if (res.suggestedApproach === "batch" && res.scriptSnippet) {
        const out = await executeBatch(res.scriptSnippet);
        if (out.ok) say("已按研究方案执行批处理。");
        else say("执行失败：" + (out.stderr || out.stdout).slice(0, 120));
        conversationHistory.push({ role: "assistant", content: "自主执行批处理" });
        return;
      }
      if (res.suggestedApproach === "cli" && res.toolName) {
        const toolPath = await ensureTool(res.toolName, { researchTask: input });
        if (toolPath) say("已按研究方案准备工具 " + res.toolName + "，可继续下达下载等指令。");
        else say("研究建议使用 " + res.toolName + "，但自动安装未成功，请手动安装后重试。");
        conversationHistory.push({ role: "assistant", content: "自主准备工具 " + res.toolName });
        return;
      }
      if (res.suggestedApproach === "mirror_download" || res.suggestedApproach === "script_scrape") {
        const keywords = input.replace(/[，。！？、]/g, " ").trim().slice(0, 40);
        say("已按研究结论转为资源检索，正在为您检索…");
        const results = await huntResources({ keywords });
        if (results.length === 0) {
          say("未找到符合条件的结果。");
        } else {
          printHuntTable(results);
          await runResourceHuntConfirmation(rl, say, results, { keywords });
        }
        conversationHistory.push({ role: "assistant", content: "自主转为资源猎人" });
        return;
      }
      say(res.summary ? "研究结论：" + res.summary.slice(0, 150) + "。若需进一步执行，请说明具体操作。" : "未识别的指令。" + HELP_TEXT);
    } catch (err) {
      console.error("[jarvis] 自主研究异常:", err);
      say("未识别的指令。" + HELP_TEXT);
    }
    conversationHistory.push({ role: "assistant", content: "未识别或研究后未执行" });
    return;
  }

  if (intent.kind === "help") {
    say(HELP_TEXT);
    conversationHistory.push({ role: "assistant", content: "已回复帮助" });
    return;
  }

  if (isResourceHuntIntent(intent)) {
    say("正在为您检索资源…");
    try {
      const results = await huntResources({
        keywords: intent.keywords,
        qualityOrType: intent.qualityOrType,
      });
      if (results.length === 0) {
        say("未找到符合条件的结果，可换个关键词再试。");
        conversationHistory.push({ role: "assistant", content: "资源猎人：无结果" });
        return;
      }
      printHuntTable(results);
      await runResourceHuntConfirmation(rl, say, results, {
        keywords: intent.keywords,
        qualityOrType: intent.qualityOrType,
      });
      conversationHistory.push({ role: "assistant", content: "资源猎人：已展示并等待选择" });
    } catch (err) {
      console.error("[jarvis] 资源猎人异常:", err);
      say("检索时出错，请查看日志。");
      conversationHistory.push({ role: "assistant", content: "资源猎人：异常" });
    }
    return;
  }

  if (intent.kind === "manage_file" && intent.action === "create_folder") {
    const ctx: RunContext = {};
    await executeStep(intent, ctx);
    conversationHistory.push({ role: "assistant", content: "已执行：建文件夹 " + intent.folderName });
    return;
  }

  // ─── 创作类意图：匹配模板时启动交互式流水线 ───
  if (intent.kind === "puppeteer_web_gen") {
    const tmplMatch = matchTemplate(input);
    if (tmplMatch) {
      say("检测到创作需求，启动交互式创作引擎…");
      activePlanSession = createSession(trimmed);
      activePlanSession.topic = trimmed;
      await handlePlanInput(activePlanSession, trimmed, say);
      conversationHistory.push({ role: "assistant", content: "启动创作流水线" });
      return;
    }
  }

  if (intent.kind === "puppeteer_web_gen") {
    say("正在通过浏览器执行网页创作（" + intent.tool + "）…");
    showOverlay();
    updateOverlay("网页创作: " + intent.tool, 10);
    habit.logOperation({ actionType: "web_gen", target: intent.tool, details: { prompt: intent.prompt.slice(0, 50) } });
    const startMs = Date.now();
    let success = false;
    try {
      const toolFns: Record<string, () => Promise<browserBridge.WebGenResult>> = {
        tongyi_wanxiang: () => browserBridge.tongyiWanxiangTextToImage(intent.prompt),
        doubao: () => browserBridge.doubaoTextToImage(intent.prompt),
        deepseek: () => browserBridge.deepseekCopywriting(intent.prompt),
        gemini: () => browserBridge.geminiCopywriting(intent.prompt),
        kling: () => browserBridge.klingImageToVideo(intent.imagePath ?? "", intent.prompt),
        jimeng: () => browserBridge.jimengImageToVideo(intent.imagePath ?? "", intent.prompt),
      };
      const fn = toolFns[intent.tool];
      if (fn) {
        const result = await fn();
        success = result.success;
        if (result.success) {
          if (result.text) say("文案生成完成：\n" + result.text.slice(0, 500));
          else say("生成完成！保存在：" + (result.outputPath ?? "下载目录"));
        } else {
          say("生成失败：" + (result.error ?? "未知错误"));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[jarvis] puppeteer_web_gen 异常:", err);
      say("浏览器操作出错：" + (msg.slice(0, 80) || "请查看日志"));
    }
    updateOverlay(success ? "完成" : "失败", success ? 100 : 0);
    setTimeout(hideOverlay, 2000);
    const dur = Date.now() - startMs;
    const scene = memoryGraph.ensureNode("scene", "网页创作");
    const action = memoryGraph.ensureNode("action", intent.tool);
    const result = memoryGraph.ensureNode("result", success ? "成功" : "失败");
    memoryGraph.recordExecution(scene, action, result, { success, durationMs: dur, engine: "puppeteer" });
    conversationHistory.push({ role: "assistant", content: "已执行网页创作：" + intent.tool });
    return;
  }

  if (isLongPlanIntent(intent)) {
    say("识别为长周期计划：「" + intent.name + "」");
    say("优先级：" + intent.priority + (intent.deadline ? "，截止日期：" + intent.deadline : ""));
    say("共 " + intent.stages.length + " 个阶段：");
    for (let i = 0; i < intent.stages.length; i++) {
      const s = intent.stages[i];
      const deps = s.dependsOnStageIndex?.length ? `（依赖阶段 ${s.dependsOnStageIndex.map((d) => d + 1).join(",")}）` : "（可独立执行）";
      say(`  ${i + 1}. [${s.kind}] ${s.name} ${deps}`);
      if (s.description) say(`     ${s.description}`);
    }

    const scheduler = getScheduler({ maxParallel: 3, enablePreflight: true });
    const plan = scheduler.submitPlan({
      name: intent.name,
      priority: intent.priority,
      stages: intent.stages.map((s) => ({
        name: s.name,
        kind: s.kind,
        payload: { description: s.description, config: intent.config },
        dependsOnStageIndex: s.dependsOnStageIndex,
      })),
    });

    say("计划已创建（ID: " + plan.id + "），子任务已入队。");
    if (intent.config?.savePath) say("输出路径：" + intent.config.savePath);
    say("提示：执行器注册后可通过 scheduler.start() 启动调度。");
    conversationHistory.push({ role: "assistant", content: "已创建长计划：" + intent.name });
    return;
  }

  if (intent.kind === "a11y_sequence") {
    let steps = intent.steps;
    // 一次性说完：提取「给X发：内容」并注入
    const wechatInfo = extractWeChatSendInfo(input);
    if (wechatInfo) console.log("[parseIntent] 发微信解析: contact=" + wechatInfo.contact + ", message=" + (wechatInfo.message ?? "(无)"));
    if (wechatInfo?.message && isWeChatSendFlow(steps)) {
      steps = injectWeChatMessage(steps, wechatInfo.message);
      intent.steps = steps;
    }
    // 主动询问：发微信但无消息时，等下一轮
    if (isWeChatSendFlow(steps) && !hasMessageInWeChatFlow(steps)) {
      say("要发什么内容？");
      pendingWechatSend = { contact: wechatInfo?.contact ?? "某人", steps };
      conversationHistory.push({ role: "assistant", content: "要发什么内容？" });
      return;
    }
    // 发微信：云端常把 open_app 误写成「微信阿尔法」，修正为 open_app 微信
    if (wechatInfo?.contact && isWeChatSendFlow(steps)) {
      steps = fixWeChatOpenAppStep(steps, wechatInfo.contact);
      intent.steps = steps;
    }
    // 发微信：有 contact 时强制插入搜索流程（Ctrl+F → 输入联系人 → Enter），避免发给当前聊天
    if (wechatInfo?.contact && isWeChatSendFlow(steps)) {
      steps = ensureWeChatSearchFlowWithContact(steps, wechatInfo.contact);
      intent.steps = steps;
    }
    if (wechatInfo && isWeChatSendFlow(steps)) {
      console.log("[jarvis] 发微信解析: contact=%s, message=%s, steps=%s", wechatInfo.contact ?? "-", wechatInfo.message ?? "-", steps.length);
    }
    say("正在执行 A11y 连续操作链（" + steps.length + " 步）…");
    showOverlay();
    updateOverlay("准备执行 " + steps.length + " 步", 0);
    if (wfr.isRecording()) {
      for (const s of steps) {
        const wfStep: wfr.WorkflowStep = { type: s.type as wfr.WorkflowStep["type"] };
        if ("app" in s) wfStep.target = (s as { app: string }).app;
        if ("name" in s) wfStep.target = (s as { name: string }).name;
        if ("text" in s) wfStep.value = (s as { text: string }).text;
        wfr.captureStep(wfStep);
      }
    }
    const a11yStart = Date.now();
    let a11ySuccess = false;
    const appName = steps.find((s) => s.type === "open_app")?.type === "open_app" ? (steps.find((s) => s.type === "open_app") as { app: string }).app : "未知";
    habit.logOperation({ actionType: "a11y_sequence", target: appName, details: { stepCount: steps.length } });
    const stepNames = steps.map((s) => s.type + (("app" in s) ? " " + (s as { app: string }).app : ("name" in s) ? " " + (s as { name: string }).name : ""));
    habit.recordSequence(stepNames, 0);
    try {
      createTask({ kind: "a11y_sequence", steps });
      await runNextTask(a11ySequenceStep, {
        stepTimeoutMs: 90000,
        useStepFallback: false,
      });
      a11ySuccess = true;
      updateOverlay("完成", 100);
      setTimeout(hideOverlay, 2000);
      say("A11y 多步链已执行。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[jarvis] a11y_sequence 异常:", err);
      updateOverlay("失败", 0);
      setTimeout(hideOverlay, 3000);
      say("执行 A11y 链时出错：" + (msg.slice(0, 80) || "请确认 directshell 与目标窗口可用。"));
    }
    const a11yDur = Date.now() - a11yStart;
    const a11yScene = memoryGraph.ensureNode("scene", "A11y:" + appName);
    const a11yAction = memoryGraph.ensureNode("action", "a11y_sequence_" + steps.length + "步");
    const a11yResult = memoryGraph.ensureNode("result", a11ySuccess ? "成功" : "失败");
    memoryGraph.recordExecution(a11yScene, a11yAction, a11yResult, { success: a11ySuccess, durationMs: a11yDur, engine: "uia" });
    conversationHistory.push({ role: "assistant", content: summarizeIntent(intent) });
    return;
  }

  if (isMultiStepIntent(intent)) {
    const n = intent.tasks.length;
    say("好的，先生，将按序执行 " + n + " 步…");
    const context: RunContext = {};
    try {
      for (let i = 0; i < intent.tasks.length; i++) {
        const task = intent.tasks[i];
        if (task.kind === "resource_hunt") {
          say("正在为您检索资源…");
          const results = await huntResources({
            keywords: task.keywords,
            qualityOrType: task.qualityOrType,
          });
          if (results.length === 0) {
            say("未找到符合条件的结果。");
          } else {
            printHuntTable(results);
            await runResourceHuntConfirmation(rl, say, results, {
              keywords: task.keywords,
              qualityOrType: task.qualityOrType,
            }, context);
          }
        } else {
          await executeStep(task, context);
        }
        if (i < intent.tasks.length - 1) await delay(STEP_DELAY_MS);
      }
      say("全部完成。");
    } catch (err) {
      console.error("[jarvis] 多步执行异常:", err);
      say("执行过程中出现异常，请查看日志。");
    }
    conversationHistory.push({ role: "assistant", content: summarizeIntent(intent) });
    return;
  }

  try {
    await executeStep(intent);
  } catch (err) {
    console.error("[jarvis] 执行异常:", err);
    say("执行时出错，请查看日志。");
  }
  conversationHistory.push({ role: "assistant", content: summarizeIntent(intent) });
}

async function initPlugins(): Promise<void> {
  const pm = getPluginManager();
  try {
    const svp = await import("./plugins/shortVideoPlugin.js");
    pm.register(svp.default);
  } catch { /* optional */ }
  try {
    const rdp = await import("./plugins/resourceDownloadPlugin.js");
    pm.register(rdp.default);
  } catch { /* optional */ }
  await loadGeneratedPlugins().catch(() => {});
  console.log("[jarvis] 已注册", pm.listPlugins().length, "个场景插件（含自动生成）");
}

function showSuggestions(): void {
  const suggestions = habit.suggestActions();
  if (suggestions.length > 0) {
    say("基于你的使用习惯，推荐操作：");
    for (const s of suggestions.slice(0, 3)) {
      say("  - " + s.action + " (" + s.reason + ")");
    }
  }
}

function main(): void {
  const conversationHistory: ConversationMessage[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const baseURL = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1").trim().replace(/localhost/gi, "127.0.0.1");
  const useOllama = baseURL.includes("11434") || baseURL.includes("ollama");
  const useLLM = Boolean(process.env.OPENAI_API_KEY) || useOllama;

  initPlugins().catch((e) => console.warn("[jarvis] 插件初始化异常:", e));

  if (process.env.TTS_ENABLED === "1") {
    setTtsEnabled(true);
    console.log("[jarvis] TTS 语音反馈已启用");
  }

  if (useLLM) {
    say(useOllama ? "在线。六层能力架构已激活（Ollama + DeepSeek），请输入指令。" : "在线。六层能力架构已激活（LLM），请输入指令。");
  } else {
    say("在线。关键词模式，请输入指令（如：点搜索、点扩展、执行）。");
  }

  showSuggestions();

  startCronScheduler(async (cmd) => {
    say(`[定时] 执行: ${cmd}`);
    await dispatch(cmd, conversationHistory, rl);
  });

  function loop(): void {
    rl.question(PROMPT, (line) => {
      if (line === null || line === undefined) {
        rl.close();
        return;
      }
      dispatch(line.trim(), conversationHistory, rl).then(() => loop());
    });
  }

  loop();
}

main();
