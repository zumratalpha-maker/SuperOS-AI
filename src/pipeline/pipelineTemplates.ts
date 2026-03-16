/**
 * 流水线模板 — 定义不同内容类型的步骤序列
 * 每步声明需要哪类工具、是否需要用户确认、依赖关系、预估时间
 */

import { type ToolCategory } from "./toolRegistry.js";

export interface PipelineStep {
  id: string;
  name: string;
  category: ToolCategory;
  requiresUserConfirm: boolean;
  inputFrom?: string;
  description: string;
  optional?: boolean;
  estimatedSeconds?: number;
  promptTemplate?: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  estimatedMinutes: number;
  keywords: string[];
}

// ─── 口播视频 ───

const talkingHead: PipelineTemplate = {
  id: "talking_head",
  name: "口播视频",
  description: "AI 生成文案 → 语音合成 → 数字人口型同步 → 导出成品视频",
  estimatedMinutes: 8,
  keywords: ["口播", "数字人", "talking", "真人出镜", "讲解", "播报"],
  steps: [
    {
      id: "script",
      name: "生成口播脚本",
      category: "copywriting",
      requiresUserConfirm: true,
      description: "根据话题生成 30-60 秒的口播稿件，包含开头吸引、正文要点、结尾引导",
      estimatedSeconds: 10,
      promptTemplate: "请写一段关于「{topic}」的口播视频脚本，30-60秒时长，口语化，有节奏感。包含：1.开头吸引（前3秒抓眼球）2.正文要点（3-5个要点）3.结尾引导（关注/点赞）。直接输出脚本文字，不要标注时间码。",
    },
    {
      id: "voiceover",
      name: "AI 配音",
      category: "voice",
      requiresUserConfirm: false,
      inputFrom: "script",
      description: "将脚本转为语音音频文件",
      estimatedSeconds: 15,
    },
    {
      id: "lipsync",
      name: "数字人口型同步",
      category: "lipsync",
      requiresUserConfirm: true,
      inputFrom: "voiceover",
      description: "用 AI 数字人生成与配音同步的口播视频",
      estimatedSeconds: 120,
    },
    {
      id: "edit_export",
      name: "剪辑导出",
      category: "editing",
      requiresUserConfirm: false,
      inputFrom: "lipsync",
      description: "添加字幕、背景音乐，导出成品",
      optional: true,
      estimatedSeconds: 60,
    },
  ],
};

// ─── 图文帖子 ───

const imageTextPost: PipelineTemplate = {
  id: "image_text",
  name: "图文帖子",
  description: "生成文案 → 提炼图片提示词 → 批量生成配图 → 组合排版",
  estimatedMinutes: 5,
  keywords: ["图文", "小红书", "帖子", "图片", "配图", "种草", "分享"],
  steps: [
    {
      id: "copywriting",
      name: "生成文案 + 标签",
      category: "copywriting",
      requiresUserConfirm: true,
      description: "生成图文帖子的正文、标题和话题标签",
      estimatedSeconds: 10,
      promptTemplate: "请写一篇关于「{topic}」的小红书/社交媒体图文帖子。要求：1.吸引人的标题 2.正文100-200字，口语化 3.配3-5个合适的话题标签 4.在正文中标注【配图1】【配图2】【配图3】，说明每张配图应该展示什么。",
    },
    {
      id: "image_prompts",
      name: "提炼图片提示词",
      category: "copywriting",
      requiresUserConfirm: false,
      inputFrom: "copywriting",
      description: "从文案中提取 3 张配图的画面描述",
      estimatedSeconds: 8,
      promptTemplate: "根据以下文案，提取3张配图的画面描述。每张一行，直接输出简短的画面描述（适合 AI 绘图），不要编号不要解释：\n\n{input}",
    },
    {
      id: "generate_images",
      name: "生成配图（3张）",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "image_prompts",
      description: "根据提示词生成 3 张配图",
      estimatedSeconds: 90,
    },
    {
      id: "compose",
      name: "组合排版",
      category: "editing",
      requiresUserConfirm: false,
      inputFrom: "generate_images",
      description: "将文案和图片组合，整理到输出文件夹",
      optional: true,
      estimatedSeconds: 5,
    },
  ],
};

// ─── 漫剧/动画 ───

