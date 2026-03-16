/**
 * 全能资源猎人：动态搜索引擎 + 启发式识别真实链接 vs 虚假广告 + 元数据（体积/活跃度）
 * 基于 Puppeteer，不写死目标站，先搜再进结果页提取 magnet / .torrent
 */

import type { Browser, Page } from "puppeteer";

export type HuntResult = {
  index: number;
  name: string;
  qualityOrSize: string;
  safetyScore: number;
  source: string;
  url: string;
};

const SEARCH_ENGINES = [
  { name: "DuckDuckGo", url: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { name: "Bing", url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
];

const MAX_RESULT_PAGES_TO_VISIT = 5;
const PAGE_TIMEOUT_MS = 15000;
const NAV_TIMEOUT_MS = 12000;

/** 文档/资料类直接下载扩展名 */
const DOCUMENT_EXT = [".pdf", ".doc", ".docx", ".zip", ".rar", ".7z", ".epub"];

/** 云盘/分享页域名（百度网盘、夸克等） */
const CLOUD_HOSTS = ["pan.baidu.com", "baidu.com/s?", "quark.cn", "lanzou", "lanzoui", "aliyundrive", "123pan"];

/** 真实链接：magnet / .torrent / 文档直链 / 云盘链接；虚假常见域名/按钮特征 */
function isRealResourceUrl(href: string): boolean {
  const h = href.trim().toLowerCase();
  if (h.startsWith("magnet:?xt=")) return true;
  if (h.endsWith(".torrent")) return true;
  if (DOCUMENT_EXT.some((ext) => h.endsWith(ext) || h.includes(ext + "?"))) return true;
  if (CLOUD_HOSTS.some((host) => h.includes(host))) return true;
  return false;
}

function isLikelyFakeUrl(href: string): boolean {
  const h = href.toLowerCase();
  const fakePatterns = [
    /doubleclick|googlesyndication|googleadservices|ad\.|ads?\.|tracking|click\.|redirect/,
    /\/ad\//,
    /^#/,
  ];
  return fakePatterns.some((p) => p.test(h));
}

/** 从页面文本提取体积（如 2.5 GB、10GB）和 Seeds/Peers */
function parseMetadataFromText(text: string): { size?: string; seeds?: number; peers?: number } {
  const out: { size?: string; seeds?: number; peers?: number } = {};
  const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:GB|G|GiB|MB|M|MiB)/i);
  if (sizeMatch) out.size = sizeMatch[0].trim();
  const seedsMatch = text.match(/seed[s]?[:\s]*(\d+)/i);
  if (seedsMatch) out.seeds = parseInt(seedsMatch[1], 10);
  const peersMatch = text.match(/peer[s]?[:\s]*(\d+)/i);
  if (peersMatch) out.peers = parseInt(peersMatch[1], 10);
  return out;
}

/** 安全评分 0–100：真实链接 + 有体积/种子数则加分；文档直链给基础分 */
function safetyScore(url: string, meta: { size?: string; seeds?: number }): number {
  const h = url.trim().toLowerCase();
  let s = 50;
  if (h.startsWith("magnet:?xt=")) s += 25;
  else if (h.endsWith(".torrent")) s += 25;
  else if (DOCUMENT_EXT.some((ext) => h.endsWith(ext) || h.includes(ext + "?"))) s += 15;
  else if (CLOUD_HOSTS.some((host) => h.includes(host))) s += 15;
  if (isLikelyFakeUrl(url)) s -= 40;
  if (meta.size) s += 10;
  if (meta.seeds !== undefined && meta.seeds > 0) s += Math.min(15, meta.seeds);
  return Math.max(0, Math.min(100, s));
}

