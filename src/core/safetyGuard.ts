/**
 * 安全边界模块 — 敏感操作拦截 + 用户确认机制 + 错峰调度策略
 *
 * 原则：
 * 1. 黑名单操作（删除系统文件、转账、修改注册表等）直接拦截
 * 2. 灰名单操作（下载未知资源、批量文件操作等）需用户确认
 * 3. 白名单操作（打开应用、输入文本、快捷键等）直接放行
 * 4. 错峰调度：高 CPU/带宽 任务自动推迟到空闲时段
 */

// ─── 操作风险分类 ───

export type RiskLevel = "safe" | "caution" | "dangerous" | "blocked";

export interface SafetyCheckResult {
  level: RiskLevel;
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-rf?\s+)?[/\\]/i, reason: "禁止删除根目录" },
  { pattern: /del\s+\/[sq]/i, reason: "禁止静默删除" },
  { pattern: /format\s+[a-z]:/i, reason: "禁止格式化磁盘" },
  { pattern: /reg\s+(delete|add)\s+hk(lm|cr)/i, reason: "禁止修改系统注册表" },
  { pattern: /net\s+user\s+/i, reason: "禁止修改用户账户" },
  { pattern: /bcdedit/i, reason: "禁止修改引导配置" },
  { pattern: /cipher\s+\/w/i, reason: "禁止安全擦除" },
  { pattern: /sfc\s+\/scannow/i, reason: "禁止系统文件检查（需管理员手动）" },
  { pattern: /shutdown\s+[/-][srf]/i, reason: "禁止远程关机/重启" },
  { pattern: /转账|汇款|付款|支付|pay|transfer/i, reason: "禁止自动执行金融操作" },
  { pattern: /密码|password|credential|token/i, reason: "禁止操作凭据信息" },
  { pattern: /System32|system32|SysWOW64/i, reason: "禁止操作系统核心目录" },
];

const CAUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /del\s+|remove-item|rm\s+/i, reason: "文件删除操作" },
  { pattern: /move\s+|mv\s+|ren\s+/i, reason: "文件移动/重命名操作" },
  { pattern: /下载|download/i, reason: "下载操作" },
  { pattern: /安装|install/i, reason: "软件安装操作" },
  { pattern: /uninstall|卸载/i, reason: "软件卸载操作" },
  { pattern: /发布|publish|post|upload/i, reason: "内容发布操作" },
  { pattern: /发送|send/i, reason: "消息发送操作" },
  { pattern: /批量|batch|all\s+files/i, reason: "批量操作" },
  { pattern: /管理员|admin|sudo|runas/i, reason: "提权操作" },
  { pattern: /注册表|regedit|registry/i, reason: "注册表相关操作" },
];

const SAFE_PATTERNS: Array<RegExp> = [
  /^打开\s+/,
  /^搜索\s+/,
  /^点击\s+/,
  /^输入\s+/,
  /^复制|粘贴|全选|保存|撤销|查找/,
  /^帮助|help$/i,
  /^Ctrl\+|Alt\+|Shift\+/,
  /^查看|浏览|预览|阅读/,
  /^截图|screenshot/i,
];

/**
 * 检查操作文本的安全等级
 */
export function checkSafety(actionText: string): SafetyCheckResult {
  const text = (actionText ?? "").trim();
  if (!text) return { level: "safe", allowed: true, requiresConfirmation: false };

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { level: "blocked", allowed: false, reason: `安全拦截：${reason}`, requiresConfirmation: false };
    }
  }

  for (const { pattern, reason } of CAUTION_PATTERNS) {
    if (pattern.test(text)) {
      return { level: "caution", allowed: false, reason, requiresConfirmation: true };
    }
  }

  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(text)) {
      return { level: "safe", allowed: true, requiresConfirmation: false };
    }
  }

  return { level: "safe", allowed: true, requiresConfirmation: false };
}

/**
 * 检查脚本片段是否包含危险命令
 */
export function checkScript(script: string): SafetyCheckResult {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(script)) {
      return { level: "blocked", allowed: false, reason: `脚本安全拦截：${reason}`, requiresConfirmation: false };
    }
  }

  const dangerousKeywords = ["Invoke-WebRequest", "curl", "wget", "Start-Process", "iex", "Invoke-Expression"];
  for (const kw of dangerousKeywords) {
    if (script.includes(kw)) {
      return { level: "caution", allowed: false, reason: `脚本包含 ${kw}`, requiresConfirmation: true };
    }
  }

  return { level: "safe", allowed: true, requiresConfirmation: false };
}

// ─── 错峰调度策略 ───

