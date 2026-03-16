/**
 * 可视化控制面板 API — Express 后端
 * 提供任务看板、进度追踪、知识图谱、习惯统计、日志查询
 */
import "dotenv/config";
import express from "express";
import { join } from "node:path";

import * as taskStore from "../core/taskStore.js";
import * as memoryGraph from "../core/memoryGraph.js";
import * as habit from "../core/habitLearner.js";
import * as sensor from "../core/systemSensor.js";
import { getPluginManager } from "../core/pluginManager.js";
import { getAuditLog, checkSafety } from "../core/safetyGuard.js";
import * as skillLib from "../core/skillLibrary.js";
import { listJobs, addNaturalJob, removeJob, toggleJob } from "../core/cronScheduler.js";

const app = express();
app.use(express.json());
app.use(express.static(join(import.meta.dirname ?? ".", "public")));

// ─── 系统状态 ───

app.get("/api/system", async (_req, res) => {
  const [disk, mem, net, admin] = await Promise.all([
    sensor.getDiskSpace("C"),
    sensor.getMemoryUsage(),
    sensor.getNetworkStatus(),
    sensor.checkAdminPrivilege(),
  ]);
  res.json({ disk, memory: mem, network: net, admin });
});

// ─── 任务管理 ───

app.get("/api/tasks", (_req, res) => {
  const stats = taskStore.getTaskStats();
  const pending = taskStore.getNextPendingTask();
  const waiting = taskStore.getWaitingUserTasks();
  const resumable = taskStore.getResumableTasks();
  const recent = taskStore.getRecentTasks?.(20) ?? [];
  res.json({ stats, nextPending: pending, waitingUser: waiting, resumable, recent });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = taskStore.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  const logs = taskStore.getTaskLogs(req.params.id);
  res.json({ task, logs });
});

app.get("/api/tasks/:id/logs", (req, res) => {
  const logs = taskStore.getTaskLogs(req.params.id);
  res.json(logs);
});

// ─── 知识图谱 ───

app.get("/api/memory/stats", (_req, res) => {
  const stats = memoryGraph.getGraphStats();
  res.json(stats);
});

app.get("/api/memory/best-path/:scene", (req, res) => {
  const paths = memoryGraph.getBestPath(req.params.scene);
  res.json(paths);
});

app.get("/api/memory/similar/:scene", (req, res) => {
  const similar = memoryGraph.findSimilarScenes(req.params.scene);
  res.json(similar);
});

// ─── 习惯学习 ───

app.get("/api/habits/preferences", (_req, res) => {
  const prefs = habit.getAllPreferences();
  res.json(prefs);
});

app.get("/api/habits/sequences", (_req, res) => {
  const seqs = habit.getFrequentSequences(20);
  res.json(seqs);
});

app.get("/api/habits/active-hours", (_req, res) => {
  const hours = habit.getActiveHours();
  res.json(hours);
});

app.get("/api/habits/top-targets", (_req, res) => {
  const tops = habit.getTopTargets(15);
  res.json(tops);
});

app.get("/api/habits/suggestions", (_req, res) => {
  const suggestions = habit.suggestActions();
  res.json(suggestions);
});

// ─── 插件 ───

app.get("/api/plugins", (_req, res) => {
  const pm = getPluginManager();
  res.json(pm.listPlugins());
});

// ─── 安全审计 ───

app.get("/api/security/audit", (_req, res) => {
  const log = getAuditLog(100);
  res.json(log);
});

app.post("/api/security/check", (req, res) => {
  const { action } = req.body as { action?: string };
  if (!action) return res.status(400).json({ error: "缺少 action 参数" });
  const result = checkSafety(action);
  res.json(result);
});

// ─── 技能库 ───

app.get("/api/skills", (req, res) => {
  const page = parseInt(String(req.query.page ?? "1"), 10);
  const pageSize = parseInt(String(req.query.pageSize ?? "20"), 10);
  const result = skillLib.listSkills(page, pageSize);
  res.json(result);
});

app.get("/api/skills/stats", (_req, res) => {
  const stats = skillLib.getStats();
  res.json(stats);
});

app.get("/api/skills/search", (req, res) => {
  const q = String(req.query.q ?? "");
  if (!q) return res.status(400).json({ error: "缺少 q 参数" });
  const skills = skillLib.findSkills(q, 10);
  res.json(skills);
});

app.get("/api/skills/:id", (req, res) => {
  const skill = skillLib.getSkillById(parseInt(req.params.id, 10));
  if (!skill) return res.status(404).json({ error: "技能不存在" });
  res.json(skill);
});

app.delete("/api/skills/:id", (req, res) => {
  skillLib.deleteSkill(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post("/api/skills/cleanup", (_req, res) => {
  const removed = skillLib.cleanupSkills();
  res.json({ removed });
});

// ─── 定时任务 ───

app.get("/api/cron", (_req, res) => {
  res.json(listJobs());
});

app.post("/api/cron", (req, res) => {
  const { time, command } = req.body as { time?: string; command?: string };
  if (!time || !command) return res.status(400).json({ error: "缺少 time 或 command" });
  const job = addNaturalJob(time, command);
  if (!job) return res.status(400).json({ error: `无法解析时间「${time}」` });
  res.json(job);
});

app.delete("/api/cron/:id", (req, res) => {
  const ok = removeJob(req.params.id);
  res.json({ ok });
});

app.patch("/api/cron/:id", (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (enabled !== undefined) toggleJob(req.params.id, enabled);
  res.json({ ok: true });
});

// ─── 前端入口 ───

app.get("/", (_req, res) => {
  res.sendFile(join(import.meta.dirname ?? ".", "public", "index.html"));
});

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3200", 10);

app.listen(PORT, () => {
  console.log(`[dashboard] 控制面板已启动: http://localhost:${PORT}`);
});

export { app };
