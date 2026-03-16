/**
 * 验证 Phase 3：意图解析升级 + 插件化 + 知识图谱 + 习惯学习
 */
import "dotenv/config";

import { parseIntent, type ConversationMessage } from "../src/jarvis/parseIntent.js";
import { getPluginManager } from "../src/core/pluginManager.js";
import * as memoryGraph from "../src/core/memoryGraph.js";
import * as habit from "../src/core/habitLearner.js";
import shortVideoPlugin from "../src/plugins/shortVideoPlugin.js";
import resourcePlugin from "../src/plugins/resourceDownloadPlugin.js";

const DIVIDER = "─".repeat(60);

async function testLongPlanParsing() {
  console.log("\n" + DIVIDER);
  console.log("  [1/4] 长计划意图解析");
  console.log(DIVIDER);

  const cases = [
    "3天内完成《2026产品规划》，收集近1个月行业资料，整理成Word，导出PDF到D盘/规划",
    "下载《Python入门》10集教程，按章节整理到D盘/学习",
    "生产3篇小红书图文，主题高效办公，风格简约，每天19点发布",
  ];

  for (const input of cases) {
    console.log(`\n  输入: "${input.slice(0, 50)}..."`);
    const intent = await parseIntent(input, []);
    if (intent) {
      console.log(`  解析结果: kind=${intent.kind}`);
      if (intent.kind === "long_plan") {
        console.log(`  计划名: ${intent.name}`);
        console.log(`  优先级: ${intent.priority}, 截止: ${intent.deadline ?? "未设定"}`);
        console.log(`  阶段数: ${intent.stages.length}`);
        for (const s of intent.stages) {
          console.log(`    - [${s.kind}] ${s.name}: ${s.description.slice(0, 40)}`);
        }
      }
    } else {
      console.log("  ✗ 解析为 null");
    }
  }
}

async function testPluginManager() {
  console.log("\n" + DIVIDER);
  console.log("  [2/4] 插件管理器");
  console.log(DIVIDER);

  const pm = getPluginManager();
  pm.register(shortVideoPlugin);
  pm.register(resourcePlugin);

  const all = pm.listPlugins();
  console.log(`  已注册插件: ${all.length} 个`);
  for (const p of all) {
    console.log(`    - ${p.id}: ${p.name} (v${p.version})`);
    console.log(`      处理: ${p.supportedKinds.join(", ")}`);
  }

  const match1 = pm.matchByInput("生产一个短视频");
  console.log(`  匹配「短视频」: ${match1 ? match1.manifest.name : "无"}`);

  const match2 = pm.matchByInput("下载Python教程");
  console.log(`  匹配「下载教程」: ${match2 ? match2.manifest.name : "无"}`);

  const byKind = pm.findByKind("generate_content");
  console.log(`  按 kind 查找 generate_content: ${byKind ? byKind.manifest.name : "无"}`);

  console.log("  ✓ 插件管理器测试通过");
}

async function testMemoryGraph() {
  console.log("\n" + DIVIDER);
  console.log("  [3/4] 知识图谱");
  console.log(DIVIDER);

  const scene = memoryGraph.ensureNode("scene", "微信发消息");
  const action1 = memoryGraph.ensureNode("action", "UIA点击联系人");
  const action2 = memoryGraph.ensureNode("action", "快捷键Ctrl+F搜索");
  const result = memoryGraph.ensureNode("result", "发送成功");

  memoryGraph.recordExecution(scene, action1, result, { success: true, durationMs: 2000, engine: "uia" });
  memoryGraph.recordExecution(scene, action1, result, { success: true, durationMs: 1800, engine: "uia" });
  memoryGraph.recordExecution(scene, action1, result, { success: false, durationMs: 5000, engine: "uia" });
  memoryGraph.recordExecution(scene, action2, result, { success: true, durationMs: 1200, engine: "shortcut" });
  memoryGraph.recordExecution(scene, action2, result, { success: true, durationMs: 1100, engine: "shortcut" });

  const best = memoryGraph.getBestPath("微信发消息");
  console.log("  微信发消息最优路径:");
  for (const b of best) {
    console.log(`    ${b.action.name}: 成功率 ${(b.successRate * 100).toFixed(0)}%, 平均 ${b.avgDurationMs?.toFixed(0)}ms (${b.totalExecutions}次)`);
  }

  const stats = memoryGraph.getGraphStats();
  console.log(`  图谱统计: ${stats.nodes} 节点, ${stats.edges} 边, ${stats.scenes} 场景, ${stats.actions} 操作`);
  console.log("  ✓ 知识图谱测试通过");

  memoryGraph.closeMemoryDb();
}

async function testHabitLearner() {
  console.log("\n" + DIVIDER);
  console.log("  [4/4] 习惯学习");
  console.log(DIVIDER);

  for (let i = 0; i < 5; i++) {
    habit.logOperation({ actionType: "open_app", target: "微信", details: { time: Date.now() } });
  }
  for (let i = 0; i < 3; i++) {
    habit.logOperation({ actionType: "web_gen", target: "通义万相", details: { prompt: "测试" } });
  }

  habit.updatePreference("default_save_path", "D:\\工作");
  habit.updatePreference("default_save_path", "D:\\工作");
  habit.updatePreference("default_save_path", "D:\\工作");
  habit.updatePreference("preferred_format", "PDF");
  habit.updatePreference("image_style", "简约");

  const savePref = habit.getPreference("default_save_path");
  console.log(`  偏好 default_save_path: ${savePref?.value ?? "无"} (置信度: ${savePref?.confidence.toFixed(2)})`);

  const allPrefs = habit.getAllPreferences();
  console.log(`  总偏好数: ${allPrefs.length}`);
  for (const p of allPrefs) {
    console.log(`    ${p.key} = ${p.value} (${(p.confidence * 100).toFixed(0)}%)`);
  }

  habit.recordSequence(["open_app 微信", "keys ^f", "type 张三", "keys Enter", "type 你好"], 5000);
  habit.recordSequence(["open_app 微信", "keys ^f", "type 张三", "keys Enter", "type 你好"], 4500);
  habit.recordSequence(["open_app 记事本", "type 内容", "click 保存"], 3000);

  const seqs = habit.getFrequentSequences(5);
  console.log(`  常用操作序列: ${seqs.length} 个`);
  for (const s of seqs) {
    console.log(`    [${s.occurrence}次] ${s.sequence.slice(0, 60)}${s.sequence.length > 60 ? "..." : ""}`);
  }

  const tops = habit.getTopTargets(5);
  console.log(`  最常操作目标:`);
  for (const t of tops) {
    console.log(`    ${t.target}: ${t.count} 次`);
  }

  const suggestions = habit.suggestActions();
  if (suggestions.length > 0) {
    console.log(`  智能推荐:`);
    for (const s of suggestions) {
      console.log(`    ${s.action} — ${s.reason} (${(s.confidence * 100).toFixed(0)}%)`);
    }
  }

  console.log("  ✓ 习惯学习测试通过");
  habit.closeHabitDb();
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         Phase 3 验证：意图+插件+知识图谱+习惯           ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  await testLongPlanParsing();
  await testPluginManager();
  await testMemoryGraph();
  await testHabitLearner();

  console.log("\n" + DIVIDER);
  console.log("  Phase 3 全部验证完成");
  console.log(DIVIDER + "\n");
}

main().catch(console.error);
