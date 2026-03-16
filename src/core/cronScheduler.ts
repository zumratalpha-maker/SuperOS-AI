/**
 * 定时任务调度 — 支持 cron 表达式和自然语言时间规则
 *
 * 用法：
 *   addCronJob("每天19点发小红书", "0 19 * * *", () => dispatch("发小红书图文"))
 *   addCronJob("每周一整理文件", "0 9 * * 1", () => dispatch("整理桌面文件"))
 *   addNaturalJob("每天19点", "发小红书", dispatchFn)
 *
 * 内置简易 cron 解析器，不依赖外部库。
 * 支持格式：分 时 日 月 周  (5段)
 *   星号 = 任意, 数字 = 精确匹配, 星号/n = 每n单位, 1,3,5 = 列表
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CronJob {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  createdAt: number;
}

type CommandExecutor = (command: string) => Promise<void>;

const DATA_DIR = join(process.cwd(), "data");
const JOBS_FILE = join(DATA_DIR, "cron_jobs.json");

let jobs: CronJob[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
let executor: CommandExecutor | null = null;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadJobs(): void {
  ensureDataDir();
  if (existsSync(JOBS_FILE)) {
    try {
      jobs = JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
    } catch { jobs = []; }
  }
}

function saveJobs(): void {
  ensureDataDir();
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

function genId(): string {
  return `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Cron 解析器 ───

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }

  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step < 1) return [min];
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }

  if (field.includes(",")) {
    return field.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= min && n <= max);
  }

  if (field.includes("-")) {
    const [a, b] = field.split("-").map((s) => parseInt(s.trim(), 10));
    if (isNaN(a) || isNaN(b)) return [min];
    const result: number[] = [];
    for (let i = Math.max(a, min); i <= Math.min(b, max); i++) result.push(i);
    return result;
  }

  const n = parseInt(field, 10);
  if (!isNaN(n) && n >= min && n <= max) return [n];
  return [min];
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

function matchesCron(cron: CronFields, date: Date): boolean {
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cron.dayOfMonth.includes(date.getDate()) &&
    cron.month.includes(date.getMonth() + 1) &&
    cron.dayOfWeek.includes(date.getDay())
  );
}

function getNextRunTime(cronExpr: string, after: Date = new Date()): number | undefined {
  const cron = parseCron(cronExpr);
  if (!cron) return undefined;

  const check = new Date(after);
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matchesCron(cron, check)) return check.getTime();
    check.setMinutes(check.getMinutes() + 1);
  }
  return undefined;
}

// ─── 自然语言 → Cron ───

export function naturalToCron(text: string): string | null {
  const t = text.trim();

  let m = t.match(/每天\s*(\d{1,2})\s*[点时]/);
  if (m) return `0 ${m[1]} * * *`;

  m = t.match(/每天\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return `${m[2]} ${m[1]} * * *`;

  m = t.match(/每(\d+)\s*分钟/);
  if (m) return `*/${m[1]} * * * *`;

  m = t.match(/每(\d+)\s*小时/);
  if (m) return `0 */${m[1]} * * *`;

  const weekDays: Record<string, number> = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0,
    "Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6, "Sunday": 0,
  };

  m = t.match(/每周(.)\s*(\d{1,2})\s*[点时]/);
  if (m) {
    const dow = weekDays[m[1]];
    if (dow !== undefined) return `0 ${m[2]} * * ${dow}`;
  }

  m = t.match(/每月\s*(\d{1,2})\s*[号日]\s*(\d{1,2})\s*[点时]/);
  if (m) return `0 ${m[2]} ${m[1]} * *`;

  if (/每天/.test(t)) return "0 9 * * *";
  if (/每周/.test(t)) return "0 9 * * 1";

  return null;
}

// ─── 公开 API ───

export function addCronJob(name: string, cronExpr: string, command: string): CronJob {
  loadJobs();
  const job: CronJob = {
    id: genId(),
    name,
    cron: cronExpr,
    command,
    enabled: true,
    runCount: 0,
    createdAt: Date.now(),
    nextRun: getNextRunTime(cronExpr),
  };
  jobs.push(job);
  saveJobs();
  return job;
}

export function addNaturalJob(timeExpr: string, command: string): CronJob | null {
  const cron = naturalToCron(timeExpr);
  if (!cron) return null;
  return addCronJob(`${timeExpr} ${command.slice(0, 20)}`, cron, command);
}

export function removeJob(id: string): boolean {
  loadJobs();
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  if (jobs.length < before) { saveJobs(); return true; }
  return false;
}

export function toggleJob(id: string, enabled: boolean): void {
  loadJobs();
  const job = jobs.find((j) => j.id === id);
  if (job) { job.enabled = enabled; saveJobs(); }
}

export function listJobs(): CronJob[] {
  loadJobs();
  return [...jobs];
}

export function getJobById(id: string): CronJob | undefined {
  loadJobs();
  return jobs.find((j) => j.id === id);
}

export function startCronScheduler(exec: CommandExecutor): void {
  if (tickTimer) return;
  executor = exec;
  loadJobs();

  console.log(`[cron] 定时调度启动，已加载 ${jobs.length} 个定时任务`);

  tickTimer = setInterval(async () => {
    const now = new Date();
    now.setSeconds(0, 0);
    const ts = now.getTime();

    for (const job of jobs) {
      if (!job.enabled) continue;
      const cron = parseCron(job.cron);
      if (!cron || !matchesCron(cron, now)) continue;

      if (job.lastRun && Math.abs(job.lastRun - ts) < 60_000) continue;

      job.lastRun = ts;
      job.runCount++;
      job.nextRun = getNextRunTime(job.cron, new Date(ts + 60_000));
      saveJobs();

      console.log(`[cron] 触发定时任务「${job.name}」: ${job.command}`);
      try {
        if (executor) await executor(job.command);
      } catch (e) {
        console.error(`[cron] 执行失败「${job.name}」:`, (e as Error).message);
      }
    }
  }, 30_000);
}

export function stopCronScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  executor = null;
}

export function formatJobList(jobList: CronJob[]): string {
  if (jobList.length === 0) return "暂无定时任务";
  return jobList.map((j, i) => {
    const status = j.enabled ? "启用" : "禁用";
    const next = j.nextRun ? new Date(j.nextRun).toLocaleString("zh-CN") : "未知";
    return `  ${i + 1}. [${status}] ${j.name} — ${j.cron} — 下次: ${next} — 已执行 ${j.runCount} 次`;
  }).join("\n");
}
