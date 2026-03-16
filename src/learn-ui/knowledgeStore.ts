/**
 * 应用知识库 — 存储用户通过语音+视觉教会的应用与功能
 * Local-First，data/app_knowledge.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const KNOWLEDGE_PATH = join(process.cwd(), "data", "app_knowledge.json");

export interface FeatureEntry {
  type: "click";
  xRel: number;
  yRel: number;
  context?: string;
  lastLearned?: number;
}

export interface AppEntry {
  identifiers: string[];
  features: Record<string, FeatureEntry>;
}

export interface AppKnowledge {
  apps: Record<string, AppEntry>;
}

async function ensureDataDir(): Promise<void> {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function loadKnowledge(): Promise<AppKnowledge> {
  try {
    const raw = await readFile(KNOWLEDGE_PATH, "utf8");
    const obj = JSON.parse(raw) as AppKnowledge;
    return obj?.apps ? obj : { apps: {} };
  } catch {
    return { apps: {} };
  }
}

export async function saveKnowledge(k: AppKnowledge): Promise<void> {
  await ensureDataDir();
  await writeFile(KNOWLEDGE_PATH, JSON.stringify(k, null, 2), "utf8");
}

export async function teachFeature(
  appName: string,
  featureName: string,
  xRel: number,
  yRel: number,
  context?: string
): Promise<void> {
  const k = await loadKnowledge();
  if (!k.apps[appName]) {
    k.apps[appName] = { identifiers: [appName], features: {} };
  }
  k.apps[appName].features[featureName] = {
    type: "click",
    xRel,
    yRel,
    context,
    lastLearned: Date.now(),
  };
  await saveKnowledge(k);
}

export async function getFeature(appName: string, featureName: string): Promise<FeatureEntry | null> {
  const k = await loadKnowledge();
  const app = k.apps[appName];
  if (!app) return null;
  return app.features[featureName] ?? null;
}
