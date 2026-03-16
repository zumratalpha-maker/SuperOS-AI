/**
 * 自进化数据飞轮：轨迹记录系统
 * 将单条轨迹追加写入 data/trajectories/，并提供统计查询；所有 I/O 均 try-catch + 日志
 */

import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 无障碍树单节点（可序列化，供 JSON 存储与 diff 消费） */
export interface A11yNode {
  id?: string;
  role?: string;
  name?: string;
  /** 原始文本行（例如 DirectShell .a11y 中的一行） */
  raw?: string;
  [key: string]: unknown;
}

/** 某一时刻的无障碍树状态快照 */
export interface A11yState {
  timestamp: number;
  nodes: A11yNode[];
}

/** 单条轨迹记录 */
export interface TrajectoryRecord {
  timestamp: number;
  action?: string;
  target?: string;
  beforeState?: A11yState;
  afterState?: A11yState;
  sessionId?: string;
  [key: string]: unknown;
}

/** 写入选项 */
export interface RecordTrajectoryOptions {
  /** 轨迹数据根目录，默认项目根下 data/trajectories */
  dataDir?: string;
}

/** 统计查询选项 */
export interface GetTrajectoryStatsOptions {
  dataDir?: string;
}

/** 轨迹统计结果 */
export interface TrajectoryStats {
  totalRecords: number;
  files: string[];
  timeRange?: { first: number; last: number };
}

const DEFAULT_DATA_DIR = join(process.cwd(), "data", "trajectories");
const FILE_PREFIX = "trajectories";
const FILE_EXT = ".jsonl";

function getDataDir(options?: RecordTrajectoryOptions): string {
  return options?.dataDir ?? DEFAULT_DATA_DIR;
}

function getTodayFilename(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${FILE_PREFIX}_${y}-${m}-${d}${FILE_EXT}`;
}

/**
 * 将单条轨迹记录追加写入 data/trajectories/ 下按日期命名的 JSONL 文件
 * @param record 轨迹记录
 * @param options 可选 dataDir
 */
export async function recordTrajectory(
  record: TrajectoryRecord,
  options?: RecordTrajectoryOptions
): Promise<void> {
  const dataDir = getDataDir(options);
  const filePath = join(dataDir, getTodayFilename());
  const line = JSON.stringify(record) + "\n";

  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[trajectoryRecorder] recordTrajectory mkdir 失败: %s", msg);
    throw err;
  }

  try {
    await appendFile(filePath, line, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[trajectoryRecorder] recordTrajectory appendFile 失败: %s", msg);
    throw err;
  }
}

/**
 * 读取 data/trajectories/ 下所有轨迹文件并返回统计信息
 * @param options 可选 dataDir
 */
export async function getTrajectoryStats(
  options?: GetTrajectoryStatsOptions
): Promise<TrajectoryStats> {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const result: TrajectoryStats = { totalRecords: 0, files: [] };

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[trajectoryRecorder] getTrajectoryStats readdir 失败（目录可能不存在）: %s", msg);
    return result;
  }

  const jsonlFiles = entries.filter(
    (name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_EXT)
  );
  result.files = jsonlFiles;

  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const file of jsonlFiles) {
    const filePath = join(dataDir, file);
    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n").filter((s) => s.trim().length > 0);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as TrajectoryRecord;
          if (typeof rec.timestamp === "number") {
            if (firstTs === undefined || rec.timestamp < firstTs) firstTs = rec.timestamp;
            if (lastTs === undefined || rec.timestamp > lastTs) lastTs = rec.timestamp;
          }
        } catch (_) {
          /* 单行解析失败仅跳过，不中断 */
        }
      }
      result.totalRecords += lines.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[trajectoryRecorder] getTrajectoryStats 读取文件失败 %s: %s", file, msg);
    }
  }

  if (firstTs !== undefined && lastTs !== undefined) {
    result.timeRange = { first: firstTs, last: lastTs };
  }

  return result;
}
