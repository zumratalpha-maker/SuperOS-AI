/**
 * A11y 树极限压缩：剔除无关节点，只保留可交互元素，极简 Token 发给云端
 * 剔除：IsOffscreen=true、Pane/Group/Thumb/ScrollBar 等布局节点
 * 保留：Window, Button, Edit, MenuItem, ListItem, TabItem 及 raw 中含这些关键词的节点
 */

import type { A11yState, A11yNode } from "./trajectoryRecorder.js";

const KEEP_PATTERNS = [
  /window/i,
  /button/i,
  /edit/i,
  /text/i,
  /menuitem|menu\s+item/i,
  /listitem|list\s+item/i,
  /tabitem|tab\s+item/i,
  /hyperlink|link/i,
  /checkbox/i,
  /radio/i,
  /combobox/i,
  /dialog/i,
];
const DROP_PATTERNS = [
  /pane\b/i,
  /group\b/i,
  /thumb\b/i,
  /scrollbar/i,
  /scroll\s+bar/i,
  /splitbutton/i,
  /pane\s*$/i,
  /layout\s*$/i,
];
const OFFSCREEN_PATTERN = /offscreen|isoffscreen|offscreen\s*=\s*true/i;

function shouldKeep(raw: string): boolean {
  if (!raw || raw.length < 2) return false;
  if (OFFSCREEN_PATTERN.test(raw)) return false;
  for (const re of DROP_PATTERNS) {
    if (re.test(raw)) return false;
  }
  for (const re of KEEP_PATTERNS) {
    if (re.test(raw)) return true;
  }
  return false;
}

/** 从 raw 中提取简短可读标签（Name / LocalizedControlType / AutomationId 的简化） */
function extractLabel(node: A11yNode): string {
  const raw = typeof node.raw === "string" ? node.raw : "";
  const name = typeof node.name === "string" ? node.name.trim() : "";
  if (name && name.length < 80) return name;
  const m = raw.match(/"([^"]+)"/);
  if (m && m[1]) return m[1].slice(0, 64);
  return raw.slice(0, 48);
}

/**
 * 将 A11y 快照压缩为极简 JSON 字符串（仅可交互节点 + 短标签），供云端规划使用
 */
export function compressA11yForCloud(snapshot: A11yState): string {
  const nodes = snapshot.nodes || [];
  const out: Array<{ n: string }> = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const raw = typeof node.raw === "string" ? node.raw : "";
    if (!shouldKeep(raw)) continue;
    const label = extractLabel(node);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ n: label });
  }
  return JSON.stringify(out);
}
