/**
 * 全网自学引擎 — SuperOS 的"学习大脑"
 *
 * 流程：
 * 1. 收到一个系统不知道怎么做的任务
 * 2. LLM 生成多组搜索关键词
 * 3. Bing 搜索 + 打开前 N 个结果页面抓取内容
 * 4. LLM 从网页内容中提取结构化技巧
 * 5. 通过安全检查后存入技能库
 * 6. 返回新学到的技能供立即执行
 *
 * 复用 ResearchAgent.ts 的搜索能力，但输出不同：
 * ResearchAgent 输出 ResearchResult（建议做法），
 * skillLearner 输出 Skill（结构化的可执行技能，永久存储）。
 */

import { addSkill, findSkills, type Skill, type SkillStep, type SkillType } from "./skillLibrary.js";
import { checkSafety } from "./safetyGuard.js";
import { CLOUD_LLM } from "../config/llmConfig.js";

// ─── 搜索 ───

interface SearchSnippet {
  title: string;
  url: string;
  content: string;
}

/**
 * 用 LLM 生成搜索关键词
 */
async function generateSearchQueries(task: string): Promise<string[]> {
  const apiKey = CLOUD_LLM.apiKey;
  if (!apiKey || apiKey === "ollama") {
    return [
      `${task} 教程 方法`,
      `${task} 怎么做 Windows`,
      `how to ${task} tutorial`,
    ];
  }

  try {
    const resp = await fetch(`${CLOUD_LLM.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CLOUD_LLM.model,
        messages: [
          {
            role: "system",
            content: "你是搜索专家。根据用户任务生成 3-5 个搜索关键词组合，用于在 Bing 上搜索教程和方法。每行一个搜索词，不要编号不要解释。优先中文关键词，也包含一个英文关键词。",
          },
          { role: "user", content: `任务：${task}` },
        ],
        temperature: 0.7,
        max_tokens: 200,
      }),
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const queries = text
      .split("\n")
      .map((l) => l.replace(/^\d+[.、)]\s*/, "").trim())
      .filter((l) => l.length > 2);
    return queries.length > 0 ? queries.slice(0, 5) : [`${task} 教程`];
  } catch (e) {
    console.warn("[skillLearner] 生成搜索词失败:", (e as Error).message);
    return [`${task} 教程 方法`, `how to ${task}`];
  }
}

/**
 * Bing 搜索并抓取前几个结果页内容
 */
async function searchAndScrape(query: string, maxPages = 3): Promise<SearchSnippet[]> {
  const snippets: SearchSnippet[] = [];

  try {
    const puppeteer = await import("puppeteer");
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(12000);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2000));

    const results = await page.evaluate(() => {
      const items = document.querySelectorAll("li.b_algo");
      return Array.from(items).slice(0, 5).map((item) => {
        const a = item.querySelector("h2 a") as HTMLAnchorElement | null;
        const p = item.querySelector(".b_caption p") as HTMLElement | null;
        return {
          title: a?.innerText?.trim() ?? "",
          url: a?.href ?? "",
          snippet: p?.innerText?.trim() ?? "",
        };
      }).filter((r) => r.url.startsWith("http"));
    });

    for (const r of results.slice(0, maxPages)) {
      try {
        await page.goto(r.url, { waitUntil: "domcontentloaded" });
        await new Promise((res) => setTimeout(res, 1500));
        const bodyText = await page.evaluate(() => {
          const main = document.querySelector("main, article, .content, .post-content, #content");
          return (main as HTMLElement)?.innerText?.slice(0, 6000) ?? document.body?.innerText?.slice(0, 4000) ?? "";
        });
        snippets.push({ title: r.title, url: r.url, content: bodyText });
      } catch {
        if (r.snippet) {
          snippets.push({ title: r.title, url: r.url, content: r.snippet });
        }
      }
    }

    await browser.close();
  } catch (e) {
    console.error("[skillLearner] 搜索抓取失败:", (e as Error).message);
  }

  return snippets;
}

// ─── LLM 提取技能 ───

interface ExtractedSkill {
  name: string;
  type: SkillType;
  taskPattern: string;
  tags: string[];
  description: string;
  steps: SkillStep[];
  confidence: number;
}

async function extractSkillsFromContent(
  task: string,
  snippets: SearchSnippet[],
): Promise<ExtractedSkill[]> {
  const apiKey = CLOUD_LLM.apiKey;
  if (!apiKey || apiKey === "ollama") {
    console.warn("[skillLearner] 无云端 LLM Key，无法提取技能");
    return [];
  }

  const combinedContent = snippets
    .map((s) => `【来源: ${s.title}】\n${s.url}\n${s.content.slice(0, 3000)}`)
    .join("\n\n---\n\n")
    .slice(0, 12000);

  const systemPrompt = `你是一个技能提取专家。从网页搜索结果中提取可自动执行的技巧和方法。

输出 JSON 数组，每个元素是一个技能：
[{
  "name": "技能名称（简短）",
  "type": "url_transform" | "shell_command" | "multi_step" | "api_call" | "tool_usage" | "knowledge",
  "taskPattern": "这个技能适用的任务描述关键词",
  "tags": ["标签1", "标签2"],
  "description": "详细说明这个技巧怎么用",
  "steps": [
    {"action": "动作类型", "params": {"参数": "值"}, "description": "说明"}
  ],
  "confidence": 0.1到1.0（来源可靠性评分）
}]

步骤的 action 类型包括：
- "url_replace": params: {from, to} — URL 替换
- "shell": params: {command, args?} — 执行命令
- "puppeteer_goto": params: {url} — 打开网页
- "puppeteer_click": params: {text} — 点击按钮
- "puppeteer_type": params: {placeholder, text} — 输入文本
- "download": params: {url_pattern} — 下载文件
- "install_tool": params: {name, install_command} — 安装工具
- "note": params: {text} — 纯知识备注

rules:
1. 只提取确实可操作的技巧，不提取模糊建议
2. type=knowledge 用于纯知识型（不可直接执行的信息）
3. confidence 根据来源可信度评分：知名网站 0.8，个人博客 0.5，论坛 0.3
4. 步骤参数中避免硬编码用户个人信息
5. 只输出 JSON，不要其他文字`;

  try {
    const resp = await fetch(`${CLOUD_LLM.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CLOUD_LLM.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `任务: ${task}\n\n搜索结果:\n${combinedContent}` },
        ],
        temperature: 0.3,
        max_tokens: 3000,
      }),
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const jsonStr = raw.replace(/```\w*\n?/g, "").replace(/```$/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s: Record<string, unknown>) =>
        s.name && s.type && s.steps && Array.isArray(s.steps),
    ) as ExtractedSkill[];
  } catch (e) {
    console.error("[skillLearner] LLM 提取技能失败:", (e as Error).message);
    return [];
  }
}

