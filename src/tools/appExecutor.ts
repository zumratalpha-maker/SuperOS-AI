/**
 * 全自动路径自愈：桌面快捷方式优先 → 注册表 App Paths → 开始菜单 → 缓存 / 常见路径
 * 支持中文程序名映射（微信→WeChat、剪映→JianyingPro 等），.lnk 用 PowerShell 解析目标路径
 */

import { exec, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveTarget } from "../config/appRegistry.js";

const execAsync = promisify(exec);

const isWin = process.platform === "win32";

/** 中文/俗称 → 快捷方式文件名可能的前缀（用于桌面 .lnk 与注册表键名匹配） */
const TARGET_TO_EXE_NAMES: Record<string, string[]> = {
  微信: ["WeChat.exe", "wechat.exe", "微信.exe"],
  剪映: ["JianyingPro.exe", "剪映.exe", "Jianying.exe"],
  CapCut: ["CapCut.exe", "capcut.exe"],
  Excel: ["EXCEL.EXE", "Excel.exe"],
  WPS: ["wps.exe", "et.exe", "wpp.exe", "WPS.exe"],
  网易云: ["cloudmusic.exe", "CloudMusic.exe"],
  qq: ["QQ.exe", "qq.exe", "QQScLauncher.exe"],
  钉钉: ["DingTalk.exe", "dingtalk.exe"],
  百度网盘: ["baidunetdisk.exe", "BaiduNetdisk.exe"],
  wps: ["wps.exe", "et.exe", "wpp.exe"],
  Word: ["WINWORD.EXE", "word.exe"],
  "Microsoft Word": ["WINWORD.EXE", "word.exe"],
};

/** 中文名 → 桌面 .lnk 可能的主文件名（不含 .lnk），用于优先匹配桌面快捷方式 */
const CHINESE_NAME_TO_LNK_STEMS: Record<string, string[]> = {
  微信: ["微信", "WeChat", "wechat"],
  剪映: ["剪映", "JianyingPro", "Jianying", "jianying"],
  CapCut: ["CapCut", "capcut"],
  Excel: ["Excel", "Microsoft Excel"],
  WPS: ["WPS", "wps", "WPS Office", "ET", "WPP"],
  网易云: ["网易云音乐", "cloudmusic", "CloudMusic"],
  qq: ["QQ", "qq", "腾讯QQ"],
  钉钉: ["钉钉", "DingTalk", "dingtalk"],
  百度网盘: ["百度网盘", "baidunetdisk", "BaiduNetdisk"],
  wps: ["WPS", "wps", "WPS Office"],
  Word: ["Word", "Microsoft Word", "winword"],
  "Microsoft Word": ["Word", "Microsoft Word", "winword"],
};

/** 常见安装路径（预设路径不存在时按顺序尝试，支持 %ProgramFiles% 等环境变量） */
const COMMON_APP_PATHS: Record<string, string[]> = {
  微信: [
    "D:\\weixin\\Weixin.exe",
    "C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe",
    "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
    "D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe",
    "D:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
    "D:\\Tencent\\WeChat\\WeChat.exe",
    "E:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe",
    "E:\\Tencent\\WeChat\\WeChat.exe",
    "%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe",
    "%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe",
    "%LOCALAPPDATA%\\Tencent\\WeChat\\WeChat.exe",
  ],
  Excel: [
    "%ProgramFiles%\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
    "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
  ],
  WPS: [
    "%LOCALAPPDATA%\\Kingsoft\\wps\\ksolaunch.exe",
    "C:\\Program Files (x86)\\Kingsoft\\WPS Office\\ksolaunch.exe",
    "D:\\Program Files (x86)\\Kingsoft\\WPS Office\\ksolaunch.exe",
  ],
  剪映: [
    "%LOCALAPPDATA%\\JianyingPro\\Apps\\JianyingPro.exe",
    "%LOCALAPPDATA%\\CapCut\\Apps\\CapCut.exe",
    "D:\\JianyingPro\\JianyingPro.exe",
    "C:\\JianyingPro\\JianyingPro.exe",
    "E:\\JianyingPro\\JianyingPro.exe",
  ],
  Word: [
    "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  ],
  "Microsoft Word": [
    "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  ],
};

/** 展开 %ENV% */
function expandEnvPath(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? `%${key}%`);
}

/** 获取当前可用盘符（不含 C: 的优先列表，软件常装在 D/E 等） */
function getDriveLetters(): string[] {
  if (!isWin) return [];
  const letters: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = String.fromCharCode(i) + ":";
    try {
      if (fs.existsSync(drive + "\\")) letters.push(drive);
    } catch (_) {}
  }
  const c = "C:";
  const withoutC = letters.filter((d) => d !== c);
  return [...withoutC, c];
}

