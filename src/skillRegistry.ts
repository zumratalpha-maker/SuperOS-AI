/**
 * 技能注册表：Skill 的持久化与执行记录，数据保存在 data/skills/
 * 所有 I/O 均 try-catch + 日志
 */

import { mkdir, writeFile, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

/** 技能实体 */
export interface Skill {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

/** 可选数据目录 */
export interface SkillRegistryOptions {
  dataDir?: string;
}

const DEFAULT_DATA_DIR = join(process.cwd(), "data", "skills");
const EXECUTIONS_FILE = "executions.jsonl";

function getDataDir(options?: SkillRegistryOptions): string {
  return options?.dataDir ?? DEFAULT_DATA_DIR;
}

/**
 * 保存技能到 data/skills/<id>.json
 */
export async function saveSkill(
  skill: Skill,
  options?: SkillRegistryOptions
): Promise<void> {
  const dataDir = getDataDir(options);
  const filePath = join(dataDir, `${skill.id}.json`);
  const payload = { ...skill, updatedAt: Date.now() };

  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] saveSkill mkdir 失败: %s", msg);
    throw err;
  }

  try {
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] saveSkill writeFile 失败: %s", msg);
    throw err;
  }
}

/**
 * 根据 id 读取技能；文件不存在或解析失败返回 undefined
 */
export async function getSkill(
  id: string,
  options?: SkillRegistryOptions
): Promise<Skill | undefined> {
  const dataDir = getDataDir(options);
  const filePath = join(dataDir, `${id}.json`);

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] getSkill readFile 失败 %s: %s", id, msg);
    return undefined;
  }

  try {
    return JSON.parse(content) as Skill;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] getSkill JSON.parse 失败 %s: %s", id, msg);
    throw err;
  }
}

/**
 * 列出所有技能（扫描 data/skills/*.json，排除 executions.jsonl）
 */
export async function listSkills(
  options?: SkillRegistryOptions
): Promise<Skill[]> {
  const dataDir = getDataDir(options);
  const result: Skill[] = [];

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] listSkills readdir 失败: %s", msg);
    return result;
  }

  const jsonFiles = entries.filter(
    (name) => name.endsWith(".json") && name !== EXECUTIONS_FILE
  );

  for (const file of jsonFiles) {
    const filePath = join(dataDir, file);
    try {
      const content = await readFile(filePath, "utf8");
      result.push(JSON.parse(content) as Skill);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[skillRegistry] listSkills 读取失败 %s: %s", file, msg);
    }
  }

  return result;
}

/**
 * 记录一次技能执行，追加到 data/skills/executions.jsonl
 */
export async function recordSkillExecution(
  skillId: string,
  payload?: Record<string, unknown>,
  options?: SkillRegistryOptions
): Promise<void> {
  const dataDir = getDataDir(options);
  const filePath = join(dataDir, EXECUTIONS_FILE);
  const record = { skillId, timestamp: Date.now(), ...payload };
  const line = JSON.stringify(record) + "\n";

  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] recordSkillExecution mkdir 失败: %s", msg);
    throw err;
  }

  try {
    await appendFile(filePath, line, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[skillRegistry] recordSkillExecution appendFile 失败: %s", msg);
    throw err;
  }
}
