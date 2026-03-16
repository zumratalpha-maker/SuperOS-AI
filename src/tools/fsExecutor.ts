/**
 * 本地文件管理：桌面建文件夹、将确认的资源链接写入 links.txt
 */

import * as fs from "node:fs";
import * as path from "node:path";

function getDesktopPath(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? "";
    if (userProfile) return path.join(userProfile, "Desktop");
    return path.join("C:", "Users", "Public", "Desktop");
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, "Desktop");
}

/**
 * 在桌面创建指定名称的文件夹，返回完整路径
 */
export function createFolderOnDesktop(folderName: string): { ok: boolean; path?: string; error?: string } {
  try {
    const safe = folderName.replace(/[<>:"/\\|?*]/g, "_").trim() || "新建文件夹";
    const desktop = getDesktopPath();
    const fullPath = path.join(desktop, safe);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    return { ok: true, path: fullPath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * 在指定文件夹内生成或追加 links.txt，写入资源链接（每行一个）
 */
export function saveLinksToFile(folderPath: string, links: string[]): { ok: boolean; error?: string } {
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, "links.txt");
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    const toAppend = links.filter((u) => u.trim()).map((u) => u.trim());
    if (toAppend.length === 0) return { ok: true };
    const newContent = existing ? existing + "\n" + toAppend.join("\n") : toAppend.join("\n");
    fs.writeFileSync(filePath, newContent + (newContent.endsWith("\n") ? "" : "\n"), "utf-8");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
