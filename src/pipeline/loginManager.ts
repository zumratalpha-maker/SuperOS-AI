/**
 * 登录管理器 — 检测工具登录状态、引导用户登录、等待确认
 * 复用 browserBridge 的 Puppeteer 实例，扩展到所有工具
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getToolById, type CreativeTool } from "./toolRegistry.js";

const DB_PATH = join(process.cwd(), "data", "login_cache.db");

function ensureDir(): void {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let db: Database.Database | null = null;
function getDb(): Database.Database {
  if (!db) {
    ensureDir();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_status (
        tool_id TEXT PRIMARY KEY,
        logged_in INTEGER NOT NULL DEFAULT 0,
        last_checked INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
  }
  return db;
}

// ─── 缓存 ───

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

function getCachedStatus(toolId: string): boolean | null {
  const row = getDb()
    .prepare("SELECT logged_in, last_checked, expires_at FROM login_status WHERE tool_id = ?")
    .get(toolId) as { logged_in: number; last_checked: number; expires_at: number | null } | undefined;

  if (!row) return null;
  const expiresAt = row.expires_at ?? (row.last_checked + CACHE_TTL_MS);
  if (Date.now() > expiresAt) return null;
  return row.logged_in === 1;
}

function setCachedStatus(toolId: string, loggedIn: boolean): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO login_status (tool_id, logged_in, last_checked, expires_at) VALUES (?, ?, ?, ?)")
    .run(toolId, loggedIn ? 1 : 0, Date.now(), Date.now() + CACHE_TTL_MS);
}

// ─── 核心接口 ───

export interface LoginCheckResult {
  toolId: string;
  toolName: string;
  needsLogin: boolean;
  isLoggedIn: boolean;
  loginUrl?: string;
}

/**
 * 检查指定工具的登录状态
 * API 工具：检查是否有 API Key
 * Puppeteer 工具：检查缓存或打开页面检测
 * 本地应用：不需要登录
 */
export async function checkLoginStatus(toolId: string): Promise<LoginCheckResult> {
  const tool = getToolById(toolId);
  if (!tool) {
    return { toolId, toolName: toolId, needsLogin: false, isLoggedIn: false };
  }

  if (!tool.needsLogin) {
    return { toolId, toolName: tool.name, needsLogin: false, isLoggedIn: true };
  }

  if (tool.accessMethod === "api") {
    const available = await tool.checkAvailable();
    return { toolId, toolName: tool.name, needsLogin: false, isLoggedIn: available };
  }

  const cached = getCachedStatus(toolId);
  if (cached !== null) {
    return { toolId, toolName: tool.name, needsLogin: true, isLoggedIn: cached, loginUrl: tool.loginUrl };
  }

  return { toolId, toolName: tool.name, needsLogin: true, isLoggedIn: false, loginUrl: tool.loginUrl };
}

/**
 * 引导用户登录：打开登录页面，返回 Page 供后续检测
 */
export async function guideLogin(toolId: string): Promise<{
  opened: boolean;
  loginUrl: string;
  error?: string;
}> {
  const tool = getToolById(toolId);
  if (!tool?.loginUrl) {
    return { opened: false, loginUrl: "", error: "该工具无登录URL" };
  }

  try {
    const bb = await import("../tools/browserBridge.js");
    const page = await (bb as any).newPage?.(tool.loginUrl);
    if (!page) {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", "start", "", tool.loginUrl], { shell: false, stdio: "ignore" });
    }
    return { opened: true, loginUrl: tool.loginUrl };
  } catch (e) {
    try {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", "start", "", tool.loginUrl], { shell: false, stdio: "ignore" });
      return { opened: true, loginUrl: tool.loginUrl };
    } catch {
      return { opened: false, loginUrl: tool.loginUrl, error: (e as Error).message };
    }
  }
}

/**
 * 标记工具已登录（用户说"好了"后调用）
 */
export function markAsLoggedIn(toolId: string): void {
  setCachedStatus(toolId, true);
}

/**
 * 标记工具未登录
 */
export function markAsLoggedOut(toolId: string): void {
  setCachedStatus(toolId, false);
}

/**
 * 获取所有已登录的工具 ID
 */
export function getLoggedInToolIds(): string[] {
  const rows = getDb()
    .prepare("SELECT tool_id FROM login_status WHERE logged_in = 1 AND (expires_at IS NULL OR expires_at > ?)")
    .all(Date.now()) as { tool_id: string }[];
  return rows.map((r) => r.tool_id);
}

/**
 * 批量检查多个工具的登录状态
 */
export async function batchCheckLogin(toolIds: string[]): Promise<LoginCheckResult[]> {
  const results: LoginCheckResult[] = [];
  for (const id of toolIds) {
    results.push(await checkLoginStatus(id));
  }
  return results;
}

/**
 * 获取需要登录但尚未登录的工具列表
 */
export async function getToolsNeedingLogin(toolIds: string[]): Promise<LoginCheckResult[]> {
  const results = await batchCheckLogin(toolIds);
  return results.filter((r) => r.needsLogin && !r.isLoggedIn);
}
