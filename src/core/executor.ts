/**
 * 多维度执行引擎 — 层4：多引擎融合，自动选最优引擎，失败自动降级
 *
 * 引擎优先级：UIA > Puppeteer > 快捷键 > OCR > 模拟输入
 * 对桌面应用走 UIA+快捷键；对网页应用走 Puppeteer；均失败则 OCR→模拟输入
 */

import { recordUiaResult } from "../tools/uiaFailureStats.js";

/** 统一执行动作 */
export interface ExecutionAction {
  type: "click" | "type" | "key" | "scroll" | "upload" | "navigate" | "wait" | "custom";
  target?: string;
  value?: string;
  params?: Record<string, unknown>;
}

/** 执行结果 */
export interface ExecutionResult {
  success: boolean;
  engine: EngineType;
  error?: string;
  duration: number;
  data?: Record<string, unknown>;
}

/** 引擎类型枚举 */
export type EngineType = "uia" | "puppeteer" | "shortcut" | "ocr" | "simulate_input" | "vision";

/** 统一引擎接口：每种引擎都必须实现这些方法 */
export interface IExecutionEngine {
  readonly name: EngineType;
  canHandle(action: ExecutionAction, context: ExecutionContext): boolean;
  execute(action: ExecutionAction, context: ExecutionContext): Promise<ExecutionResult>;
}

/** 执行上下文：当前操作的目标应用、窗口等信息 */
export interface ExecutionContext {
  appName?: string;
  windowTitle?: string;
  isWebApp?: boolean;
  hwnd?: number;
  processId?: number;
  url?: string;
}

// ─── UIA 引擎 ───

class UiaEngine implements IExecutionEngine {
  readonly name: EngineType = "uia";

  canHandle(_action: ExecutionAction, context: ExecutionContext): boolean {
    return !context.isWebApp && process.platform === "win32";
  }

