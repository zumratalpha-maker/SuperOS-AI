/**
 * 排查已记录的按钮 — 读取 app_knowledge.json 与 learned_actions.jsonl
 * 用法：npx tsx scripts/inspect-learned-buttons.ts
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd());
const APP_KNOWLEDGE = join(ROOT, "data", "app_knowledge.json");
const LEARNED_ACTIONS = join(ROOT, "data", "learned_actions.jsonl");
const AUTOMATION_CACHE = join(ROOT, "data", "automation_success_cache.json");

async function main() {
  console.log("=== Learn UI 已记录按钮排查 ===\n");

  // 1. app_knowledge.json（Learn UI 知识库）
  if (existsSync(APP_KNOWLEDGE)) {
    const raw = await readFile(APP_KNOWLEDGE, "utf8");
    const k = JSON.parse(raw) as { apps?: Record<string, { features?: Record<string, { xRel: number; yRel: number }> }> };
    console.log("【app_knowledge.json】");
    for (const [app, ent] of Object.entries(k?.apps ?? {})) {
      const feats = ent?.features ?? {};
      for (const [feat, v] of Object.entries(feats)) {
        console.log(`  ${app}|${feat}  → (${(v.xRel * 100).toFixed(0)}%, ${(v.yRel * 100).toFixed(0)}%)`);
      }
    }
    console.log("");
  } else {
    console.log("【app_knowledge.json】 不存在（尚未通过 Learn UI 记录）\n");
  }

  // 2. learned_actions.jsonl（自主学习，clickByName 优先使用）
  if (existsSync(LEARNED_ACTIONS)) {
    const raw = await readFile(LEARNED_ACTIONS, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    console.log("【learned_actions.jsonl】");
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as { target: string; xRel: number; yRel: number };
        if (r.target) {
          console.log(`  ${r.target}  → (${(r.xRel * 100).toFixed(0)}%, ${(r.yRel * 100).toFixed(0)}%)`);
        }
      } catch {
        /* skip */
      }
    }
    console.log("");
  } else {
    console.log("【learned_actions.jsonl】 不存在（尚未通过 Learn UI 或 learn-jianying 记录）\n");
  }

  // 3. automation_success_cache.json（成功点击后的缓存）
  if (existsSync(AUTOMATION_CACHE)) {
    const raw = await readFile(AUTOMATION_CACHE, "utf8");
    const cache = JSON.parse(raw) as Record<string, { strategy?: string; data?: { xRel?: number; yRel?: number } }>;
    console.log("【automation_success_cache.json】成功点击缓存");
    for (const [target, v] of Object.entries(cache)) {
      const d = v?.data;
      if (d?.xRel != null && d?.yRel != null) {
        console.log(`  ${target}  → (${(d.xRel * 100).toFixed(0)}%, ${(d.yRel * 100).toFixed(0)}%) [${v.strategy ?? "?"}]`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
