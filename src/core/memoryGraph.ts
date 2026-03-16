/**
 * 知识图谱 — 层6：自我成长中枢
 * SQLite 模拟知识图谱：存储「场景 → 操作 → 结果」关系
 * 支持最优路径查询、成功率统计、能力迁移
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "memory_graph.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(type, name)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node_id INTEGER NOT NULL,
      to_node_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id),
      FOREIGN KEY (to_node_id) REFERENCES nodes(id),
      UNIQUE(from_node_id, to_node_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
  `);
  return db;
}

export type NodeType = "scene" | "action" | "result" | "app" | "preference" | "skill";

export interface GraphNode {
  id: number;
  type: NodeType;
  name: string;
  data: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  id: number;
  fromNodeId: number;
  toNodeId: number;
  relation: string;
  weight: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number | null;
  data: Record<string, unknown> | null;
}

function rowToNode(row: Record<string, unknown>): GraphNode {
  return {
    id: row.id as number,
    type: row.type as NodeType,
    name: row.name as string,
    data: row.data ? JSON.parse(row.data as string) : null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: row.id as number,
    fromNodeId: row.from_node_id as number,
    toNodeId: row.to_node_id as number,
    relation: row.relation as string,
    weight: row.weight as number,
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    avgDurationMs: (row.avg_duration_ms as number) ?? null,
    data: row.data ? JSON.parse(row.data as string) : null,
  };
}

/** 创建或获取节点（upsert） */
export function ensureNode(type: NodeType, name: string, data?: Record<string, unknown>): GraphNode {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO nodes (type, name, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type, name) DO UPDATE SET data = COALESCE(?, data), updated_at = ?
  `).run(type, name, data ? JSON.stringify(data) : null, now, now, data ? JSON.stringify(data) : null, now);

  const row = d.prepare("SELECT * FROM nodes WHERE type = ? AND name = ?").get(type, name) as Record<string, unknown>;
  return rowToNode(row);
}

/** 创建或更新边（关系） */
export function ensureEdge(
  fromNodeId: number,
  toNodeId: number,
  relation: string,
  data?: Record<string, unknown>,
): GraphEdge {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO edges (from_node_id, to_node_id, relation, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_node_id, to_node_id, relation) DO UPDATE SET
      data = COALESCE(?, data),
      updated_at = ?
  `).run(fromNodeId, toNodeId, relation, data ? JSON.stringify(data) : null, now, now, data ? JSON.stringify(data) : null, now);

  const row = d.prepare(
    "SELECT * FROM edges WHERE from_node_id = ? AND to_node_id = ? AND relation = ?",
  ).get(fromNodeId, toNodeId, relation) as Record<string, unknown>;
  return rowToEdge(row);
}

/** 记录一次操作结果（更新成功/失败计数和平均耗时） */
export function recordExecution(
  sceneNode: GraphNode,
  actionNode: GraphNode,
  resultNode: GraphNode,
  options: { success: boolean; durationMs: number; engine?: string },
): void {
  const d = getDb();

  const sceneToAction = ensureEdge(sceneNode.id, actionNode.id, "uses_action");
  const actionToResult = ensureEdge(actionNode.id, resultNode.id, "produces_result");

  const updateEdge = (edge: GraphEdge, success: boolean, dur: number) => {
    const newSucc = edge.successCount + (success ? 1 : 0);
    const newFail = edge.failureCount + (success ? 0 : 1);
    const total = newSucc + newFail;
    const newAvg = edge.avgDurationMs != null
      ? (edge.avgDurationMs * (total - 1) + dur) / total
      : dur;
    const successRate = total > 0 ? newSucc / total : 0;

    d.prepare(`
      UPDATE edges SET
        success_count = ?, failure_count = ?,
        avg_duration_ms = ?, weight = ?,
        updated_at = ?
      WHERE id = ?
    `).run(newSucc, newFail, newAvg, successRate, Date.now(), edge.id);
  };

  updateEdge(sceneToAction, options.success, options.durationMs);
  updateEdge(actionToResult, options.success, options.durationMs);

  if (options.engine) {
    const engineNode = ensureNode("action", `engine:${options.engine}`);
    ensureEdge(actionNode.id, engineNode.id, "executed_by");
  }
}

