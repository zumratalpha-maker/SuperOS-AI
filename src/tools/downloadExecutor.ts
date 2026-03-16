/**
 * 下载执行器：优先使用 aria2；未找到时走 Get-It-Done 静默安装到 bin/，仅无法安装时才提示用户
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "./UniversalExecutor.js";

const DOWNLOAD_DIR = path.join(process.cwd(), "downloads");

function ensureDownloadDir(): string {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  return DOWNLOAD_DIR;
}

/** 查找 aria2c：PATH → bin/ → Get-It-Done 静默安装 */
async function findAria2(): Promise<string | null> {
  const pathFromEnsure = await ensureTool("aria2", {
    researchTask: "aria2 Windows official download CLI",
    skipResearch: false,
  });
  return pathFromEnsure;
}

export type DownloadResult = { ok: boolean; message?: string; needInstallPrompt?: boolean };

/**
 * 使用 aria2 下载 magnet 或 .torrent；未找到 aria2 时返回 needInstallPrompt
 */
export async function downloadWithAria2(magnetOrTorrentUrl: string): Promise<DownloadResult> {
  const aria2Path = await findAria2();
  if (!aria2Path) {
    return {
      ok: false,
      needInstallPrompt: true,
      message: "先生，我没找到下载引擎，需要我为您自动下载并安装 aria2 吗？",
    };
  }

  const dir = ensureDownloadDir();
  const args = ["-d", dir, "--allow-overwrite=true", magnetOrTorrentUrl];

  return new Promise((resolve) => {
    const child = spawn(aria2Path, args, { stdio: "inherit", shell: false });
    child.on("error", (err) => {
      resolve({ ok: false, message: String(err) });
    });
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, message: `aria2 退出码 ${code}` });
    });
  });
}
