/**
 * 浏览器桥接层：Puppeteer 控制网页应用
 * 解决 UIA/OCR 对网页应用（通义万相、豆包、可灵、即梦、Gemini）不稳定的根本问题
 * 通过 CDP 协议直接操控浏览器 DOM，不依赖 UIA 树或 OCR 截图
 */

import puppeteer, { type Browser, type Page, type ElementHandle } from "puppeteer";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";

let browserInstance: Browser | null = null;

const DEFAULT_TIMEOUT = 30_000;
const NAV_TIMEOUT = 60_000;

/** 统一下载根目录 */
function getOutputRoot(): string {
  return process.env.SUPEROS_OUTPUT_DIR || join(process.cwd(), "output");
}

export function getImageOutputDir(): string { return join(getOutputRoot(), "images"); }
export function getVideoOutputDir(): string { return join(getOutputRoot(), "videos"); }

/** Puppeteer 错误分类 */
export type BrowserErrorKind = "login_required" | "timeout" | "element_not_found" | "network" | "unknown";

function classifyError(e: unknown): BrowserErrorKind {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes("login") || msg.includes("登录") || msg.includes("sign in")) return "login_required";
  if (msg.includes("timeout") || msg.includes("超时")) return "timeout";
  if (msg.includes("no node found") || msg.includes("waiting for selector") || msg.includes("未找到")) return "element_not_found";
  if (msg.includes("net::err_") || msg.includes("network") || msg.includes("failed to fetch")) return "network";
  return "unknown";
}

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const executablePath = findChromePath();
  const userDataDir = findChromeUserDataDir();
  browserInstance = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    ...(executablePath ? { executablePath } : {}),
    ...(userDataDir ? { userDataDir } : {}),
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--excludeSwitches=enable-automation",
    ],
  });
  return browserInstance;
}

/**
 * 查找用户的 Chrome 用户数据目录，复用已有登录态
 * 如果用户的 Chrome 正在运行，使用一个副本 profile 避免冲突
 */
function findChromeUserDataDir(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const defaultDir = join(localAppData, "Google", "Chrome", "User Data");
  if (!existsSync(defaultDir)) return undefined;

  const superosChromeDir = join(process.cwd(), "data", "chrome-profile");
  if (!existsSync(superosChromeDir)) {
    try {
      mkdirSync(superosChromeDir, { recursive: true });
    } catch { return undefined; }
  }

  const lockFile = join(defaultDir, "lockfile");
  const singletonLock = join(defaultDir, "SingletonLock");
  const chromeRunning = existsSync(lockFile) || existsSync(singletonLock);

  if (chromeRunning) {
    console.log("[browserBridge] Chrome 正在运行，使用 SuperOS 专用 profile（首次会复制 Cookies）");
    copyChromeLoginData(defaultDir, superosChromeDir);
    return superosChromeDir;
  }

  console.log("[browserBridge] 使用用户 Chrome 原始 profile（保留所有登录态）");
  return defaultDir;
}

function copyChromeLoginData(srcDir: string, destDir: string): void {
  const defaultProfile = join(srcDir, "Default");
  const destProfile = join(destDir, "Default");

  try {
    if (!existsSync(destProfile)) mkdirSync(destProfile, { recursive: true });

    const filesToCopy = ["Cookies", "Login Data", "Web Data", "Preferences", "Secure Preferences"];
    for (const file of filesToCopy) {
      const src = join(defaultProfile, file);
      const dest = join(destProfile, file);
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
      }
    }

    const localState = join(srcDir, "Local State");
    const destLocalState = join(destDir, "Local State");
    if (existsSync(localState) && !existsSync(destLocalState)) {
      copyFileSync(localState, destLocalState);
    }
  } catch (e) {
    console.warn("[browserBridge] 复制 Chrome 登录数据失败:", (e as Error).message);
  }
}

