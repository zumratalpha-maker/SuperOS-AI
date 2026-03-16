/**
 * 网页创作工具 a11y steps 构建 + Puppeteer 直控
 * UIA 路径：依据 automation_memory 与全球教程，操作现有网页
 * Puppeteer 路径（推荐）：通过 browserBridge 直接控制浏览器 DOM，稳定性远高于 UIA
 */

import * as browserBridge from "../tools/browserBridge.js";

export type WebGenStep =
  | { type: "open_app"; app: string }
  | { type: "click"; name: string }
  | { type: "type"; text: string }
  | { type: "keys"; keys: string }
  | { type: "wait"; ms: number };

/**
 * Puppeteer 路径：通义万相文生图
 * 优先使用此方法，UIA 路径作为兜底
 */
export async function runTongyiWanxiangViaPuppeteer(prompt: string, outDir?: string) {
  return browserBridge.tongyiWanxiangTextToImage(prompt, outDir);
}

/** Puppeteer 路径：豆包文生图 */
export async function runDoubaoViaPuppeteer(prompt: string, outDir?: string) {
  return browserBridge.doubaoTextToImage(prompt, outDir);
}

/** Puppeteer 路径：可灵图生视频 */
export async function runKlingViaPuppeteer(imagePath: string, motionPrompt?: string, outDir?: string) {
  return browserBridge.klingImageToVideo(imagePath, motionPrompt, outDir);
}

/** Puppeteer 路径：即梦图生视频 */
export async function runJimengViaPuppeteer(imagePath: string, motionPrompt?: string, outDir?: string) {
  return browserBridge.jimengImageToVideo(imagePath, motionPrompt, outDir);
}

/** Puppeteer 路径：Gemini 文案 */
export async function runGeminiViaPuppeteer(prompt: string) {
  return browserBridge.geminiCopywriting(prompt);
}

/** 页面加载等待（ms） */
const PAGE_LOAD_MS = 5000;
/** 生成等待（文生图约10-30秒，图生视频约30-60秒） */
const GEN_IMAGE_MS = 20000;
const GEN_VIDEO_MS = 45000;

/**
 * 通义万相文生图 steps
 * 直达 URL 为 text-to-image 页面，打开后直接输入+生成
 * 步骤来源：automation_memory 5.2
 */
export function buildTongyiWanxiangImageSteps(prompt: string): WebGenStep[] {
  return [
    { type: "open_app", app: "通义万相" },
    { type: "wait", ms: PAGE_LOAD_MS },
    { type: "click", name: "输入框" },
    { type: "type", text: prompt },
    { type: "click", name: "生成创意画作" },
    { type: "wait", ms: GEN_IMAGE_MS },
    { type: "click", name: "下载原图" },
  ];
}

/**
 * 豆包文生图 steps
 * 需从首页点击「图片生成」进入
 * 步骤来源：automation_memory 5.1
 */
export function buildDoubaoImageSteps(prompt: string): WebGenStep[] {
  return [
    { type: "open_app", app: "豆包" },
    { type: "wait", ms: PAGE_LOAD_MS },
    { type: "click", name: "图片生成" },
    { type: "wait", ms: 3000 },
    { type: "click", name: "输入框" },
    { type: "type", text: prompt },
    { type: "click", name: "生成" },
    { type: "wait", ms: GEN_IMAGE_MS },
    { type: "click", name: "下载" },
  ];
}

/**
 * Gemini 文案生成 steps
 * 底部输入框输入 → 点击提交
 * 步骤来源：automation_memory 与 Google 官方教程
 */
export function buildGeminiCopywritingSteps(prompt: string): WebGenStep[] {
  return [
    { type: "open_app", app: "Gemini" },
    { type: "wait", ms: PAGE_LOAD_MS },
    { type: "click", name: "输入" },
    { type: "type", text: prompt },
    { type: "keys", keys: "{ENTER}" },
    { type: "wait", ms: 15000 },
  ];
}

/**
 * 可灵图生视频 steps
 * 上传图片 → 输入运动描述 → 生成 → 下载
 * 步骤来源：automation_memory 5.3
 */
export function buildKlingVideoSteps(imagePath: string, motionPrompt?: string): WebGenStep[] {
  const steps: WebGenStep[] = [
    { type: "open_app", app: "可灵" },
    { type: "wait", ms: PAGE_LOAD_MS },
    { type: "click", name: "上传" },
    { type: "wait", ms: 2000 },
    { type: "type", text: imagePath },
    { type: "keys", keys: "{ENTER}" },
    { type: "wait", ms: 3000 },
  ];
  if (motionPrompt) {
    steps.push({ type: "click", name: "运动描述" }, { type: "type", text: motionPrompt });
  }
  steps.push(
    { type: "click", name: "生成" },
    { type: "wait", ms: GEN_VIDEO_MS },
    { type: "click", name: "下载" }
  );
  return steps;
}

/**
 * 即梦图生视频 steps
 * 参考导入 → 选图 → 生成视频 → 输入关键词 → 生成 → 下载
 * 步骤来源：automation_memory 5.4
 */
export function buildJimengVideoSteps(imagePath: string, motionPrompt?: string): WebGenStep[] {
  const steps: WebGenStep[] = [
    { type: "open_app", app: "即梦" },
    { type: "wait", ms: PAGE_LOAD_MS },
    { type: "click", name: "参考导入" },
    { type: "wait", ms: 2000 },
    { type: "type", text: imagePath },
    { type: "keys", keys: "{ENTER}" },
    { type: "wait", ms: 5000 },
    { type: "click", name: "生成视频" },
    { type: "wait", ms: 2000 },
  ];
  if (motionPrompt) {
    steps.push({ type: "click", name: "关键词" }, { type: "type", text: motionPrompt });
  }
  steps.push({ type: "click", name: "生成" }, { type: "wait", ms: GEN_VIDEO_MS }, { type: "click", name: "下载" });
  return steps;
}