/** 获取场景的最优操作路径（按 weight 排序） */
export function getBestPath(sceneName: string): Array<{
  action: GraphNode;
  successRate: number;
  avgDurationMs: number | null;
  totalExecutions: number;
}> {
  const d = getDb();
  const scene = d.prepare("SELECT * FROM nodes WHERE type = 'scene' AND name = ?").get(sceneName) as Record<string, unknown> | undefined;
  if (!scene) return [];

  const edges = d.prepare(`
    SELECT e.*, n.id as node_id, n.type as node_type, n.name as node_name, n.data as node_data,
           n.created_at as node_created_at, n.updated_at as node_updated_at
    FROM edges e
    JOIN nodes n ON e.to_node_id = n.id
    WHERE e.from_node_id = ? AND e.relation = 'uses_action'
    ORDER BY e.weight DESC
  `).all((scene as { id: number }).id) as Array<Record<string, unknown>>;

  return edges.map((e) => {
    const total = (e.success_count as number) + (e.failure_count as number);
    return {
      action: {
        id: e.node_id as number,
        type: e.node_type as NodeType,
        name: e.node_name as string,
        data: e.node_data ? JSON.parse(e.node_data as string) : null,
        createdAt: e.node_created_at as number,
        updatedAt: e.node_updated_at as number,
      },
      successRate: total > 0 ? (e.success_count as number) / total : 0,
      avgDurationMs: (e.avg_duration_ms as number) ?? null,
      totalExecutions: total,
    };
  });
}

/** 能力迁移查询：找到与给定场景相似的场景和操作 */
export function findSimilarScenes(sceneName: string): Array<{
  scene: GraphNode;
  sharedActions: number;
}> {
  const d = getDb();
  const scene = d.prepare("SELECT * FROM nodes WHERE type = 'scene' AND name = ?").get(sceneName) as Record<string, unknown> | undefined;
  if (!scene) return [];

  const myActions = d.prepare(`
    SELECT to_node_id FROM edges WHERE from_node_id = ? AND relation = 'uses_action'
  `).all((scene as { id: number }).id) as Array<{ to_node_id: number }>;
  const myActionIds = new Set(myActions.map((a) => a.to_node_id));
  if (myActionIds.size === 0) return [];

  const allScenes = d.prepare("SELECT * FROM nodes WHERE type = 'scene' AND id != ?").all((scene as { id: number }).id) as Array<Record<string, unknown>>;

  const results: Array<{ scene: GraphNode; sharedActions: number }> = [];
  for (const otherScene of allScenes) {
    const otherActions = d.prepare(`
      SELECT to_node_id FROM edges WHERE from_node_id = ? AND relation = 'uses_action'
    `).all(otherScene.id as number) as Array<{ to_node_id: number }>;
    const shared = otherActions.filter((a) => myActionIds.has(a.to_node_id)).length;
    if (shared > 0) {
      results.push({ scene: rowToNode(otherScene), sharedActions: shared });
    }
  }

  return results.sort((a, b) => b.sharedActions - a.sharedActions);
}

/** 获取图谱统计 */
export function getGraphStats(): { nodes: number; edges: number; scenes: number; actions: number } {
  const d = getDb();
  const nodes = (d.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number }).cnt;
  const edges = (d.prepare("SELECT COUNT(*) as cnt FROM edges").get() as { cnt: number }).cnt;
  const scenes = (d.prepare("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'scene'").get() as { cnt: number }).cnt;
  const actions = (d.prepare("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'action'").get() as { cnt: number }).cnt;
  return { nodes, edges, scenes, actions };
}

export function closeMemoryDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