/** 尝试使用系统已安装的 Chrome，避免下载 Chromium */
function findChromePath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance && browserInstance.connected) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

async function newPage(url: string): Promise<Page> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.goto(url, { waitUntil: "networkidle2" });
  return page;
}

/**
 * 登录状态检测：检查页面是否存在登录提示
 * 返回 true 表示需要登录（将暂停等用户手动登录）
 */
async function checkLoginRequired(page: Page): Promise<boolean> {
  const loginKeywords = ["登录", "Log in", "Sign in", "请登录", "注册/登录", "Login"];
  try {
    const found = await page.evaluate((keywords: string[]) => {
      const body = document.body.innerText;
      const btns = document.querySelectorAll("button, a, [role='button']");
      for (const kw of keywords) {
        for (const btn of btns) {
          const txt = (btn as HTMLElement).innerText?.trim() ?? "";
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && txt === kw) return true;
        }
      }
      const loginForms = document.querySelectorAll("form[class*='login'], form[class*='Login'], [class*='login-modal']");
      if (loginForms.length > 0) return true;
      return false;
    }, loginKeywords);
    return found;
  } catch {
    return false;
  }
}

/**
 * 等待用户登录：检测到登录页面后，轮询等待直到登录完成或超时
 */
async function waitForUserLogin(page: Page, timeoutMs = 120_000): Promise<boolean> {
  const needLogin = await checkLoginRequired(page);
  if (!needLogin) return true;

  console.log("[browserBridge] ⚠️  检测到需要登录，请在浏览器中手动完成登录...");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const still = await checkLoginRequired(page);
    if (!still) {
      console.log("[browserBridge] ✓ 登录检测通过");
      return true;
    }
  }
  console.error("[browserBridge] ✗ 登录超时，用户未完成登录");
  return false;
}

/** 智能等待：用 waitForSelector 或 waitForFunction 替代固定 setTimeout */
async function smartWait(
  page: Page,
  options: { selector?: string; text?: string; timeoutMs?: number },
): Promise<boolean> {
  const timeout = options.timeoutMs ?? 30_000;
  try {
    if (options.selector) {
      await page.waitForSelector(options.selector, { visible: true, timeout });
      return true;
    }
    if (options.text) {
      await page.waitForFunction(
        (t: string) => document.body.innerText.includes(t),
        { timeout },
        options.text,
      );
      return true;
    }
    await new Promise((r) => setTimeout(r, Math.min(timeout, 3000)));
    return true;
  } catch {
    return false;
  }
}

/** 等待生成完成：检测 loading 消失或结果出现 */
async function waitForGeneration(
  page: Page,
  options?: { resultSelector?: string; resultText?: string; timeoutMs?: number },
): Promise<boolean> {
  const timeout = options?.timeoutMs ?? 60_000;
  const start = Date.now();

  const loadingSelectors = [
    "[class*='loading']", "[class*='Loading']", "[class*='spinner']",
    "[class*='Spinner']", "[class*='progress']", "[class*='generating']",
  ];

  while (Date.now() - start < timeout) {
    const hasLoading = await page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
      }
      return false;
    }, loadingSelectors);

    if (!hasLoading) {
      if (options?.resultSelector) {
        const exists = await page.$(options.resultSelector);
        if (exists) return true;
      }
      if (options?.resultText) {
        const found = await waitForText(page, options.resultText, 2000);
        if (found) return true;
      }
      if (!options?.resultSelector && !options?.resultText) {
        await new Promise((r) => setTimeout(r, 2000));
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** 等待文本出现在页面中 */
async function waitForText(page: Page, text: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (t: string) => document.body.innerText.includes(t),
      { timeout: timeoutMs },
      text,
    );
    return true;
  } catch {
    return false;
  }
}