export interface OffPeakConfig {
  peakHoursStart: number;
  peakHoursEnd: number;
  heavyTaskThreshold: {
    cpuPercent: number;
    bandwidthMbps: number;
  };
}

const DEFAULT_OFFPEAK: OffPeakConfig = {
  peakHoursStart: 9,
  peakHoursEnd: 18,
  heavyTaskThreshold: {
    cpuPercent: 60,
    bandwidthMbps: 50,
  },
};

export type TaskWeight = "light" | "medium" | "heavy";

/**
 * 判断任务权重
 */
export function classifyTaskWeight(kind: string, payload?: Record<string, unknown>): TaskWeight {
  const heavyKinds = ["video_render", "batch_download", "full_pipeline", "image_generation"];
  const mediumKinds = ["download", "web_gen", "resource_hunt", "copywriting"];

  if (heavyKinds.includes(kind)) return "heavy";
  if (mediumKinds.includes(kind)) return "medium";

  if (payload?.fileCount && (payload.fileCount as number) > 10) return "heavy";
  if (payload?.parallel && (payload.parallel as boolean)) return "medium";

  return "light";
}

/**
 * 判断当前是否处于高峰时段
 */
export function isCurrentlyPeakHours(config?: Partial<OffPeakConfig>): boolean {
  const c = { ...DEFAULT_OFFPEAK, ...config };
  const hour = new Date().getHours();
  return hour >= c.peakHoursStart && hour < c.peakHoursEnd;
}

/**
 * 计算推荐的任务启动时间
 * - 轻量级任务：立即执行
 * - 中等任务：高峰时段推迟到 18:00
 * - 重量级任务：推迟到 2:00（凌晨）
 */
export function getRecommendedStartTime(weight: TaskWeight, config?: Partial<OffPeakConfig>): Date | null {
  if (weight === "light") return null;

  const now = new Date();
  const c = { ...DEFAULT_OFFPEAK, ...config };

  if (!isCurrentlyPeakHours(c)) return null;

  if (weight === "medium") {
    const delayedStart = new Date(now);
    delayedStart.setHours(c.peakHoursEnd, 0, 0, 0);
    if (delayedStart <= now) delayedStart.setDate(delayedStart.getDate() + 1);
    return delayedStart;
  }

  const lateNight = new Date(now);
  lateNight.setDate(lateNight.getDate() + 1);
  lateNight.setHours(2, 0, 0, 0);
  return lateNight;
}

// ─── 用户确认白名单（已确认过的操作不再重复问） ───

const confirmedActions = new Set<string>();

export function markAsConfirmed(actionKey: string): void {
  confirmedActions.add(actionKey);
}

export function isAlreadyConfirmed(actionKey: string): boolean {
  return confirmedActions.has(actionKey);
}

export function clearConfirmations(): void {
  confirmedActions.clear();
}

// ─── 操作审计日志 ───

const auditLog: Array<{
  timestamp: number;
  action: string;
  level: RiskLevel;
  allowed: boolean;
  userConfirmed?: boolean;
}> = [];

export function logAudit(action: string, level: RiskLevel, allowed: boolean, userConfirmed?: boolean): void {
  auditLog.push({ timestamp: Date.now(), action, level, allowed, userConfirmed });
  if (auditLog.length > 1000) auditLog.shift();
}

export function getAuditLog(limit = 50): typeof auditLog {
  return auditLog.slice(-limit);
}

/**
 * 综合安全网关 — 在 dispatch 前调用
 * 返回 { proceed: true } 或 { proceed: false, message: "..." }
 */
export function safetyGate(actionText: string): {
  proceed: boolean;
  message?: string;
  needsConfirmation: boolean;
  riskLevel: RiskLevel;
} {
  const check = checkSafety(actionText);

  if (check.level === "blocked") {
    logAudit(actionText, "blocked", false);
    return { proceed: false, message: check.reason, needsConfirmation: false, riskLevel: "blocked" };
  }

  if (check.level === "caution") {
    const key = actionText.slice(0, 60).toLowerCase();
    if (isAlreadyConfirmed(key)) {
      logAudit(actionText, "caution", true, true);
      return { proceed: true, needsConfirmation: false, riskLevel: "caution" };
    }
    logAudit(actionText, "caution", false);
    return {
      proceed: false,
      message: `⚠ ${check.reason}，需要您确认。回复「确认」继续执行，回复「取消」放弃。`,
      needsConfirmation: true,
      riskLevel: "caution",
    };
  }

  logAudit(actionText, "safe", true);
  return { proceed: true, needsConfirmation: false, riskLevel: "safe" };
}
