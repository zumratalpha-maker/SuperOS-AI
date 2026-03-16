/**
 * 可视化控制面板 — Express 后端 API + 静态页面
 * 端口 3200，提供任务看板、知识图谱、习惯统计、系统状态等 API
 */
import "dotenv/config";
import express from "express";
import { join } from "node:path";

import * as taskStore from "../core/taskStore.js";
import * as memoryGraph from "../core/memoryGraph.js";
import * as habit from "../core/habitLearner.js";
import * as sensor from "../core/systemSensor.js";
import { getPluginManager } from "../core/pluginManager.js";

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3200", 10);

app.use(express.json());
app.use(express.static(join(import.meta.dirname, "public")));

// ─── 系统状态 ───
app.get("/api/system", async (_req, res) => {
  const [disk, memory, network] = await Promise.all([
    sensor.getDiskSpace("C"),
    sensor.getMemoryUsage(),
    sensor.getNetworkStatus(),
  ]);
  res.json({ disk, memory, network, timestamp: Date.now() });
});

// ─── 任务 API ───
app.get("/api/tasks/stats", (_req, res) => {
  res.json(taskStore.getTaskStats());
});

app.get("/api/tasks/pending", (_req, res) => {
  const task = taskStore.getNextPendingTask();
  res.json(task ?? null);
});

app.get("/api/tasks/resumable", (_req, res) => {
  res.json(taskStore.getResumableTasks());
});

app.get("/api/tasks/waiting", (_req, res) => {
  res.json(taskStore.getWaitingUserTasks());
});

app.get("/api/tasks/:id", (req, res) => {
  const task = taskStore.getTaskById(req.params.id);
  if (!task) { res.status(404).json({ error: "任务不存在" }); return; }
  const logs = taskStore.getTaskLogs(req.params.id);
  res.json({ ...task, logs });
});

// ─── 知识图谱 API ───
app.get("/api/memory/stats", (_req, res) => {
  res.json(memoryGraph.getGraphStats());
});

app.get("/api/memory/best-path/:scene", (req, res) => {
  const paths = memoryGraph.getBestPath(decodeURIComponent(req.params.scene));
  res.json(paths);
});

app.get("/api/memory/similar/:scene", (req, res) => {
  const similar = memoryGraph.findSimilarScenes(decodeURIComponent(req.params.scene));
  res.json(similar);
});

// ─── 习惯学习 API ───
app.get("/api/habits/preferences", (_req, res) => {
  res.json(habit.getAllPreferences());
});

app.get("/api/habits/sequences", (_req, res) => {
  res.json(habit.getFrequentSequences(20));
});

app.get("/api/habits/active-hours", (_req, res) => {
  res.json(habit.getActiveHours());
});

app.get("/api/habits/top-targets", (_req, res) => {
  res.json(habit.getTopTargets(20));
});

app.get("/api/habits/suggestions", (_req, res) => {
  res.json(habit.suggestActions());
});

// ─── 插件 API ───
app.get("/api/plugins", (_req, res) => {
  res.json(getPluginManager().listPlugins());
});

// ─── 前端页面 ───
app.get("/", (_req, res) => {
  res.sendFile(join(import.meta.dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[dashboard] 控制面板已启动: http://localhost:${PORT}`);
});
