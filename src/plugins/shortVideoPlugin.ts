/**
 * 短视频生产插件 v2 — 基于交互式流水线引擎
 *
 * 不再硬编码 "DeepSeek -> 通义万相 -> 可灵" 三步。
 * 而是：检测意图 → 启动交互式会话 → 用户选工具 → 确认 → 逐步执行。
 * 当通过 pluginManager 直接调用时（非 jarvis 路径），提供简化的自动执行流程。
 */

import { type IPlugin, type PluginManifest, type PluginContext } from "../core/pluginManager.js";
import { type ValidationSpec } from "../core/validator.js";
import {
  createSession,
  handleInput,
  isReadyToExecute,
  type PlanSession,
} from "../pipeline/interactivePlanner.js";
import { executePipeline } from "../pipeline/pipelineExecutor.js";
import { matchTemplate } from "../pipeline/pipelineTemplates.js";
import { recommendTool } from "../pipeline/toolRegistry.js";

const manifest: PluginManifest = {
  id: "short_video",
  name: "短视频生产流水线",
  version: "2.0.0",
  description: "交互式创作引擎：支持口播/图文/漫剧/广告，多工具选择，登录管理，分步确认",
  supportedKinds: ["generate_content", "short_video_pipeline"],
  requirements: {
    network: true,
    minDiskGB: 2,
  },
  intentPatterns: [
    "短视频", "小红书.*图文", "生产.*视频", "口播",
    "话题.*文案.*图", "文案.*图.*视频", "漫剧", "广告.*视频",
    "图文.*帖子", "做.*视频", "制作.*视频",
  ],
};

const plugin: IPlugin = {
  manifest,

  async execute(ctx: PluginContext) {
    const { task } = ctx;
    const payload = task.payload as Record<string, unknown>;
    const userInput = (payload.userInput as string) || (payload.topic as string) || (payload.description as string) || "热点话题";

    const session = createSession(userInput);
    const tmpl = matchTemplate(userInput);

    if (tmpl) {
      session.selectedTemplate = tmpl;
      session.contentType = tmpl.id;
      session.state = "selecting_tools";

      for (const step of tmpl.steps) {
        if (step.optional) continue;
        const rec = await recommendTool(step.category);
        if (rec) session.toolChoices.set(step.id, rec.id);
      }

      ctx.say(`启动「${tmpl.name}」流水线（自动模式）…`);

      try {
        session.state = "ready_to_execute" as PlanSession["state"];
        session.state = "executing";

        const report = await executePipeline(session, {
          say: ctx.say,
          onProgress: (_idx, _total, name) => {
            ctx.say(`  → ${name}…`);
          },
          onCheckpoint: async (_stepId, result) => {
            if (result.text) ctx.say(`预览：${result.text.slice(0, 200)}…`);
            if (result.outputPath) ctx.say(`文件：${result.outputPath}`);
            return "continue";
          },
        });

        return {
          success: report.success,
          data: {
            report,
            outputs: Object.fromEntries(session.outputs),
          },
          error: report.success ? undefined : "部分步骤失败",
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }

    ctx.say("未匹配到流水线模板，回退到基础文案生成…");
    try {
      const bb = await import("../tools/browserBridge.js");
      const result = await bb.deepseekCopywriting(
        `请写一段关于「${userInput}」的短视频文案，100～200字，口语化，有节奏感，包含标题和标签。`,
      );
      if (!result.success) return { success: false, error: result.error };
      ctx.say("文案：\n" + (result.text?.slice(0, 300) ?? ""));
      return { success: true, data: { copywriting: result.text } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  getValidation(ctx: PluginContext): ValidationSpec | null {
    const payload = ctx.task.payload as Record<string, unknown>;
    const stage = payload.stageName as string;
    if (stage === "生成图片") {
      return { type: "file_exists", params: { path: payload.imagePath || "", minSizeBytes: 10000 } };
    }
    if (stage === "生成视频") {
      return { type: "file_exists", params: { path: payload.videoPath || "", minSizeBytes: 100000 } };
    }
    return null;
  },
};

export default plugin;