/** 从页面提取所有 magnet 和 .torrent 链接及周围文本用于命名/元数据 */
async function extractResourceLinks(page: Page): Promise<Array<{ url: string; name: string; meta: ReturnType<typeof parseMetadataFromText> }>> {
  const results: Array<{ url: string; name: string; meta: ReturnType<typeof parseMetadataFromText> }> = [];
  try {
    const content = await page.content();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    const meta = parseMetadataFromText(bodyText);

    const hrefs = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      return links.map((a) => ({ href: a.href, text: (a.textContent ?? "").trim() }));
    });

    const seen = new Set<string>();
    for (const { href, text } of hrefs) {
      if (!href || !isRealResourceUrl(href) || seen.has(href)) continue;
      seen.add(href);
      const name = text && text.length < 120 ? text : href.split("/").pop() ?? href.slice(0, 60);
      results.push({
        url: href,
        name: name.replace(/\s+/g, " ").trim() || "未命名",
        meta: Object.keys(meta).length ? meta : parseMetadataFromText(content.slice(0, 8000)),
      });
    }

    const magnetRegex = /magnet:\?[^\s"'<>]+/gi;
    const torrentRegex = /https?:\/\/[^\s"'<>]+\.torrent/gi;
    const docRegex = new RegExp(`https?://[^\\s"'<>]+\\.(${DOCUMENT_EXT.map((e) => e.slice(1)).join("|")})(?:\\?[^\\s"'<>]*)?`, "gi");
    const fullText = content;
    for (const m of fullText.matchAll(magnetRegex)) {
      const url = m[0].replace(/["'<>]/g, "").trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        results.push({ url, name: "Magnet 链接", meta: parseMetadataFromText(bodyText) });
      }
    }
    for (const m of fullText.matchAll(torrentRegex)) {
      const url = m[0].replace(/["'<>]/g, "").trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        results.push({ url, name: "Torrent 文件", meta: parseMetadataFromText(bodyText) });
      }
    }
    for (const m of fullText.matchAll(docRegex)) {
      const url = m[0].replace(/["'<>]/g, "").trim();
      if (url && !seen.has(url) && !isLikelyFakeUrl(url)) {
        seen.add(url);
        const fileName = url.split("/").pop()?.split("?")[0] ?? "文档";
        results.push({ url, name: fileName.length < 80 ? fileName : "文档链接", meta: parseMetadataFromText(bodyText) });
      }
    }
    const cloudRegex = /https?:\/\/[^\s"'<>]*(?:pan\.baidu\.com|quark\.cn|aliyundrive|123pan|lanzou[^\s"'<>]*)[^\s"'<>]*/gi;
    for (const m of fullText.matchAll(cloudRegex)) {
      const url = m[0].replace(/["'<>]/g, "").trim();
      if (url && !seen.has(url) && !isLikelyFakeUrl(url)) {
        seen.add(url);
        const label = url.includes("pan.baidu") ? "百度网盘" : url.includes("quark.cn") ? "夸克网盘" : "网盘链接";
        results.push({ url, name: label, meta: parseMetadataFromText(bodyText) });
      }
    }
  } catch (e) {
    console.error("[ResourceHunter] extractResourceLinks:", e);
  }
  return results;
}

/** 获取搜索引擎结果页上的目标链接（不直接是 magnet 的落地页） */
async function getSearchResultLinks(page: Page, engine: string): Promise<string[]> {
  const links: string[] = [];
  try {
    if (engine === "DuckDuckGo") {
      const sel = 'a[data-testid="result-title-a"], a.result__a';
      await page.waitForSelector(sel, { timeout: 8000 }).catch(() => null);
      const hrefs = await page.$$eval(sel, (as) => (as as HTMLAnchorElement[]).map((a) => a.href));
      links.push(...hrefs.filter((h) => h && !h.includes("duckduckgo.com") && !isLikelyFakeUrl(h)));
    }
    if (engine === "Bing") {
      const sel = "a[href^='http']";
      await page.waitForSelector("ol#b_results", { timeout: 8000 }).catch(() => null);
      const hrefs = await page.$$eval(
        "ol#b_results li.b_algo a[href]",
        (as) => (as as HTMLAnchorElement[]).map((a) => a.href).filter((h) => h.startsWith("http"))
      );
      links.push(...hrefs.filter((h) => !h.includes("bing.com") && !isLikelyFakeUrl(h)));
    }
  } catch (e) {
    console.error("[ResourceHunter] getSearchResultLinks:", e);
  }
  return [...new Set(links)].slice(0, 15);
}

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

/** 是否属于“资料/文档”类检索（不加 torrent/magnet，改用 下载/网盘） */
function isDocumentStyleQuery(keywords: string, qualityOrType?: string): boolean {
  const t = (keywords + " " + (qualityOrType ?? "")).toLowerCase();
  return /资料|文档|教材|真题|讲义|PDF|实用|好评|下载/.test(t);
}

/**
 * 执行资源搜索：搜索引擎检索 → 进入结果页 → 提取 magnet/.torrent/文档直链/云盘链接 → 元数据与安全评分
 * 资料/文档类：不加 torrent magnet，改用 下载、网盘、蓝奏云；并识别 pan.baidu.com、quark.cn 等链接
 */
export async function huntResources(params: {
  keywords: string;
  qualityOrType?: string;
}): Promise<HuntResult[]> {
  const { keywords, qualityOrType } = params;
  const queries: string[] = [];
  const isDoc = isDocumentStyleQuery(keywords, qualityOrType);

  if (isDoc) {
    queries.push(qualityOrType ? `${keywords} ${qualityOrType} 下载` : `${keywords} 下载`);
    queries.push(`${keywords} 资料 下载`);
    queries.push(`${keywords} 网盘`);
    queries.push(`${keywords} 蓝奏云`);
  } else {
    queries.push(qualityOrType ? `${keywords} ${qualityOrType} torrent magnet` : `${keywords} torrent magnet`);
    queries.push(`${keywords} 网盘`);
  }

  const all: Array<{ url: string; name: string; meta: ReturnType<typeof parseMetadataFromText>; source: string }> = [];

  const browser = await getBrowser();

  for (const engine of SEARCH_ENGINES) {
    for (const query of queries) {
      let page: Page | null = null;
      try {
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        await page.setDefaultTimeout(PAGE_TIMEOUT_MS);
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        const searchUrl = engine.url(query);
        await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 1500));

        const directLinks = await extractResourceLinks(page);
        for (const d of directLinks) {
          all.push({ ...d, source: engine.name + "(搜索页)" });
        }

        const resultLinks = await getSearchResultLinks(page, engine.name);
        for (let i = 0; i < Math.min(MAX_RESULT_PAGES_TO_VISIT, resultLinks.length); i++) {
          try {
            const targetUrl = resultLinks[i];
            await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
            await new Promise((r) => setTimeout(r, 1000));
            const items = await extractResourceLinks(page);
            for (const item of items) {
              all.push({ ...item, source: new URL(targetUrl).hostname });
            }
          } catch (_) {
            // skip failed page
          }
        }
        await page.close();
        page = null;
      } catch (e) {
        console.error("[ResourceHunter] engine " + engine.name + " query:", query, e);
        if (page) await page.close().catch(() => null);
      }
    }
  }

  const seenUrls = new Set<string>();
  const deduped: typeof all = [];
  for (const a of all) {
    const norm = a.url.trim();
    if (seenUrls.has(norm)) continue;
    if (!isRealResourceUrl(norm) || isLikelyFakeUrl(norm)) continue;
    seenUrls.add(norm);
    deduped.push(a);
  }

  return deduped.slice(0, 20).map((d, i) => ({
    index: i + 1,
    name: d.name.slice(0, 60),
    qualityOrSize: d.meta.size ?? (d.meta.seeds != null ? `Seeds:${d.meta.seeds}` : "-"),
    safetyScore: safetyScore(d.url, d.meta),
    source: d.source,
    url: d.url,
  }));
}

/** 关闭浏览器（可选，用于进程退出时） */
export async function closeResourceHunterBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => null);
    browserInstance = null;
  }
}
