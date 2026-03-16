/**
 * 短视频流水线主流程编排
 * Phase C P0：打开剪映 + 导出到指定路径
 * Phase C P1：打开剪映 + 导入本地素材 + 导出
 * Phase C 端到端：话题 → 文案 → 文生图（Puppeteer 优先，UIA 兜底）→ [可选] 剪映导入导出
 */

import { runA11ySequence } from "../runA11ySequence.js";
import { buildJianyingExportSteps, buildJianyingImportAndExportSteps } from "./jianyingSteps.js";
import { generateCopywriting } from "../copywriting/index.js";
import { buildTongyiWanxiangImageSteps } from "./webGenSteps.js";
import * as browserBridge from "../tools/browserBridge.js";

export interface ExportOptions {
  /** 导出文件名，如 output.mp4 */
  filename?: string;
  /** 是否保存到桌面，默认 true */
  toDesktop?: boolean;
}

export interface ImportAndExportOptions {
  /** 本地视频/图片绝对路径（如 C:\\Users\\xxx\\Videos\\a.mp4） */
  importPath: string;
  /** 导出文件名，默认 output.mp4 */
  filename?: string;
  /** 是否保存到桌面，默认 true */
  toDesktop?: boolean;
}

/**
 * P0：打开剪映并导出到指定路径
 * 依赖：runA11ySequence、剪映已安装、工程需有素材（空工程亦可导出黑屏用于验证）
 */
export async function runJianyingExport(options?: ExportOptions): Promise<{ ok: boolean; error?: string }> {
  try {
    const steps = buildJianyingExportSteps(options?.filename, options?.toDesktop ?? true);
    const payload = { kind: "a11y_sequence" as const, steps };
    await runA11ySequence(payload);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error("[videoPipeline] 剪映导出失败:", msg);
    return { ok: false, error: msg };
  }
}

/**
 * P1：打开剪映 + 导入本地素材 + 导出
 * 流程：开始创作 → 点击导入 → 输入路径 → Enter 确认 → 导出到桌面
 */
export async function runJianyingFullPipeline(
  options: ImportAndExportOptions
): Promise<{ ok: boolean; error?: string }> {
  try {
    const steps = buildJianyingImportAndExportSteps(
      options.importPath,
      options.filename,
      options.toDesktop ?? true
    );
    const payload = { kind: "a11y_sequence" as const, steps };
    await runA11ySequence(payload);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error("[videoPipeline] 剪映导入导出失败:", msg);
    return { ok: false, error: msg };
  }
}

/** 端到端流水线选项：话题 → 文案 → 文生图 → [可选] 剪映 */
export interface FullE2EOptions {
  /** 文生图下载后，用此路径导入剪映；不传则只执行到文生图 */
  imagePath?: string;
  /** 剪映导出文件名，默认 output.mp4 */
  outputFilename?: string;
}

/** 从文案取前 N 字作为文生图 prompt（通义万相用中文） */
function extractImagePrompt(copywriting: string, maxChars = 80): string {
  const t = (copywriting ?? "").trim();
  if (!t) return "简约风格插画";
  const firstLine = t.split(/\n/)[0]?.trim() ?? t;
  if (firstLine.length <= maxChars) return firstLine;
  return firstLine.slice(0, maxChars);
}

/**
 * 端到端流水线：话题 → 文案(LLM) → 文生图(Puppeteer 优先，UIA 兜底) → [可选] 剪映导入导出
 * 若提供 imagePath，则文生图执行后继续剪映；否则只执行到文生图下载
 */
export async function runFullE2EPipeline(
  topic: string,
  options?: FullE2EOptions
): Promise<{ ok: boolean; copywriting?: string; imagePrompt?: string; imagePath?: string; error?: string }> {
  try {
    const t = (topic ?? "").trim();
    if (!t) {
      return { ok: false, error: "话题不能为空" };
    }

    console.log("[videoPipeline] 阶段1: 生成文案…");
    const copywriting = await generateCopywriting(t);
    const imagePrompt = extractImagePrompt(copywriting);
    console.log("[videoPipeline] 文案前80字(文生图prompt):", imagePrompt);

    console.log("[videoPipeline] 阶段2: 通义万相文生图（Puppeteer 优先）…");
    let generatedImagePath: string | undefined;

    const puppeteerResult = await browserBridge.tongyiWanxiangTextToImage(imagePrompt);
    if (puppeteerResult.success && puppeteerResult.outputPath) {
      generatedImagePath = puppeteerResult.outputPath;
      console.log("[videoPipeline] Puppeteer 文生图成功:", generatedImagePath);
    } else {
      console.warn("[videoPipeline] Puppeteer 文生图失败:", puppeteerResult.error, "，回退 UIA 路径…");
      const imageSteps = buildTongyiWanxiangImageSteps(imagePrompt);
      await runA11ySequence({ kind: "a11y_sequence", steps: imageSteps });
      console.log("[videoPipeline] UIA 文生图步骤已执行（需手动确认图片下载位置）");
    }

    const imagePath = options?.imagePath?.trim() ?? generatedImagePath;
    if (imagePath) {
      console.log("[videoPipeline] 阶段3: 剪映导入+导出…");
      const jianying = await runJianyingFullPipeline({
        importPath: imagePath,
        filename: options?.outputFilename ?? "output.mp4",
        toDesktop: true,
      });
      if (!jianying.ok) return { ok: false, copywriting, imagePrompt, imagePath, error: jianying.error };
    } else {
      console.log("[videoPipeline] 未获取到图片路径，跳过剪映。可用 --imagePath 指定路径再跑剪映。");
    }

    return { ok: true, copywriting, imagePrompt, imagePath };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error("[videoPipeline] 端到端失败:", msg);
    return { ok: false, error: msg };
  } finally {
    await browserBridge.closeBrowser().catch(() => {});
  }
}