  async execute(action: ExecutionAction, context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const dsb = await import("../tools/directShellBridge.js");
      const target = context.windowTitle || context.appName || "";
      const clickTarget = action.target ? `${target}|${action.target}` : target;
      const opts = context.processId ? { processId: context.processId } : {};

      switch (action.type) {
        case "click": {
          const result = await dsb.clickByName(clickTarget, opts);
          recordUiaResult(target, result.done);
          if (!result.done) throw new Error(`UIA click 失败: ${action.target}`);
          break;
        }
        case "type": {
          await dsb.typeText(action.value ?? "", target);
          break;
        }
        case "key": {
          await dsb.sendKeys(action.value ?? "");
          break;
        }
        default:
          throw new Error(`UIA 不支持 action type: ${action.type}`);
      }

      return { success: true, engine: "uia", duration: Date.now() - start };
    } catch (e) {
      return {
        success: false,
        engine: "uia",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── Puppeteer 引擎 ───

class PuppeteerEngine implements IExecutionEngine {
  readonly name: EngineType = "puppeteer";

  canHandle(_action: ExecutionAction, context: ExecutionContext): boolean {
    return !!context.isWebApp || !!context.url;
  }

  async execute(action: ExecutionAction, context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const bb = await import("../tools/browserBridge.js");
      switch (action.type) {
        case "navigate": {
          // Handled by the specific web gen functions
          break;
        }
        default:
          throw new Error(`Puppeteer engine：通过 browserBridge 的专用函数执行，不走通用 action`);
      }
      return { success: true, engine: "puppeteer", duration: Date.now() - start };
    } catch (e) {
      return {
        success: false,
        engine: "puppeteer",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── 快捷键引擎 ───

const SHORTCUT_MAP: Record<string, string> = {
  "复制": "^c", "粘贴": "^v", "剪切": "^x", "撤销": "^z",
  "全选": "^a", "保存": "^s", "另存为": "^+s",
  "关闭": "^w", "打印": "^p", "新建": "^n",
  "查找": "^f", "替换": "^h", "导出": "^e",
  "切换窗口": "%{TAB}", "最小化": "#{DOWN}", "最大化": "#{UP}",
};

class ShortcutEngine implements IExecutionEngine {
  readonly name: EngineType = "shortcut";

  canHandle(action: ExecutionAction): boolean {
    if (action.type === "key") return true;
    if (action.type === "click" && action.target && SHORTCUT_MAP[action.target]) return true;
    return false;
  }

  async execute(action: ExecutionAction, _context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const dsb = await import("../tools/directShellBridge.js");
      let keys = "";

      if (action.type === "key") {
        keys = action.value ?? "";
      } else if (action.type === "click" && action.target) {
        keys = SHORTCUT_MAP[action.target] ?? "";
      }

      if (!keys) throw new Error(`无对应快捷键: ${action.target ?? action.value}`);
      await dsb.sendKeys(keys);
      return { success: true, engine: "shortcut", duration: Date.now() - start };
    } catch (e) {
      return {
        success: false,
        engine: "shortcut",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── OCR 引擎 ───

class OcrEngine implements IExecutionEngine {
  readonly name: EngineType = "ocr";

  canHandle(action: ExecutionAction): boolean {
    return action.type === "click" || action.type === "type";
  }

  async execute(action: ExecutionAction, context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const dsb = await import("../tools/directShellBridge.js");

      if (action.type === "click" && action.target) {
        const target = context.windowTitle || context.appName || "";
        const info = await dsb.findWindowByName(target);
        if (!info?.nativeWindowHandle) throw new Error("OCR: 找不到窗口");

        const clickTarget = `${target}|${action.target}`;
        const result = await dsb.clickByName(clickTarget, { targetHwnd: info.nativeWindowHandle });
        if (!result.done) throw new Error(`OCR 兜底 click 失败: ${action.target}`);

        return { success: true, engine: "ocr", duration: Date.now() - start };
      }

      throw new Error(`OCR 不支持 action type: ${action.type}`);
    } catch (e) {
      return {
        success: false,
        engine: "ocr",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── 模拟输入引擎（终极兜底） ───

class SimulateInputEngine implements IExecutionEngine {
  readonly name: EngineType = "simulate_input";

  canHandle(): boolean {
    return process.platform === "win32";
  }

  async execute(action: ExecutionAction, _context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const dsb = await import("../tools/directShellBridge.js");

      switch (action.type) {
        case "type": {
          await dsb.sendKeys(action.value ?? "");
          break;
        }
        case "click": {
          await dsb.sendKeys("{ENTER}");
          break;
        }
        case "key": {
          await dsb.sendKeys(action.value ?? "");
          break;
        }
        default:
          throw new Error(`模拟输入不支持: ${action.type}`);
      }

      return { success: true, engine: "simulate_input", duration: Date.now() - start };
    } catch (e) {
      return {
        success: false,
        engine: "simulate_input",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── Vision 引擎（截图+LLM 定位+模拟点击） ───

class VisionEngine implements IExecutionEngine {
  readonly name: EngineType = "vision";

  canHandle(action: ExecutionAction): boolean {
    return (action.type === "click" || action.type === "type") && process.platform === "win32";
  }

  async execute(action: ExecutionAction, _context: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const vision = await import("./visionEngine.js");

      if (action.type === "click" && action.target) {
        const result = await vision.visionClick(action.target);
        if (!result.success) throw new Error(`Vision 定位失败: ${result.error}`);
        return { success: true, engine: "vision", duration: Date.now() - start };
      }

      if (action.type === "type" && action.value && action.target) {
        const result = await vision.visionTypeText(action.target, action.value);
        if (!result.success) throw new Error(`Vision 输入失败: ${result.error}`);
        return { success: true, engine: "vision", duration: Date.now() - start };
      }

      throw new Error(`Vision 不支持: ${action.type}`);
    } catch (e) {
      return {
        success: false,
        engine: "vision",
        error: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }
}

// ─── 引擎选择器 & 降级链 ───

const allEngines: IExecutionEngine[] = [
  new UiaEngine(),
  new PuppeteerEngine(),
  new ShortcutEngine(),
  new OcrEngine(),
  new SimulateInputEngine(),
  new VisionEngine(),
];

/** 桌面应用引擎链：UIA → 快捷键 → OCR → 模拟输入 → Vision 兜底 */
const DESKTOP_CHAIN: EngineType[] = ["uia", "shortcut", "ocr", "simulate_input", "vision"];

/** 网页应用引擎链：Puppeteer → OCR → 模拟输入 → Vision 兜底 */
const WEB_CHAIN: EngineType[] = ["puppeteer", "ocr", "simulate_input", "vision"];

function getEngineChain(context: ExecutionContext): EngineType[] {
  if (context.isWebApp || context.url) return WEB_CHAIN;
  return DESKTOP_CHAIN;
}

function getEngine(type: EngineType): IExecutionEngine | undefined {
  return allEngines.find((e) => e.name === type);
}

export interface ExecuteOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  chainOverride?: EngineType[];
}

/**
 * 核心执行函数：自动选引擎、失败降级、重试
 */
export async function executeWithFallback(
  action: ExecutionAction,
  context: ExecutionContext,
  options?: ExecuteOptions,
): Promise<ExecutionResult> {
  const chain = options?.chainOverride ?? getEngineChain(context);
  const maxRetries = options?.maxRetries ?? 2;
  const retryDelay = options?.retryDelayMs ?? 800;
  const errors: string[] = [];

  for (const engineType of chain) {
    const engine = getEngine(engineType);
    if (!engine || !engine.canHandle(action, context)) continue;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await engine.execute(action, context);
      if (result.success) {
        if (errors.length > 0) {
          console.log(`[executor] ${engineType} 成功（此前失败引擎: ${errors.join(", ")}）`);
        }
        return result;
      }

      errors.push(`${engineType}(${attempt + 1}): ${result.error}`);
      console.warn(`[executor] ${engineType} 第${attempt + 1}次失败: ${result.error}`);

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
      }
    }
    console.warn(`[executor] ${engineType} 已用尽重试次数，降级到下一引擎`);
  }

  return {
    success: false,
    engine: chain[chain.length - 1] ?? "uia",
    error: `所有引擎失败: ${errors.join(" | ")}`,
    duration: 0,
  };
}

/** 便捷方法：执行点击 */
export function executeClick(
  target: string,
  context: ExecutionContext,
  options?: ExecuteOptions,
): Promise<ExecutionResult> {
  return executeWithFallback({ type: "click", target }, context, options);
}

/** 便捷方法：执行输入 */
export function executeType(
  text: string,
  context: ExecutionContext,
  options?: ExecuteOptions,
): Promise<ExecutionResult> {
  return executeWithFallback({ type: "type", value: text }, context, options);
}

/** 便捷方法：执行快捷键 */
export function executeKey(
  keys: string,
  context: ExecutionContext,
  options?: ExecuteOptions,
): Promise<ExecutionResult> {
  return executeWithFallback({ type: "key", value: keys }, context, options);
}