/**
 * 当路径不存在时，在同一相对路径下尝试其他盘符（软件可能装在 D:/E: 等）
 * 例如 C:\Program Files (x86)\Tencent\WeChat\WeChat.exe 不存在 → 试 D:\Program Files (x86)\Tencent\WeChat\WeChat.exe
 */
function trySamePathOnOtherDrives(absPath: string): string | null {
  if (!absPath || absPath.length < 3) return null;
  const normalized = path.normalize(absPath);
  const first = normalized.charAt(0).toUpperCase();
  const second = normalized.charAt(1);
  if (first >= "A" && first <= "Z" && second === ":") {
    const rest = normalized.slice(2);
    for (const drive of getDriveLetters()) {
      if (drive.charAt(0) === first) continue;
      const candidate = drive + rest;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 返回所有可能的桌面目录（含 OneDrive），优先扫描 */
function getDesktopPaths(): string[] {
  if (!isWin) return [];
  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!userProfile) return [path.join("C:", "Users", "Public", "Desktop")];
  const candidates = [
    path.join(userProfile, "Desktop"),
    path.join(userProfile, "OneDrive", "Desktop"),
    path.join(userProfile, "OneDrive", "OneDrive", "Desktop"),
    path.join(userProfile, "桌面"),
  ];
  return [...new Set(candidates)];
}

function getCacheFilePath(): string {
  const dir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "appRegistry.cache.json");
}

export type CacheEntry = { path?: string; appId?: string };

function readCache(): Record<string, CacheEntry> {
  try {
    const p = getCacheFilePath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw) as Record<string, CacheEntry>;
    }
  } catch (_) {
    // ignore
  }
  return {};
}

function writeCache(updates: Record<string, CacheEntry>): void {
  try {
    const p = getCacheFilePath();
    const current = readCache();
    const next = { ...current, ...updates };
    fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[appExecutor] 写入缓存失败:", err);
  }
}

/** 用 PowerShell 解析 .lnk 目标路径；若目标不存在则尝试同相对路径在其他盘符（软件可能不在 C 盘） */
async function resolveLnkTarget(lnkFullPath: string): Promise<string | null> {
  if (!isWin) return null;
  try {
    const ps = `$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut(${JSON.stringify(lnkFullPath)}); $l.TargetPath`;
    const { stdout } = await execAsync("powershell -NoProfile -Command " + ps, {
      timeout: 5000,
      encoding: "utf-8",
    });
    const p = (stdout || "").trim();
    if (!p) return null;
    if (fs.existsSync(p)) return p;
    const onOther = trySamePathOnOtherDrives(p);
    return onOther ?? null;
  } catch (_) {
    return null;
  }
}

/** 扫描桌面 .lnk，返回 匹配名 → 可启动路径（exe 或 .lnk 本身；解析失败时用 .lnk 路径，Windows 可直接启动） */
async function scanDesktopShortcuts(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!isWin) return map;

  const desktops = getDesktopPaths();
  for (const desktop of desktops) {
    if (!fs.existsSync(desktop)) continue;
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(desktop, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".lnk")) continue;
      const fullPath = path.join(desktop, f.name);
      const stem = f.name.slice(0, -4).trim();
      const target = await resolveLnkTarget(fullPath);
      const launchPath = target && fs.existsSync(target) ? target : fullPath;

      const stemLower = stem.toLowerCase();
      if (!map[stemLower]) map[stemLower] = launchPath;
      if (stem !== stemLower && !map[stem]) map[stem] = launchPath;

      for (const [chineseName, stems] of Object.entries(CHINESE_NAME_TO_LNK_STEMS)) {
        if (stems.some((s) => s.toLowerCase() === stemLower || stemLower.includes(s.toLowerCase()))) {
          map[chineseName] = launchPath;
        }
      }
    }
  }

  return map;
}

/** 从桌面快捷方式解析目标路径，优先级最高 */
async function resolveDesktopShortcut(targetName: string): Promise<string | null> {
  const desktopMap = await scanDesktopShortcuts();
  const name = targetName.trim();
  const lower = name.toLowerCase();

  if (desktopMap[name]) return desktopMap[name];
  if (desktopMap[lower]) return desktopMap[lower];

  const stems = CHINESE_NAME_TO_LNK_STEMS[name] ?? [name, lower, name.replace(/\s+/g, "")];
  for (const s of stems) {
    const v = desktopMap[s] ?? desktopMap[s.toLowerCase()];
    if (v) return v;
  }

  for (const [key, pathVal] of Object.entries(desktopMap)) {
    if (key.includes(name) || name.includes(key) || key.includes(lower) || lower.includes(key)) {
      return pathVal;
    }
  }

  return null;
}

