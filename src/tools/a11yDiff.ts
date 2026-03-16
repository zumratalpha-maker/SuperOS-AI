/**
 * A11y 树差异检测：通过 DirectShell 捕获快照，并对前后状态做差异分析
 */

import type { A11yState, A11yNode } from "./trajectoryRecorder.js";
import { readCurrentA11ySnapshot } from "./directShellBridge.js";

/** 差异检测结果：新增、移除、变更的节点或属性 */
export interface A11yDiffResult {
  added: A11yNode[];
  removed: A11yNode[];
  changed: Array<{ before: A11yNode; after: A11yNode }>;
}

export async function captureA11ySnapshot(): Promise<A11yState> {
  try {
    const snapshot = await readCurrentA11ySnapshot();
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[a11yDiff] captureA11ySnapshot 失败: %s", msg);
    throw err;
  }
}

/** 归一化节点 raw 用于比较（undefined 视为空串） */
function rawOf(n: A11yNode): string {
  return n.raw ?? "";
}

/**
 * 对两个 A11y 快照做差异检测：
 * - added/removed：按索引/数量，多出来的为 added，少掉的为 removed
 * - changed：同一索引位置节点的 raw 文本或状态发生变化则计入 changed
 */
export function diffA11ySnapshots(
  before: A11yState,
  after: A11yState
): A11yDiffResult {
  try {
    const result: A11yDiffResult = {
      added: [],
      removed: [],
      changed: [],
    };

    const beforeNodes = before.nodes;
    const afterNodes = after.nodes;
    const beforeLen = beforeNodes.length;
    const afterLen = afterNodes.length;

    // 同一索引位置：若 raw 内容变化则计入 changed
    const commonLen = Math.min(beforeLen, afterLen);
    for (let i = 0; i < commonLen; i++) {
      const b = beforeNodes[i];
      const a = afterNodes[i];
      if (rawOf(b) !== rawOf(a)) {
        result.changed.push({ before: b, after: a });
      }
    }

    // 多出来的 after 节点视为 added
    for (let i = commonLen; i < afterLen; i++) {
      result.added.push(afterNodes[i]);
    }
    // 少掉的 before 节点视为 removed
    for (let i = commonLen; i < beforeLen; i++) {
      result.removed.push(beforeNodes[i]);
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[a11yDiff] diffA11ySnapshots 失败: %s", msg);
    return { added: [], removed: [], changed: [] };
  }
}
