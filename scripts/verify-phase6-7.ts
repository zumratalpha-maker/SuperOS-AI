/**
 * 验证 Phase 6（安全边界）+ Phase 7（懒加载插件生成）
 */
import "dotenv/config";
import {
  checkSafety,
  checkScript,
  safetyGate,
  classifyTaskWeight,
  isCurrentlyPeakHours,
  getRecommendedStartTime,
  markAsConfirmed,
  getAuditLog,
} from "../src/core/safetyGuard.js";
import { hasGeneratedPluginFor, loadGeneratedPlugins } from "../src/core/pluginGenerator.js";

function assert(ok: boolean, msg: string): void {
  console.log(ok ? `  ✅ ${msg}` : `  ❌ ${msg}`);
}

async function main() {
  console.log("\n=== Phase 6: 安全边界验证 ===\n");

  console.log("1. 黑名单拦截");
  assert(checkSafety("rm -rf /").level === "blocked", "rm -rf / → blocked");
  assert(checkSafety("format C:").level === "blocked", "format C: → blocked");
  assert(checkSafety("帮我转账500元").level === "blocked", "转账 → blocked");
  assert(checkSafety("修改password").level === "blocked", "密码操作 → blocked");
  assert(checkSafety("del System32").level === "blocked", "System32 → blocked");

  console.log("\n2. 灰名单需确认");
  assert(checkSafety("下载这个文件").level === "caution", "下载 → caution");
  assert(checkSafety("del temp.txt").level === "caution", "删除文件 → caution");
  assert(checkSafety("发送邮件给张三").level === "caution", "发送 → caution");
  assert(checkSafety("安装 Node.js").level === "caution", "安装 → caution");

  console.log("\n3. 白名单放行");
  assert(checkSafety("打开记事本").level === "safe", "打开应用 → safe");
  assert(checkSafety("搜索文件").level === "safe", "搜索 → safe");
  assert(checkSafety("Ctrl+S").level === "safe", "快捷键 → safe");
  assert(checkSafety("复制").level === "safe", "复制 → safe");

  console.log("\n4. 脚本安全检查");
  assert(checkScript("Get-Process").level === "safe", "Get-Process → safe");
  assert(checkScript("Invoke-WebRequest http://x.com").level === "caution", "Invoke-WebRequest → caution");
  assert(checkScript("rm -rf /tmp").level === "blocked", "rm -rf → blocked");

  console.log("\n5. 安全网关综合");
  const g1 = safetyGate("打开浏览器");
  assert(g1.proceed === true, "打开浏览器 → proceed");
  const g2 = safetyGate("format D:");
  assert(g2.proceed === false && g2.riskLevel === "blocked", "format D: → blocked");
  const g3 = safetyGate("下载电影");
  assert(g3.proceed === false && g3.needsConfirmation === true, "下载电影 → 需确认");

  console.log("\n6. 确认后放行");
  markAsConfirmed("下载电影");
  const g4 = safetyGate("下载电影");
  assert(g4.proceed === true, "确认后下载电影 → proceed");

  console.log("\n7. 审计日志");
  const log = getAuditLog(10);
  assert(log.length > 0, "审计日志有记录: " + log.length + " 条");

  console.log("\n8. 错峰调度");
  const weight1 = classifyTaskWeight("download");
  assert(weight1 === "medium", "download → medium");
  const weight2 = classifyTaskWeight("video_render");
  assert(weight2 === "heavy", "video_render → heavy");
  const weight3 = classifyTaskWeight("open_app");
  assert(weight3 === "light", "open_app → light");

  const peak = isCurrentlyPeakHours();
  console.log("  当前是否高峰时段:", peak);

  const rec = getRecommendedStartTime("heavy");
  console.log("  重量级任务推荐启动时间:", rec?.toLocaleString() ?? "立即执行");

  console.log("\n=== Phase 7: 懒加载插件生成验证 ===\n");

  console.log("1. 加载已生成插件");
  const count = await loadGeneratedPlugins();
  console.log("  已加载插件数:", count);

  console.log("2. 匹配检查");
  const hasPlugin = hasGeneratedPluginFor("生产短视频");
  console.log("  「生产短视频」是否有匹配插件:", hasPlugin);

  console.log("\n=== 验证完成 ===\n");
}

main().catch(console.error);