// ─── 安全校验 ───

function safetyCheckSkill(skill: ExtractedSkill): { safe: boolean; reason?: string } {
  const fullText = skill.description + " " + JSON.stringify(skill.steps);
  const check = checkSafety(fullText);

  if (check.level === "blocked") {
    return { safe: false, reason: `安全拦截：${check.reason}` };
  }

  for (const step of skill.steps) {
    if (step.action === "shell" && step.params.command) {
      const cmdCheck = checkSafety(String(step.params.command));
      if (cmdCheck.level === "blocked") {
        return { safe: false, reason: `命令不安全：${step.params.command}` };
      }
    }
  }

  return { safe: true };
}

// ─── 主函数 ───

export interface LearnResult {
  task: string;
  queriesSearched: number;
  pagesScraped: number;
  skillsExtracted: number;
  skillsSaved: number;
  skillsRejected: number;
  savedSkills: Skill[];
  errors: string[];
}

/**
 * 全网自学：搜索教程 → 提取技巧 → 安全检查 → 存入技能库
 */
export async function learnFromWeb(task: string): Promise<LearnResult> {
  console.log("[skillLearner] 开始自学:", task);

  const result: LearnResult = {
    task,
    queriesSearched: 0,
    pagesScraped: 0,
    skillsExtracted: 0,
    skillsSaved: 0,
    skillsRejected: 0,
    savedSkills: [],
    errors: [],
  };

  const existingSkills = findSkills(task, 3);
  if (existingSkills.length > 0 && existingSkills[0].confidence > 0.7) {
    console.log("[skillLearner] 技能库已有高可信度技能，跳过自学:", existingSkills[0].name);
    result.savedSkills = existingSkills;
    return result;
  }

  const queries = await generateSearchQueries(task);
  result.queriesSearched = queries.length;
  console.log("[skillLearner] 搜索关键词:", queries);

  const allSnippets: SearchSnippet[] = [];
  for (const q of queries.slice(0, 3)) {
    const snippets = await searchAndScrape(q, 2);
    allSnippets.push(...snippets);
    result.pagesScraped += snippets.length;
  }

  if (allSnippets.length === 0) {
    result.errors.push("搜索未返回任何结果");
    console.warn("[skillLearner] 搜索无结果");
    return result;
  }

  console.log("[skillLearner] 共抓取", allSnippets.length, "个页面，开始 LLM 提取技能…");

  const extracted = await extractSkillsFromContent(task, allSnippets);
  result.skillsExtracted = extracted.length;

  if (extracted.length === 0) {
    result.errors.push("LLM 未能提取出可用技能");
    return result;
  }

  for (const ex of extracted) {
    const safety = safetyCheckSkill(ex);
    if (!safety.safe) {
      result.skillsRejected++;
      result.errors.push(`技能「${ex.name}」被安全拦截: ${safety.reason}`);
      console.warn("[skillLearner] 安全拦截:", ex.name, safety.reason);
      continue;
    }

    try {
      const sourceUrl = allSnippets.find((s) => s.content.length > 100)?.url;
      const saved = addSkill({
        name: ex.name,
        type: ex.type,
        taskPattern: ex.taskPattern,
        tags: ex.tags,
        description: ex.description,
        steps: ex.steps,
        source: "web_learn",
        sourceUrl,
        confidence: Math.min(ex.confidence, 0.8),
      });
      result.savedSkills.push(saved);
      result.skillsSaved++;
      console.log("[skillLearner] 新技能存入:", saved.name, "置信度:", saved.confidence);
    } catch (e) {
      result.errors.push(`存储技能「${ex.name}」失败: ${(e as Error).message}`);
    }
  }

  console.log(
    `[skillLearner] 自学完成: 搜索${result.queriesSearched}次, 抓取${result.pagesScraped}页, 提取${result.skillsExtracted}个, 存入${result.skillsSaved}个, 拒绝${result.skillsRejected}个`
  );

  return result;
}

/**
 * 快速查找或学习：先查技能库，没有就自学
 */
export async function findOrLearn(task: string): Promise<Skill[]> {
  const existing = findSkills(task, 5);
  if (existing.length > 0) {
    console.log("[skillLearner] 技能库命中:", existing.map((s) => s.name).join(", "));
    return existing;
  }

  console.log("[skillLearner] 技能库未命中，启动自学…");
  const result = await learnFromWeb(task);
  return result.savedSkills;
}
