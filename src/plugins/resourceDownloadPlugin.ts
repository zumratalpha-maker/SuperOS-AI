/**
 * 资源下载+智能整理插件
 * 搜索资源 → 下载 → 按类型/主题自动分类到指定目录
 */

import { type IPlugin, type PluginManifest, type PluginContext } from "../core/pluginManager.js";
import { type ValidationSpec } from "../core/validator.js";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, extname } from "node:path";

const manifest: PluginManifest = {
  id: "resource_download",
  name: "资源下载+智能整理",
  version: "1.0.0",
  description: "搜索下载教程/电影/文档等资源，按类型智能分类到目标目录",
  supportedKinds: ["download", "collect_resources", "organize_files"],
  requirements: {
    network: true,
    minDiskGB: 5,
  },
  intentPatterns: [
    "下载.*教程", "下载.*电影", "下载.*视频",
    "找.*资源", "搜.*资料",
    "整理.*文件", "整理.*下载",
  ],
};

const CATEGORY_MAP: Record<string, string[]> = {
  "视频": [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"],
  "图片": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"],
  "文档": [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md"],
  "音频": [".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma"],
  "压缩包": [".zip", ".rar", ".7z", ".tar", ".gz"],
  "程序": [".exe", ".msi", ".dmg", ".deb", ".rpm"],
};

function categorizeFile(filename: string): string {
  const ext = extname(filename).toLowerCase();
  for (const [category, exts] of Object.entries(CATEGORY_MAP)) {
    if (exts.includes(ext)) return category;
  }
  return "其他";
}

const plugin: IPlugin = {
  manifest,

  async execute(ctx: PluginContext) {
    const { task, stepIndex } = ctx;
    const payload = task.payload as Record<string, unknown>;
    const stage = payload.stageName as string | undefined;

    if (stage === "搜索资源" || (task.kind === "collect_resources" && stepIndex === 0)) {
      ctx.say("正在搜索资源...");
      const keywords = (payload.keywords as string) || (payload.description as string) || "";
      try {
        const { huntResources } = await import("../tools/ResourceHunter.js");
        const results = await huntResources({ keywords });
        if (results.length === 0) return { success: false, error: "未找到匹配资源" };
        ctx.say(`找到 ${results.length} 个结果`);
        return { success: true, data: { results, count: results.length } };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }

    if (stage === "下载资源" || (task.kind === "download" && stepIndex === 0)) {
      ctx.say("资源下载将通过 aria2 执行...");
      const url = payload.url as string;
      if (!url) return { success: true, data: { message: "等待用户选择资源后下载" } };
      try {
        const { downloadWithAria2 } = await import("../tools/downloadExecutor.js");
        const dl = await downloadWithAria2(url);
        if (dl.ok) {
          ctx.say("下载任务已添加");
          return { success: true, data: { downloadStarted: true } };
        }
        return { success: false, error: dl.message ?? "下载失败" };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }

    if (stage === "整理文件" || task.kind === "organize_files") {
      const sourceDir = (payload.sourceDir as string) || join(process.env.USERPROFILE ?? "", "Downloads");
      const targetDir = (payload.targetDir as string) || (payload.config as Record<string, unknown>)?.savePath as string || sourceDir;

      ctx.say(`正在整理目录：${sourceDir} → ${targetDir}`);

      if (!existsSync(sourceDir)) return { success: false, error: `源目录不存在: ${sourceDir}` };

      const files = readdirSync(sourceDir, { withFileTypes: true }).filter((f) => f.isFile());
      let moved = 0;

      for (const file of files) {
        const category = categorizeFile(file.name);
        const catDir = join(targetDir, category);
        if (!existsSync(catDir)) mkdirSync(catDir, { recursive: true });

        const src = join(sourceDir, file.name);
        const dst = join(catDir, file.name);
        if (src !== dst) {
          try {
            renameSync(src, dst);
            moved++;
          } catch { /* skip locked files */ }
        }
      }

      ctx.say(`整理完成：${moved} 个文件已分类`);
      return { success: true, data: { movedCount: moved, categories: Object.keys(CATEGORY_MAP) } };
    }

    return { success: true };
  },

  getValidation(ctx: PluginContext): ValidationSpec | null {
    const payload = ctx.task.payload as Record<string, unknown>;
    if (ctx.task.kind === "organize_files") {
      const dir = (payload.targetDir as string) || "";
      if (dir) return { type: "directory_has_files", params: { path: dir, minCount: 1 } };
    }
    return null;
  },
};

export default plugin;
