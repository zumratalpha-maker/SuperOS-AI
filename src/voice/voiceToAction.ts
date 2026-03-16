/**
 * 语音命令 → JSON Action → 执行桥接
 * 与 voice_module_spec 对齐，Local-First；规则映射优先，复杂句式走 parseIntent
 */

import { clickByName, typeText, sendKeys } from "../tools/directShellBridge.js";

/** JSON Action Schema（与 voice_module_spec 3.1–3.4 对齐） */
export type VoiceAction =
  | { action: "click"; target_accessibility_id: string; params?: Record<string, unknown> }
  | { action: "text"; target_accessibility_id?: string | null; params: { text: string } }
  | { action: "key"; target_accessibility_id?: null; params: { key: string } }
  | { action: "batch"; target_accessibility_id?: null; params: { steps: VoiceAction[] } };

/** 规则映射：用户说法（关键词） → VoiceAction */
const VOICE_COMMAND_RULES: Array<{
  pattern: RegExp;
  action: () => VoiceAction;
}> = [
  // 点击类
  { pattern: /^点击\s*保存$/i, action: () => ({ action: "click", target_accessibility_id: "保存", params: {} }) },
  { pattern: /^点击\s*文件$/i, action: () => ({ action: "click", target_accessibility_id: "文件", params: {} }) },
  { pattern: /^点击\s*另存为$/i, action: () => ({ action: "click", target_accessibility_id: "另存为", params: {} }) },
  { pattern: /^点击\s*桌面$/i, action: () => ({ action: "click", target_accessibility_id: "桌面", params: {} }) },
  { pattern: /^点击\s*搜索$/i, action: () => ({ action: "click", target_accessibility_id: "Search", params: {} }) },
  { pattern: /^点击\s*扩展$/i, action: () => ({ action: "click", target_accessibility_id: "Extensions", params: {} }) },
  { pattern: /^点击\s*Review$/i, action: () => ({ action: "click", target_accessibility_id: "Review", params: {} }) },
  // 通用点击：在 parseVoiceCommandToAction 循环中通过 m[1] 提取目标，不调用 action
  { pattern: /^点击\s*(.+)$/i, action: () => ({ action: "click", target_accessibility_id: "", params: {} }) },
  // 快捷键类（SendKeys: ^=Ctrl %=Alt +=Shift）
  { pattern: /^按\s*Ctrl\+S$|^按\s*Ctrl加S$|^保存$|^Ctrl\+S$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "^s" } }) },
  { pattern: /^按\s*Ctrl\+C$|^按\s*Ctrl加C$|^复制$|^Ctrl\+C$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "^c" } }) },
  { pattern: /^按\s*Ctrl\+V$|^按\s*Ctrl加V$|^粘贴$|^Ctrl\+V$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "^v" } }) },
  { pattern: /^按\s*Ctrl\+A$|^按\s*Ctrl加A$|^全选$|^Ctrl\+A$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "^a" } }) },
  { pattern: /^按\s*Ctrl\+F$|^按\s*Ctrl加F$|^查找$|^Ctrl\+F$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "^f" } }) },
  { pattern: /^按\s*Enter$|^回车$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "{ENTER}" } }) },
  { pattern: /^按\s*Esc$|^退出$/i, action: () => ({ action: "key", target_accessibility_id: null, params: { key: "{ESC}" } }) },
];

/** 输入 X → { action: "text", params: { text: "X" } } */
const INPUT_PATTERN = /^输入\s+(.+)$/i;

/** 将 key 字符串转为 SendKeys 格式 */
function keyToSendKeys(key: string): string {
  const k = (key ?? "").trim().toLowerCase();
  if (k === "ctrl+s" || k === "ctrl+s") return "^s";
  if (k === "ctrl+c") return "^c";
  if (k === "ctrl+v") return "^v";
  if (k === "ctrl+a") return "^a";
  if (k === "ctrl+f") return "^f";
  if (k === "alt+f" || k === "alt+f4") return k.includes("f4") ? "%{F4}" : "%f";
  if (k === "enter") return "{ENTER}";
  if (k === "esc") return "{ESC}";
  return key;
}

/**
 * 将语音命令文本解析为 VoiceAction（规则映射，简短单步）
 * 仅处理简短命令；复杂多步（如「打开记事本写诗」）返回 null，走 parseIntent
 */
export function parseVoiceCommandToAction(text: string): VoiceAction | null {
  const t = (text ?? "").trim();
  if (!t || t.length > 80) return null;

  const inputMatch = t.match(INPUT_PATTERN);
  if (inputMatch && inputMatch[1]) {
    return { action: "text", target_accessibility_id: undefined, params: { text: inputMatch[1].trim() } };
  }

  for (const rule of VOICE_COMMAND_RULES) {
    if (rule.pattern.test(t)) {
      const m = t.match(rule.pattern);
      if (rule.pattern.source.includes("(.+)")) {
        const sub = m?.[1]?.trim();
        if (sub) return { action: "click", target_accessibility_id: sub, params: {} };
      }
      return rule.action();
    }
  }

  return null;
}

/**
 * 执行 VoiceAction：调用 directShellBridge 的 clickByName / typeText / sendKeys
 */
export async function executeVoiceAction(action: VoiceAction): Promise<boolean> {
  try {
    if (action.action === "click") {
      const result = await clickByName(action.target_accessibility_id);
      return result.done;
    }
    if (action.action === "text") {
      await typeText(action.params.text, "");
      return true;
    }
    if (action.action === "key") {
      const keys = keyToSendKeys(action.params.key);
      return await sendKeys(keys);
    }
    if (action.action === "batch") {
      for (const step of action.params.steps) {
        const ok = await executeVoiceAction(step);
        if (!ok) return false;
      }
      return true;
    }
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice] executeVoiceAction 失败:", msg);
    throw err;
  }
}