const comicDrama: PipelineTemplate = {
  id: "comic_drama",
  name: "漫剧 / 动画短片",
  description: "剧本分镜 → 角色定妆照 → 画面风格确认 → 逐镜头图片 → 图生视频 → 配音字幕",
  estimatedMinutes: 20,
  keywords: ["漫剧", "动画", "动漫", "分镜", "角色", "短片", "故事", "剧情"],
  steps: [
    {
      id: "screenplay",
      name: "剧本 + 分镜",
      category: "copywriting",
      requiresUserConfirm: true,
      description: "生成剧本大纲和 4-8 个分镜头描述",
      estimatedSeconds: 15,
      promptTemplate: "请为「{topic}」写一个 30 秒动画短片的剧本。输出格式：\n\n【剧本概要】一句话概要\n【角色】列出主要角色及外观描述\n【分镜】\n镜头1：（画面描述）（台词/旁白）\n镜头2：…\n共 4-6 个镜头。画面描述要详细到能直接用于 AI 绘图。",
    },
    {
      id: "character_design",
      name: "角色定妆照",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "screenplay",
      description: "生成主要角色的定妆照，确认角色外观",
      estimatedSeconds: 60,
    },
    {
      id: "style_confirm",
      name: "确认画面风格",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "character_design",
      description: "生成第一个镜头的样图，确认画面风格和色调",
      estimatedSeconds: 45,
    },
    {
      id: "scene_images",
      name: "逐镜头生成画面",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "style_confirm",
      description: "按分镜描述逐个生成镜头画面，保持角色和风格一致",
      estimatedSeconds: 180,
    },
    {
      id: "image_to_video",
      name: "图生视频",
      category: "video",
      requiresUserConfirm: true,
      inputFrom: "scene_images",
      description: "将每个镜头的静态图片转为动态视频片段",
      estimatedSeconds: 300,
    },
    {
      id: "voiceover_subtitle",
      name: "配音 + 字幕",
      category: "voice",
      requiresUserConfirm: false,
      inputFrom: "screenplay",
      description: "根据台词生成配音音频，自动生成字幕",
      estimatedSeconds: 30,
    },
    {
      id: "final_edit",
      name: "剪辑合成",
      category: "editing",
      requiresUserConfirm: false,
      inputFrom: "image_to_video",
      description: "将视频片段、配音、字幕合成为成品",
      optional: true,
      estimatedSeconds: 60,
    },
  ],
};

// ─── 广告/产品视频 ───

const advertisement: PipelineTemplate = {
  id: "advertisement",
  name: "广告 / 产品视频",
  description: "产品分析 → 广告脚本 → 视觉分镜 → 素材生成 → 视频合成 → 多尺寸导出",
  estimatedMinutes: 15,
  keywords: ["广告", "产品", "宣传", "推广", "营销", "卖货", "带货", "商品"],
  steps: [
    {
      id: "product_script",
      name: "产品分析 + 广告脚本",
      category: "copywriting",
      requiresUserConfirm: true,
      description: "分析产品卖点，生成广告脚本和分镜",
      estimatedSeconds: 15,
      promptTemplate: "请为「{topic}」写一段 15-30 秒的产品广告视频脚本。包含：\n1.【产品卖点】3个核心卖点\n2.【广告脚本】开头（痛点/场景引入）→ 中间（产品展示+卖点）→ 结尾（促销信息+行动号召）\n3.【分镜描述】3-5个镜头的画面描述（适合 AI 绘图）\n4.【配乐风格】建议的背景音乐风格",
    },
    {
      id: "visual_storyboard",
      name: "视觉分镜图",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "product_script",
      description: "根据分镜描述生成视觉分镜图",
      estimatedSeconds: 90,
    },
    {
      id: "material_gen",
      name: "素材生成",
      category: "image",
      requiresUserConfirm: true,
      inputFrom: "visual_storyboard",
      description: "生成产品展示图、场景图等视频素材",
      estimatedSeconds: 120,
    },
    {
      id: "video_synthesis",
      name: "视频合成",
      category: "video",
      requiresUserConfirm: true,
      inputFrom: "material_gen",
      description: "将素材图片转为动态视频",
      estimatedSeconds: 180,
    },
    {
      id: "multi_export",
      name: "多尺寸导出",
      category: "editing",
      requiresUserConfirm: false,
      inputFrom: "video_synthesis",
      description: "导出竖版(9:16)、横版(16:9)、方形(1:1) 三种尺寸",
      optional: true,
      estimatedSeconds: 30,
    },
  ],
};

// ─── 模板注册表 ───

const ALL_TEMPLATES: PipelineTemplate[] = [talkingHead, imageTextPost, comicDrama, advertisement];

export function getTemplateById(id: string): PipelineTemplate | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id);
}

export function getAllTemplates(): PipelineTemplate[] {
  return [...ALL_TEMPLATES];
}

/**
 * 从用户输入中匹配最合适的模板
 */
export function matchTemplate(input: string): PipelineTemplate | null {
  const lower = input.toLowerCase();
  let bestMatch: PipelineTemplate | null = null;
  let bestScore = 0;

  for (const tmpl of ALL_TEMPLATES) {
    let score = 0;
    for (const kw of tmpl.keywords) {
      if (lower.includes(kw)) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = tmpl;
    }
  }

  return bestMatch;
}

/**
 * 格式化模板列表供用户选择
 */
export function formatTemplateChoices(): string {
  return ALL_TEMPLATES.map((t, i) =>
    `  ${i + 1}. ${t.name} — ${t.description}（约 ${t.estimatedMinutes} 分钟）`
  ).join("\n");
}

export function getTemplateByIndex(index: number): PipelineTemplate | undefined {
  return ALL_TEMPLATES[index];
}
