/**
 * 动态操作执行器：Web 端 page.evaluate / OS 端 PowerShell、.bat，以及 Get-It-Done 静默安装 CLI 工具
 */

import { exec, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { promisify } from "node:util";
import { research } from "../agents/ResearchAgent.js";

const execAsync = promisify(exec);
const isWin = process.platform === "win32";

const BIN_DIR = path.join(process.cwd(), "bin");

/** 已知 CLI 工具官方下载（Windows），Get-It-Done 静默安装用 */
const KNOWN_TOOL_URLS: Record<string, string> = {
  ["aria2"]:
    "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip",
  ["yt-dlp"]: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
};

function ensureBinDir(): string {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  return BIN_DIR;
}

/** 下载文件到指定路径 */
function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { "User-Agent": "Jarvis/1.0" } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          if (loc) {
            file.close();
            fs.unlink(destPath, () => {});
            downloadFile(loc, destPath).then(resolve);
            return;
          }
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(true);
        });
      })
      .on("error", (err) => {
        console.error("[UniversalExecutor] download error:", err);
        file.close();
        fs.unlink(destPath, () => {});
        resolve(false);
      });
  });
}

/** 解压 zip 到目录（PowerShell Expand-Archive） */
async function unzipToDir(zipPath: string, outDir: string): Promise<boolean> {
  if (!isWin) return false;
  try {
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(outDir)} -Force"`,
      { timeout: 60000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

const TOOL_ALIASES: Record<string, string[]> = {
  aria2: ["aria2.exe", "aria2c.exe"],
};

/** 在 bin 目录中查找已安装的可执行文件（含子目录） */
function findExeInBin(name: string): string | null {
  const dir = BIN_DIR;
  if (!fs.existsSync(dir)) return null;
  const base = name.replace(/\.exe$/i, "");
  const namesToFind = TOOL_ALIASES[base] ?? [base + ".exe", name];
  const walk = (d: string): string | null => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && namesToFind.some((n) => e.name.toLowerCase() === n.toLowerCase())) return full;
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const found = walk(full);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(dir);
}

// --------------- Web 端：Puppeteer page.evaluate ---------------

let sharedBrowser: Awaited<ReturnType<typeof import("puppeteer")["default"]["launch"]>> | null = null;

async function getSharedBrowser(): Promise<import("puppeteer").Browser> {
  if (sharedBrowser) return sharedBrowser;
  const puppeteer = await import("puppeteer");
  sharedBrowser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return sharedBrowser;
}

/**
 * 在指定 URL 页面执行自定义脚本（深度交互：下载受限、提取动态内容等）
 * 脚本在 page 上下文中执行，可访问 document、window，返回可序列化结果
 */
export async function executeWebScript(
  url: string,
  script: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let page: import("puppeteer").Page | null = null;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1000));
    const result = await page.evaluate((code) => {
      try {
        const fn = new Function("return (" + code + ")");
        return fn();
      } catch (e) {
        return { __error: String(e) };
      }
    }, script);
    await page.close();
    if (result && typeof result === "object" && "__error" in result) {
      return { ok: false, error: String((result as { __error: string }).__error) };
    }
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (page) await page.close().catch(() => null);
    return { ok: false, error: msg };
  }
}

// --------------- OS 端：PowerShell / .bat ---------------

/**
 * 执行 PowerShell 脚本
 */
export async function executePowerShell(
  script: string
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  if (!isWin) {
    return { ok: false, stdout: "", stderr: "PowerShell only on Windows", code: -1 };
  }
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer | string) => {
      out += typeof d === "string" ? d : d.toString();
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      err += typeof d === "string" ? d : d.toString();
    });
    child.on("close", (code: number | null) => {
      resolve({ ok: code === 0, stdout: out, stderr: err, code: code ?? -1 });
    });
    child.on("error", (e: Error) => {
      resolve({ ok: false, stdout: out, stderr: err + String(e), code: -1 });
    });
  });
}

/**
 * 动态生成并执行 .bat 脚本
 */
export async function executeBatch(script: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const dir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const batPath = path.join(dir, `jarvis_${Date.now()}.bat`);
  try {
    fs.writeFileSync(batPath, script, "utf-8");
    const { stdout, stderr } = await execAsync(`cmd /c "${batPath}"`, {
      timeout: 120000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : -1,
    };
  } finally {
    try { fs.unlinkSync(batPath); } catch (_) {}
  }
}

// --------------- Get-It-Done：静默安装 CLI 到 bin ---------------

/**
 * 确保指定 CLI 工具可用：先查 PATH 与 bin/，若无则按已知 URL 或研究结果静默下载到 bin/
 * 仅当研究结果标记 needsUserConsent 时才不自动安装、返回 null
 */
export async function ensureTool(
  toolName: string,
  options?: { researchTask?: string; skipResearch?: boolean }
): Promise<string | null> {
  const name = toolName.trim().toLowerCase();
  if (!name) return null;

  const inPath = await findInPath(name);
  if (inPath) return inPath;

  const inBin = findExeInBin(name);
  if (inBin) return inBin;

  let downloadUrl: string | null = KNOWN_TOOL_URLS[name] ?? null;
  if (!downloadUrl && options?.researchTask && !options?.skipResearch) {
    const res = await research(options.researchTask);
    if (res.needsUserConsent) {
      console.log("[UniversalExecutor] 需要用户确认，跳过静默安装:", name);
      return null;
    }
    if (res.toolDownloadUrl) downloadUrl = res.toolDownloadUrl;
    if (res.toolName && !downloadUrl) downloadUrl = KNOWN_TOOL_URLS[res.toolName.toLowerCase()] ?? null;
  }

  if (!downloadUrl) return null;

  ensureBinDir();
  const ext = downloadUrl.includes(".zip") ? ".zip" : ".exe";
  const destFile = path.join(BIN_DIR, name + ext);

  console.log("[UniversalExecutor] Get-It-Done: 正在静默安装", name, "到", BIN_DIR);
  const ok = await downloadFile(downloadUrl, destFile);
  if (!ok) return null;

  if (ext === ".zip") {
    const outDir = path.join(BIN_DIR, name);
    const unzipOk = await unzipToDir(destFile, outDir);
    try { fs.unlinkSync(destFile); } catch (_) {}
    if (!unzipOk) return null;
    const exe = findExeInBin(name);
    return exe;
  }

  const exePath = destFile.endsWith(".exe") ? destFile : path.join(BIN_DIR, name + ".exe");
  if (destFile !== exePath) try { fs.renameSync(destFile, exePath); } catch (_) {}
  return fs.existsSync(exePath) ? exePath : destFile;
}

function findInPath(name: string): Promise<string | null> {
  const cmd = isWin ? `where ${name}` : `which ${name}`;
  return execAsync(cmd, { timeout: 3000, encoding: "utf-8" })
    .then(({ stdout }) => {
      const first = (stdout || "").trim().split(/\r?\n/)[0]?.trim();
      return first && fs.existsSync(first) ? first : null;
    })
    .catch(() => null);
}

/** 返回 bin 目录绝对路径，便于调用方将 bin 加入 PATH 或直接传参 */
export function getBinDir(): string {
  return ensureBinDir();
}