/** 点击包含指定文本的可见元素 */
async function clickByText(page: Page, text: string): Promise<boolean> {
  try {
    const el = await page.evaluateHandle((t: string) => {
      const all = document.querySelectorAll(
        "button, a, [role='button'], input[type='submit'], [class*='btn'], [class*='Button'], span, div",
      );
      for (const e of all) {
        const rect = e.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = (e as HTMLElement).innerText?.trim() ?? "";
        if (txt.includes(t)) return e;
        const placeholder = (e as HTMLInputElement).placeholder?.trim() ?? "";
        if (placeholder.includes(t)) return e;
        const ariaLabel = e.getAttribute("aria-label")?.trim() ?? "";
        if (ariaLabel.includes(t)) return e;
      }
      return null;
    }, text);
    if (!el) return false;
    const jsHandle = el.asElement() as ElementHandle<Element> | null;
    if (!jsHandle) return false;
    await jsHandle.click();
    return true;
  } catch {
    return false;
  }
}

/** 在输入框中输入文本（先清空再输入） */
async function typeInInput(page: Page, selector: string, text: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click({ clickCount: 3 });
    await el.type(text, { delay: 30 });
    return true;
  } catch {
    return false;
  }
}

/** 在包含 placeholder 的输入框中输入 */
async function typeByPlaceholder(page: Page, placeholder: string, text: string): Promise<boolean> {
  try {
    const el = await page.evaluateHandle((ph: string) => {
      const inputs = document.querySelectorAll("input, textarea, [contenteditable='true']");
      for (const e of inputs) {
        const p = (e as HTMLInputElement).placeholder?.trim() ?? "";
        const ariaLabel = e.getAttribute("aria-label")?.trim() ?? "";
        if (p.includes(ph) || ariaLabel.includes(ph)) return e;
      }
      const divs = document.querySelectorAll("[class*='input'], [class*='Input'], [class*='editor'], [class*='Editor']");
      for (const e of divs) {
        const txt = (e as HTMLElement).innerText?.trim() ?? "";
        const p = (e as HTMLInputElement).placeholder?.trim() ?? "";
        if (p.includes(ph) || txt.includes(ph)) return e;
      }
      return null;
    }, placeholder);
    const jsHandle = el.asElement() as ElementHandle<Element> | null;
    if (!jsHandle) return false;
    await jsHandle.click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.type(text, { delay: 30 });
    return true;
  } catch {
    return false;
  }
}

/** 下载页面上的图片（第一张匹配的大图） */
async function downloadFirstImage(
  page: Page,
  outPath: string,
  minWidth = 200,
): Promise<string | null> {
  try {
    const imgUrl = await page.evaluate((mw: number) => {
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        if (img.naturalWidth >= mw && img.src && !img.src.startsWith("data:")) {
          return img.src;
        }
      }
      const bgDivs = document.querySelectorAll("[style*='background-image']");
      for (const d of bgDivs) {
        const style = (d as HTMLElement).style.backgroundImage;
        const m = style.match(/url\(["']?([^"')]+)["']?\)/);
        if (m?.[1]) return m[1];
      }
      return null;
    }, minWidth);

    if (!imgUrl) return null;

    const response = await page.goto(imgUrl, { waitUntil: "networkidle2" });
    if (!response) return null;
    const buffer = await response.buffer();
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buffer);
    await page.goBack();
    return outPath;
  } catch (e) {
    console.warn("[browserBridge] downloadFirstImage 失败:", (e as Error)?.message);
    return null;
  }
}

/** 点击下载按钮并等待下载完成 */
async function clickDownloadAndWait(
  page: Page,
  buttonTexts: string[],
  outDir: string,
  filename: string,
): Promise<string | null> {
  try {
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: outDir,
    });

    for (const text of buttonTexts) {
      const clicked = await clickByText(page, text);
      if (clicked) {
        console.log("[browserBridge] 点击下载按钮:", text);
        await new Promise((r) => setTimeout(r, 5000));
        return join(outDir, filename);
      }
    }
    return null;
  } catch (e) {
    console.warn("[browserBridge] clickDownloadAndWait 失败:", (e as Error)?.message);
    return null;
  }
}

