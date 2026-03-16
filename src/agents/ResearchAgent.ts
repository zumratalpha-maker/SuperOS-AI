/**
 * 思维链研究模块：对未知/复杂任务进行“Best way to [task]”检索，由 LLM 总结出最优操作路径
 */

import OpenAI from "openai";
import type { Browser, Page } from "puppeteer";

export type SuggestedApproach = "cli" | "web_script" | "powershell" | "batch" | "open_app" | "mirror_download" | "script_scrape" | "unknown";

export type ResearchResult = {
  summary: string;
  suggestedApproach: SuggestedApproach;
  toolName?: string;
  toolDownloadUrl?: string;
  scriptSnippet?: string;
  reasoning: string;
  needsUserConsent?: boolean;
};

const SEARCH_QUERY_TEMPLATE = "Best way to {task} via CLI Node.js Windows";
const NAV_TIMEOUT_MS = 12000;
const SNIPPET_MAX_LEN = 12000;

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance) return browserInstance;
  const puppeteer = await import("puppeteer");
  browserInstance = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browserInstance;
}

/** 用搜索引擎检索并返回前几条结果的文本摘要 */
async function searchAndCollectSnippets(task: string): Promise<string> {
  const query = SEARCH_QUERY_TEMPLATE.replace("{task}", task);
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const snippets: string[] = [];

  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2000));

    const text = await page.evaluate(() => {
      const items = document.querySelectorAll("li.b_algo h2 a, .b_caption p");
      return Array.from(items)
        .map((el) => (el as HTMLElement).innerText?.trim())
        .filter(Boolean)
        .join("\n");
    });
    if (text) snippets.push(text.slice(0, 8000));

    const links = await page.$$eval("li.b_algo h2 a", (as) =>
      (as as HTMLAnchorElement[]).map((a) => a.href).filter((h) => h.startsWith("http")).slice(0, 3)
    );
    for (const href of links) {
      try {
        await page.goto(href, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 1000));
        const body = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "");
        if (body) snippets.push(body);
      } catch (_) {
        // skip failed page
      }
    }
  } catch (e) {
    console.error("[ResearchAgent] search error:", e);
  } finally {
    if (page) await page.close().catch(() => null);
  }

  const combined = snippets.join("\n\n").slice(0, SNIPPET_MAX_LEN);
  return combined || "No search results available.";
}

/** 调用 LLM 对检索内容进行总结，提取最优操作路径 */
async function summarizeWithLLM(task: string, searchContent: string): Promise<ResearchResult> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const rawURL = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1").trim();
  const baseURL = rawURL.replace(/localhost/gi, "127.0.0.1");
  const model = process.env.OPENAI_MODEL ?? "llama3.2";

  const systemPrompt = `You are a research assistant. Given a user task and search results about "Best way to do X via CLI/Node.js/Windows", output a JSON object with:
- summary: one paragraph summary of the best approach
- suggestedApproach: one of "cli" | "web_script" | "powershell" | "batch" | "open_app" | "mirror_download" | "script_scrape" | "unknown"
- toolName: if CLI tool is recommended (e.g. aria2, ffmpeg, yt-dlp), its name
- toolDownloadUrl: official download URL for that tool (Windows), if known from search results
- scriptSnippet: if a small script or command is the solution, the exact snippet (single line or few lines)
- reasoning: why this approach
- needsUserConsent: true only if the solution requires payment, QR code, or sensitive privacy

Output only valid JSON, no markdown.`;

  const userContent = `Task: ${task}\n\nSearch results:\n${searchContent.slice(0, 10000)}`;

  try {
    const client = new OpenAI({ apiKey: apiKey || "ollama", baseURL });
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: 512,
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const jsonStr = raw.replace(/```\w*\n?/g, "").trim();
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      summary: String(parsed.summary ?? ""),
      suggestedApproach: (parsed.suggestedApproach as SuggestedApproach) ?? "unknown",
      toolName: parsed.toolName != null ? String(parsed.toolName) : undefined,
      toolDownloadUrl: parsed.toolDownloadUrl != null ? String(parsed.toolDownloadUrl) : undefined,
      scriptSnippet: parsed.scriptSnippet != null ? String(parsed.scriptSnippet) : undefined,
      reasoning: String(parsed.reasoning ?? ""),
      needsUserConsent: Boolean(parsed.needsUserConsent),
    };
  } catch (e) {
    console.error("[ResearchAgent] LLM summarize error:", e);
    return {
      summary: "",
      suggestedApproach: "unknown",
      reasoning: "LLM parse failed",
    };
  }
}

/**
 * 对给定任务启动后台检索并返回最优操作路径（思维链）
 */
export async function research(task: string): Promise<ResearchResult> {
  console.log("[ResearchAgent] 研究任务:", task);
  const searchContent = await searchAndCollectSnippets(task);
  const result = await summarizeWithLLM(task, searchContent);
  console.log("[ResearchAgent] 建议:", result.suggestedApproach, result.toolName ?? "", result.reasoning?.slice(0, 80));
  return result;
}

export async function closeResearchBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => null);
    browserInstance = null;
  }
}