/** 从指定注册表根下 App Paths 读取 exe 路径列表（每行 键名|路径） */
async function readRegistryAppPaths(hive: "HKLM" | "HKCU"): Promise<string[]> {
  if (!isWin) return [];
  try {
    const root = hive === "HKLM" ? "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths" : "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";
    const psScript =
      "Get-ChildItem " + JSON.stringify(root) + " -ErrorAction SilentlyContinue | " +
      "ForEach-Object { $n=$_.PSChildName; $v=(Get-ItemProperty -LiteralPath $_.PSPath -Name '(default)' -EA 0).'(default)'; if($v){\"$n|$v\"} }";
    const { stdout } = await execAsync("powershell -NoProfile -Command " + JSON.stringify(psScript), {
      timeout: 6000,
      encoding: "utf-8",
    });
    return (stdout || "").trim().split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** 注册表 HKLM + HKCU App Paths 下查找 exe 路径（微信等可能只注册在 HKCU） */
async function searchRegistryAppPaths(targetName: string): Promise<string | null> {
  if (!isWin) return null;
  const t = targetName.trim().toLowerCase();
  const possibleNames = TARGET_TO_EXE_NAMES[targetName.trim()] ?? [
    targetName.trim() + ".exe",
    t + ".exe",
    targetName.trim().replace(/\s+/g, "") + ".exe",
  ];
  const keyLower = (s: string) => s.replace(/\.exe$/i, "").toLowerCase();

  for (const hive of ["HKLM", "HKCU"] as const) {
    const lines = await readRegistryAppPaths(hive);
    for (const line of lines) {
      const idx = line.indexOf("|");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const exePath = line.slice(idx + 1).trim();
      const keyBase = keyLower(key);
      const match =
        possibleNames.some((n) => keyBase === keyLower(n)) ||
        keyBase.includes(t) ||
        t.includes(keyBase) ||
        key.toLowerCase().includes(t);
      if (match && exePath && fs.existsSync(exePath)) return exePath;
    }
  }
  return null;
}

/** 在常见安装目录中查找 exe（仅限固定路径组合，避免全盘扫描） */
async function searchExeInCommonFolders(exeNames: string[]): Promise<string | null> {
  if (!isWin || !exeNames.length) return null;
  const roots = [
    expandEnvPath("%ProgramFiles(x86)%"),
    expandEnvPath("%ProgramFiles%"),
    "D:\\Program Files (x86)",
    "D:\\Program Files",
    "D:\\Tencent",
    "E:\\Program Files (x86)",
    "E:\\Tencent",
    expandEnvPath("%LOCALAPPDATA%") + "\\Tencent",
  ].filter((r) => r && !r.startsWith("%"));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const exeName of exeNames) {
      const sub = exeName.replace(/\.exe$/i, "");
      const candidates = [
        path.join(root, sub, exeName),
        path.join(root, "WeChat", exeName),
        path.join(root, "Tencent", "WeChat", exeName),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }
  return null;
}

/** 用户说的名称 → 开始菜单里可能显示的名称（中文系统可能是中文，英文系统可能是英文） */
function getStartAppSearchStems(targetName: string): string[] {
  const t = targetName.trim();
  const stems = CHINESE_NAME_TO_LNK_STEMS[t] ?? [t, t.toLowerCase(), t.replace(/\s+/g, "")];
  const exeStems = TARGET_TO_EXE_NAMES[t]?.map((x) => x.replace(/\.exe$/i, "")) ?? [];
  return [...new Set([t, t.toLowerCase(), ...stems, ...exeStems])];
}

/** Get-StartApps 模糊匹配名称，返回 AppID；支持「微信」匹配 Name 为 WeChat 的项 */
async function searchStartApps(targetName: string): Promise<{ appId: string; name: string } | null> {
  if (!isWin) return null;
  const t = targetName.trim().toLowerCase();
  const searchStems = getStartAppSearchStems(targetName);
  try {
    const { stdout } = await execAsync(
      "powershell -NoProfile -Command " + JSON.stringify("Get-StartApps | ConvertTo-Json -Compress"),
      { timeout: 8000, encoding: "utf-8" }
    );
    const json = (stdout || "").trim();
    const arr = JSON.parse(json) as { Name: string; AppId: string }[];
    const list = Array.isArray(arr) ? arr : [arr];
    for (const item of list) {
      const name = (item.Name || "").trim();
      const appId = (item.AppId || "").trim();
      if (!appId) continue;
      const nameLower = name.toLowerCase();
      if (nameLower.includes(t) || t.includes(nameLower) || name.includes(targetName.trim())) {
        return { appId, name };
      }
      for (const stem of searchStems) {
        const s = (stem || "").toLowerCase();
        if (!s) continue;
        if (nameLower.includes(s) || s.includes(nameLower)) {
          return { appId, name };
        }
      }
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function launchByAppId(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd", ["/c", "start", "", "shell:AppsFolder\\" + appId], {
      shell: false,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

function launchByPath(exePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", exePath], { shell: false, stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    } else {
      const open = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(open, [exePath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    }
  });
}

export type ResolveAndLaunchResult = {
  ok: boolean;
  usedFallback?: boolean;
  fallbackMessage?: string;
  error?: string;
};

/**
 * LLM 常输出的错误应用名 → 正确名称（字形/编码混用，如 "记事 bản" 应为 "记事本"）
 */
const APP_NAME_CORRECTIONS: Record<string, string> = {
  "记事 bản": "记事本",
  "记事bản": "记事本",
  "记事 ban": "记事本",
  "记事ban": "记事本",
};

/** 纠正常见 LLM 输出错误的应用名 */
function normalizeAppName(raw: string): string {
  const t = raw.trim().normalize("NFC");
  const corrected = APP_NAME_CORRECTIONS[t];
  if (corrected) return corrected;
  // 也尝试 NFD 形式（部分 LLM 会输出分解字符）
  const tNfd = raw.trim().normalize("NFD");
  const correctedNfd = APP_NAME_CORRECTIONS[tNfd];
  if (correctedNfd) return correctedNfd;
  // 启发式：以「记事」开头且含异常字符（非「本」）时，疑为记事本误输出
  if (/^记事\s*.{1,8}$/.test(t) && t !== "记事本") return "记事本";
  if (/^记事\s*.{1,8}$/.test(tNfd) && tNfd !== "记事本") return "记事本";
  return t;
}

/**
 * 解析并启动。优先级：URL/系统命令 → 桌面快捷方式 → 缓存 → appRegistry 预设路径 → 注册表 App Paths → 开始菜单 → 兜底
 */
export async function resolveAndLaunch(targetName: string): Promise<ResolveAndLaunchResult> {
  const name = normalizeAppName(targetName);
  if (!name) return { ok: false, error: "目标名为空" };

  const fromRegistry = resolveTarget(name);
  const expandedFromRegistry = fromRegistry ? expandEnvPath(fromRegistry) : undefined;

  // URL：直接浏览器打开
  if (expandedFromRegistry && (expandedFromRegistry.startsWith("http://") || expandedFromRegistry.startsWith("https://"))) {
    try {
      const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", expandedFromRegistry] : [expandedFromRegistry];
      await new Promise<void>((res, rej) => {
        const c = spawn(open, args, { stdio: "ignore" });
        c.on("error", rej);
        c.on("close", () => res());
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 系统命令（仅白名单：notepad/calc 等；不含反斜杠不再作为判断依据，避免路径转义损坏被误认为命令）
  const cmd = (expandedFromRegistry ?? name)?.trim() ?? "";
  const isSystemCommand = /^(notepad|calc|mspaint|explorer|cmd|powershell)$/i.test(cmd);
  if (isSystemCommand && cmd) {
    try {
      await launchByPath(expandedFromRegistry ?? name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // appRegistry 本地 exe 优先（路径存在则直接启动，跳过耗时的桌面扫描）
  const presetEarly = expandedFromRegistry;
  if (presetEarly && !presetEarly.startsWith("http") && !isSystemCommand) {
    let pathToUse = fs.existsSync(presetEarly) ? presetEarly : null;
    if (!pathToUse && presetEarly) pathToUse = trySamePathOnOtherDrives(presetEarly);
    if (pathToUse) {
      try {
        await launchByPath(pathToUse);
        writeCache({ [name]: { path: pathToUse } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
  }

  // 1) 桌面快捷方式优先（含中文名映射）
  if (isWin) {
    const desktopPath = await resolveDesktopShortcut(name);
    if (desktopPath) {
      try {
        await launchByPath(desktopPath);
        writeCache({ [name]: { path: desktopPath } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
  }

  // 2) 缓存命中（仅当路径存在时使用，否则忽略该缓存避免反复启动失效路径）
  const cache = readCache();
  const cached = cache[name];
  if (cached?.path && fs.existsSync(cached.path)) {
    try {
      await launchByPath(cached.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (cached?.path && !fs.existsSync(cached.path)) {
    writeCache({ [name]: {} });
  }
  if (cached?.appId) {
    try {
      await launchByAppId(cached.appId);
      return { ok: true };
    } catch (_) {
      // appId 可能失效，继续
    }
  }

  // 3) appRegistry 预设路径（存在则用；不存在则尝试同路径在 D/E 等盘符）
  const presetPath = expandedFromRegistry;
  let pathToUse = presetPath && fs.existsSync(presetPath) ? presetPath : null;
  if (!pathToUse && presetPath) pathToUse = trySamePathOnOtherDrives(presetPath);
  if (pathToUse) {
    try {
      await launchByPath(pathToUse);
      writeCache({ [name]: { path: pathToUse } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 3.5) 常见路径兜底（如微信常装在 D:\\Tencent、D:\\Program Files 等，与 C 盘结构不同）
  const commonPaths = COMMON_APP_PATHS[name];
  if (commonPaths && commonPaths.length > 0) {
    for (const p of commonPaths) {
      const expanded = expandEnvPath(p);
      if (fs.existsSync(expanded)) {
        try {
          await launchByPath(expanded);
          writeCache({ [name]: { path: expanded } });
          return { ok: true, usedFallback: true, fallbackMessage: `已从常见路径定位并打开 ${name}。` };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      const onOther = trySamePathOnOtherDrives(expanded);
      if (onOther) {
        try {
          await launchByPath(onOther);
          writeCache({ [name]: { path: onOther } });
          return { ok: true, usedFallback: true, fallbackMessage: `已从常见路径（其他盘符）定位并打开 ${name}。` };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
    }
  }

  // 4) 注册表 App Paths
  const fromReg = await searchRegistryAppPaths(name);
  if (fromReg) {
    try {
      await launchByPath(fromReg);
      writeCache({ [name]: { path: fromReg } });
      return {
        ok: true,
        usedFallback: true,
        fallbackMessage: `先生，默认路径失效，已通过系统检索重新定位并打开 ${name}。`,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 5) PowerShell 在常见目录快速搜 exe（仅对已知 exe 名、限制深度，避免全盘扫）
  const exeNames = TARGET_TO_EXE_NAMES[name];
  if (exeNames && exeNames.length > 0) {
    const found = await searchExeInCommonFolders(exeNames);
    if (found) {
      try {
        await launchByPath(found);
        writeCache({ [name]: { path: found } });
        return { ok: true, usedFallback: true, fallbackMessage: `已在磁盘常见位置找到并打开 ${name}。` };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    // 5.5) where 命令兜底（Windows 可找到 PATH 或注册路径中的 exe）
    if (isWin) {
      for (const exe of exeNames) {
        try {
          const { stdout } = await execAsync("where " + exe, { timeout: 5000, encoding: "utf-8" });
          const firstLine = (stdout || "").split(/\r?\n/)[0]?.trim();
          if (firstLine && fs.existsSync(firstLine)) {
            await launchByPath(firstLine);
            writeCache({ [name]: { path: firstLine } });
            return { ok: true, usedFallback: true, fallbackMessage: `已通过 where 定位并打开 ${name}。` };
          }
        } catch (_) {
          // ignore
        }
      }
    }
  }

  // 6) 开始菜单 Get-StartApps
  const fromStartApps = await searchStartApps(name);
  if (fromStartApps) {
    try {
      await launchByAppId(fromStartApps.appId);
      writeCache({ [name]: { appId: fromStartApps.appId } });
      return {
        ok: true,
        usedFallback: true,
        fallbackMessage: `先生，默认路径失效，已通过系统检索重新定位并打开 ${name}。`,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 7) 兜底：仅当预设路径在某一盘符存在时才用；否则不再用「名称」启动（中文名如「微信」会报错）
  const presetOnOther = presetPath ? trySamePathOnOtherDrives(presetPath) : null;
  const toLaunch = (presetPath && fs.existsSync(presetPath)) ? presetPath : presetOnOther;
  if (toLaunch) {
    try {
      await launchByPath(toLaunch);
      writeCache({ [name]: { path: toLaunch } });
      return { ok: true, usedFallback: true, fallbackMessage: `已从其他盘符定位并打开 ${name}。` };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    ok: false,
    error: `未找到「${name}」。请确认已安装、在桌面有快捷方式，或把 exe 路径填到 appRegistry。`,
  };
}