// ─── 网页创作工具专用函数 ───

export interface WebGenResult {
  success: boolean;
  outputPath?: string;
  text?: string;
  error?: string;
  errorKind?: BrowserErrorKind;
}

/**
 * 通义万相文生图（Puppeteer 路径）
 * 打开通义万相 → 登录检测 → 输入 prompt → 点击生成 → 智能等待 → 下载
 */
export async function tongyiWanxiangTextToImage(
  prompt: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getImageOutputDir();
  const filename = `wanxiang_${Date.now()}.png`;
  const outPath = join(dir, filename);
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://tongyi.aliyun.com/wanxiang/generate/image/text-to-image");
    await smartWait(page, { selector: "textarea, input[type='text'], [contenteditable='true']", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const inputSelectors = [
      "textarea",
      "input[type='text']",
      "[contenteditable='true']",
      "[class*='input']",
      "[class*='Input']",
    ];
    let typed = false;
    for (const sel of inputSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 50) {
            await el.click();
            await el.type(prompt, { delay: 20 });
            typed = true;
            break;
          }
        }
      } catch { /* try next */ }
    }
    if (!typed) {
      typed = await typeByPlaceholder(page, "描述", prompt) ||
              await typeByPlaceholder(page, "输入", prompt);
    }
    if (!typed) return { success: false, error: "未找到输入框", errorKind: "element_not_found" };

    const genClicked =
      await clickByText(page, "生成创意画作") ||
      await clickByText(page, "生成") ||
      await clickByText(page, "Generate");
    if (!genClicked) return { success: false, error: "未找到生成按钮", errorKind: "element_not_found" };

    console.log("[browserBridge] 通义万相：等待生成...");
    await waitForGeneration(page, {
      resultSelector: "img[src*='wanx']",
      timeoutMs: 60_000,
    });

    const dlResult = await clickDownloadAndWait(
      page,
      ["下载原图", "下载", "Download", "保存"],
      dir,
      filename,
    );
    if (dlResult) return { success: true, outputPath: dlResult };

    const imgResult = await downloadFirstImage(page, outPath, 256);
    if (imgResult) return { success: true, outputPath: imgResult };

    return { success: false, error: "生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 豆包文生图（Puppeteer 路径）
 */
export async function doubaoTextToImage(
  prompt: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getImageOutputDir();
  const filename = `doubao_${Date.now()}.png`;
  const outPath = join(dir, filename);
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://www.doubao.com");
    await smartWait(page, { text: "豆包", timeoutMs: 8000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const navClicked = await clickByText(page, "图片生成");
    if (navClicked) await smartWait(page, { text: "生成", timeoutMs: 5000 });

    const typed =
      await typeByPlaceholder(page, "描述", prompt) ||
      await typeByPlaceholder(page, "输入", prompt);
    if (!typed) return { success: false, error: "未找到输入框", errorKind: "element_not_found" };

    const genClicked =
      await clickByText(page, "生成") ||
      await clickByText(page, "Generate");
    if (!genClicked) return { success: false, error: "未找到生成按钮", errorKind: "element_not_found" };

    console.log("[browserBridge] 豆包：等待生成...");
    await waitForGeneration(page, { timeoutMs: 60_000 });

    const dlResult = await clickDownloadAndWait(page, ["下载", "Download", "保存"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    const imgResult = await downloadFirstImage(page, outPath, 256);
    if (imgResult) return { success: true, outputPath: imgResult };

    return { success: false, error: "生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 可灵图生视频（Puppeteer 路径）
 */
export async function klingImageToVideo(
  imagePath: string,
  motionPrompt?: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getVideoOutputDir();
  const filename = `kling_${Date.now()}.mp4`;
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://klingai.kuaishou.com");
    await smartWait(page, { text: "可灵", timeoutMs: 8000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const uploadClicked =
      await clickByText(page, "上传") ||
      await clickByText(page, "选择图片") ||
      await clickByText(page, "Upload");

    if (uploadClicked) {
      await smartWait(page, { selector: "input[type='file']", timeoutMs: 5000 });
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        await smartWait(page, { timeoutMs: 5000 });
      }
    }

    if (motionPrompt) {
      await typeByPlaceholder(page, "描述", motionPrompt) ||
        await typeByPlaceholder(page, "运动", motionPrompt);
    }

    await clickByText(page, "生成") || await clickByText(page, "Generate");

    console.log("[browserBridge] 可灵：等待视频生成...");
    await waitForGeneration(page, { timeoutMs: 120_000 });

    const dlResult = await clickDownloadAndWait(page, ["下载", "Download"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    return { success: false, error: "视频生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 即梦图生视频（Puppeteer 路径）
 */
export async function jimengImageToVideo(
  imagePath: string,
  motionPrompt?: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getVideoOutputDir();
  const filename = `jimeng_${Date.now()}.mp4`;
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://jimeng.jianying.com");
    await smartWait(page, { text: "即梦", timeoutMs: 8000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const uploadClicked =
      await clickByText(page, "参考导入") ||
      await clickByText(page, "上传") ||
      await clickByText(page, "导入");

    if (uploadClicked) {
      await smartWait(page, { selector: "input[type='file']", timeoutMs: 5000 });
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        await smartWait(page, { timeoutMs: 8000 });
      }
    }

    await clickByText(page, "生成视频");
    await smartWait(page, { timeoutMs: 3000 });

    if (motionPrompt) {
      await typeByPlaceholder(page, "关键词", motionPrompt) ||
        await typeByPlaceholder(page, "描述", motionPrompt);
    }

    await clickByText(page, "生成") || await clickByText(page, "Generate");

    console.log("[browserBridge] 即梦：等待视频生成...");
    await waitForGeneration(page, { timeoutMs: 120_000 });

    const dlResult = await clickDownloadAndWait(page, ["下载", "Download"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    return { success: false, error: "视频生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Gemini 文案生成（Puppeteer 路径）
 */
export async function geminiCopywriting(prompt: string): Promise<WebGenResult> {
  let page: Page | null = null;
  try {
    page = await newPage("https://gemini.google.com");
    await smartWait(page, { selector: "textarea, [contenteditable='true']", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const typed =
      await typeByPlaceholder(page, "输入", prompt) ||
      await typeByPlaceholder(page, "Message", prompt) ||
      await typeByPlaceholder(page, "Ask", prompt);
    if (!typed) return { success: false, error: "未找到输入框", errorKind: "element_not_found" };

    await page.keyboard.press("Enter");

    console.log("[browserBridge] Gemini：等待回复...");
    await waitForGeneration(page, {
      resultSelector: "[data-message-author-role='model']",
      timeoutMs: 45_000,
    });

    const text = await page.evaluate(() => {
      const msgs = document.querySelectorAll("[class*='response'], [class*='message'], [class*='answer'], [data-message-author-role='model']");
      let last = "";
      for (const m of msgs) {
        const t = (m as HTMLElement).innerText?.trim();
        if (t && t.length > last.length) last = t;
      }
      return last || null;
    });

    if (text) return { success: true, text };
    return { success: false, error: "未获取到回复" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * DeepSeek 文案生成（API 路径，用 .env 中的 key）
 * 不走 Puppeteer，直接调 DeepSeek API
 */
export async function deepseekCopywriting(prompt: string): Promise<WebGenResult> {
  try {
    const apiKey = process.env.CLOUD_API_KEY;
    const baseUrl = process.env.CLOUD_API_BASE_URL || "https://api.deepseek.com/v1";
    const model = process.env.CLOUD_API_MODEL || "deepseek-chat";
    if (!apiKey) return { success: false, error: "CLOUD_API_KEY 未配置", errorKind: "unknown" };

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是一位专业的短视频文案策划师。用户给出主题，你生成包含标题、正文、标签的小红书风格文案。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 2000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `API ${resp.status}: ${errText}`, errorKind: "network" };
    }
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) return { success: true, text };
    return { success: false, error: "API 返回空内容" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  }
}

// ─── 新增工具适配器 ───

/**
 * Grok 文生图（Puppeteer 路径，通过 x.com/i/grok）
 */
export async function grokTextToImage(
  prompt: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getImageOutputDir();
  const filename = `grok_${Date.now()}.png`;
  const outPath = join(dir, filename);
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://x.com/i/grok");
    await smartWait(page, { text: "Grok", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const imagePrompt = `Generate an image: ${prompt}`;
    const typed =
      await typeByPlaceholder(page, "Ask", imagePrompt) ||
      await typeByPlaceholder(page, "Message", imagePrompt) ||
      await typeByPlaceholder(page, "输入", imagePrompt);
    if (!typed) return { success: false, error: "未找到输入框", errorKind: "element_not_found" };

    await page.keyboard.press("Enter");

    console.log("[browserBridge] Grok：等待图片生成...");
    await waitForGeneration(page, { timeoutMs: 90_000 });

    const dlResult = await clickDownloadAndWait(page, ["Download", "下载", "Save"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    const imgResult = await downloadFirstImage(page, outPath, 256);
    if (imgResult) return { success: true, outputPath: imgResult };

    return { success: false, error: "生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * ChatGPT / DALL-E 文生图（Puppeteer 路径，通过 chat.openai.com）
 */
export async function chatgptTextToImage(
  prompt: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getImageOutputDir();
  const filename = `chatgpt_${Date.now()}.png`;
  const outPath = join(dir, filename);
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://chat.openai.com");
    await smartWait(page, { selector: "textarea, [contenteditable='true']", timeoutMs: 12_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const imagePrompt = `Please generate an image: ${prompt}`;
    const typed =
      await typeByPlaceholder(page, "Message", imagePrompt) ||
      await typeByPlaceholder(page, "Send", imagePrompt);
    if (!typed) {
      const ta = await page.$("textarea");
      if (ta) { await ta.click(); await ta.type(imagePrompt, { delay: 20 }); }
      else return { success: false, error: "未找到输入框", errorKind: "element_not_found" };
    }

    await page.keyboard.press("Enter");

    console.log("[browserBridge] ChatGPT DALL-E：等待图片生成...");
    await waitForGeneration(page, { timeoutMs: 120_000 });

    const dlResult = await clickDownloadAndWait(page, ["Download", "下载"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    const imgResult = await downloadFirstImage(page, outPath, 256);
    if (imgResult) return { success: true, outputPath: imgResult };

    return { success: false, error: "生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Runway 图生视频（Puppeteer 路径）
 */
export async function runwayImageToVideo(
  imagePath: string,
  motionPrompt?: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getVideoOutputDir();
  const filename = `runway_${Date.now()}.mp4`;
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://app.runwayml.com");
    await smartWait(page, { text: "Runway", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const uploadClicked =
      await clickByText(page, "Upload") ||
      await clickByText(page, "上传") ||
      await clickByText(page, "Choose file");

    if (uploadClicked) {
      await smartWait(page, { selector: "input[type='file']", timeoutMs: 5000 });
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        await smartWait(page, { timeoutMs: 5000 });
      }
    }

    if (motionPrompt) {
      await typeByPlaceholder(page, "Describe", motionPrompt) ||
        await typeByPlaceholder(page, "prompt", motionPrompt);
    }

    await clickByText(page, "Generate") || await clickByText(page, "生成");

    console.log("[browserBridge] Runway：等待视频生成...");
    await waitForGeneration(page, { timeoutMs: 180_000 });

    const dlResult = await clickDownloadAndWait(page, ["Download", "Export"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    return { success: false, error: "视频生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 系统 TTS 生成音频文件（Windows SAPI -> WAV）
 */
export async function systemTtsGenerate(
  text: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? join(getOutputRoot(), "audio");
  const filename = `tts_${Date.now()}.wav`;
  const outPath = join(dir, filename);

  try {
    await mkdir(dir, { recursive: true });
    const { execSync } = await import("node:child_process");

    const safeText = text.replace(/'/g, "''").replace(/\n/g, " ");
    const ps = `
      Add-Type -AssemblyName System.Speech
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $synth.SetOutputToWaveFile('${outPath.replace(/\\/g, "\\\\")}')
      $synth.Speak('${safeText}')
      $synth.Dispose()
    `;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 30_000 });

    const { existsSync: exists } = await import("node:fs");
    if (exists(outPath)) {
      return { success: true, outputPath: outPath };
    }
    return { success: false, error: "TTS 未生成文件" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: "unknown" };
  }
}

/**
 * HeyGen 数字人口型同步（Puppeteer 路径）
 */
export async function heygenLipsync(
  audioPath: string,
  avatarId?: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getVideoOutputDir();
  const filename = `heygen_${Date.now()}.mp4`;
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://app.heygen.com");
    await smartWait(page, { text: "HeyGen", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const createClicked =
      await clickByText(page, "Create video") ||
      await clickByText(page, "创建视频") ||
      await clickByText(page, "New video");

    if (!createClicked) return { success: false, error: "未找到创建按钮", errorKind: "element_not_found" };
    await smartWait(page, { timeoutMs: 3000 });

    const audioUpload =
      await clickByText(page, "Upload audio") ||
      await clickByText(page, "上传音频") ||
      await clickByText(page, "Audio");
    if (audioUpload) {
      await smartWait(page, { selector: "input[type='file']", timeoutMs: 5000 });
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(audioPath);
        await smartWait(page, { timeoutMs: 8000 });
      }
    }

    await clickByText(page, "Submit") || await clickByText(page, "Generate") || await clickByText(page, "生成");

    console.log("[browserBridge] HeyGen：等待数字人视频生成...");
    await waitForGeneration(page, { timeoutMs: 180_000 });

    const dlResult = await clickDownloadAndWait(page, ["Download", "下载", "Export"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    return { success: false, error: "数字人视频生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Pika 图生视频（Puppeteer 路径）
 */
export async function pikaImageToVideo(
  imagePath: string,
  motionPrompt?: string,
  outDir?: string,
): Promise<WebGenResult> {
  const dir = outDir ?? getVideoOutputDir();
  const filename = `pika_${Date.now()}.mp4`;
  let page: Page | null = null;

  try {
    await mkdir(dir, { recursive: true });
    page = await newPage("https://pika.art");
    await smartWait(page, { text: "Pika", timeoutMs: 10_000 });

    const loggedIn = await waitForUserLogin(page);
    if (!loggedIn) return { success: false, error: "登录超时", errorKind: "login_required" };

    const uploadClicked =
      await clickByText(page, "Upload") ||
      await clickByText(page, "上传");

    if (uploadClicked) {
      await smartWait(page, { selector: "input[type='file']", timeoutMs: 5000 });
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        await smartWait(page, { timeoutMs: 5000 });
      }
    }

    if (motionPrompt) {
      await typeByPlaceholder(page, "Describe", motionPrompt) ||
        await typeByPlaceholder(page, "prompt", motionPrompt);
    }

    await clickByText(page, "Generate") || await clickByText(page, "生成");

    console.log("[browserBridge] Pika：等待视频生成...");
    await waitForGeneration(page, { timeoutMs: 120_000 });

    const dlResult = await clickDownloadAndWait(page, ["Download", "下载"], dir, filename);
    if (dlResult) return { success: true, outputPath: dlResult };

    return { success: false, error: "视频生成完成但下载失败" };
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e), errorKind: classifyError(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
