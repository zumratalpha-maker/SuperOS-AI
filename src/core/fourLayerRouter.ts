/**
 * 四层降级执行路由器 (Four-Layer Degradation Router)
 *
 * 架构总览（优先级从高到低）：
 * Layer 1 — 原生接口层 (COM / 项目文件直连 / CLI / Puppeteer)
 * Layer 2 — 结构化界面层 (UIA / 窗口句柄 / SendKeys)
 * Layer 3 — 视觉兜底层 (截图 + Vision LLM + 鼠标模拟)
 * Layer 4 — 系统控制与观测层 (前置校验 / 进程管理 / 成功缓存)
 *
 * Layer 4 贯穿全局：执行前做 preflightCheck，执行后写 successCache
 * Layer 1→2→3 依次降级，每层失败后自动尝试下一层
 */

import type { ExecutionAction, ExecutionResult, ExecutionContext, EngineType } from "./executor.js";
import { executeWithFallback } from "./executor.js";
import { preflightCheck, type PreflightResult } from "./systemSensor.js";
import {
  getCachedSuccess,
  recordSuccess,
  type SuccessEntry,
} from "../tools/automationSuccessCache.js";

// ─── 四层类型定义 ───

/** 四层层级标识 */
export type LayerLevel = "L1_NATIVE" | "L2_STRUCTURED_UI" | "L3_VISION" | "L4_SYSTEM";

/** 四层路由结果 */
export interface FourLayerResult {
  success: boolean;
  layer: LayerLevel;
  engine?: EngineType;
  error?: string;
  duration: number;
  cachedHit: boolean;
  preflightOk: boolean;
  attempts: LayerAttempt[];
}

/** 单层执行尝试记录 */
export interface LayerAttempt {
  layer: LayerLevel;
  engine?: EngineType;
  success: boolean;
  error?: string;
  duration: number;
}

/** 四层路由配置 */
export interface FourLayerConfig {
  /** 是否在执行前做系统前置校验 */
  enablePreflight: boolean;
  /** 是否启用成功路径缓存 */
  enableCache: boolean;
  /** 是否启用视觉兜底层 */
  enableVision: boolean;
  /** Layer 1 引擎链 */
  nativeEngines: EngineType[];
  /** Layer 2 引擎链 */
  structuredEngines: EngineType[];
  /** Layer 3 引擎链 */
  visionEngines: EngineType[];
}

const DEFAULT_CONFIG: FourLayerConfig = {
  enablePreflight: true,
  enableCache: true,
  enableVision: true,
  nativeEngines: ["puppeteer"],
  structuredEngines: ["uia", "shortcut"],
  visionEngines: ["ocr", "vision", "simulate_input"],
};

// ─── 辅助函数 ───

/** 从 cacheEntry 的 strategy 映射到 EngineType */
function cacheStrategyToEngine(strategy: SuccessEntry["strategy"]): EngineType {
  switch (strategy) {
    case "coordinate":
      return "uia";
    case "tab_order":
      return "uia";
    case "shortcut":
      return "shortcut";
    default:
      return "uia";
  }
}

/** 构建 cache 的 lookup key */
function buildCacheKey(action: ExecutionAction, context: ExecutionContext): string {
  const app = context.appName ?? context.windowTitle ?? "";
  const target = action.target ?? action.value ?? "";
  return app ? `${app}|${target}` : target;
}

// ─── 四层路由器 ───

export class FourLayerRouter {
  private config: FourLayerConfig;

  constructor(config?: Partial<FourLayerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 核心调度：四层降级执行
   *
   * 流程：
   * 1. Layer 4 前置校验（系统健康检查）
   * 2. 查询成功路径缓存 → 有命中则直接执行
   * 3. Layer 1 (原生接口) → Layer 2 (结构化UI) → Layer 3 (视觉兜底)
   * 4. 成功后写入缓存
   */
  async dispatch(
    action: ExecutionAction,
    context: ExecutionContext,
  ): Promise<FourLayerResult> {
    const start = Date.now();
    const attempts: LayerAttempt[] = [];
    let preflightOk = true;
    let cachedHit = false;

    // ─── Layer 4: 前置校验 ───
    if (this.config.enablePreflight) {
      const preflight = await this.runPreflight(context);
      preflightOk = preflight.ok;
      if (!preflightOk && preflight.errors.length > 0) {
        console.warn("[FourLayerRouter] 前置校验失败:", preflight.errors);
        // 非致命：仅记录警告，继续执行
      }
    }

    // ─── 查询成功路径缓存 ───
    if (this.config.enableCache) {
      const cacheKey = buildCacheKey(action, context);
      const cached = await getCachedSuccess(cacheKey);
      if (cached) {
        cachedHit = true;
        console.log(`[FourLayerRouter] 缓存命中: ${cacheKey} → ${cached.strategy}`);
        const engine = cacheStrategyToEngine(cached.strategy);
        const result = await executeWithFallback(action, context, {
          chainOverride: [engine],
          maxRetries: 1,
        });
        if (result.success) {
          attempts.push({
            layer: "L2_STRUCTURED_UI",
            engine: result.engine,
            success: true,
            duration: result.duration,
          });
          return {
            success: true,
            layer: "L2_STRUCTURED_UI",
            engine: result.engine,
            duration: Date.now() - start,
            cachedHit: true,
            preflightOk,
            attempts,
          };
        }
        // 缓存策略失败，继续降级
        console.warn(`[FourLayerRouter] 缓存策略失败，降级到逐层执行`);
        attempts.push({
          layer: "L2_STRUCTURED_UI",
          engine,
          success: false,
          error: result.error,
          duration: result.duration,
        });
      }
    }

    // ─── Layer 1: 原生接口层 ───
    const l1Result = await this.tryLayer(
      "L1_NATIVE",
      action,
      context,
      this.config.nativeEngines,
    );
    attempts.push(l1Result);
    if (l1Result.success) {
      await this.recordToCache(action, context, l1Result);
      return this.buildResult(l1Result, start, cachedHit, preflightOk, attempts);
    }

    // ─── Layer 2: 结构化界面层 ───
    const l2Result = await this.tryLayer(
      "L2_STRUCTURED_UI",
      action,
      context,
      this.config.structuredEngines,
    );
    attempts.push(l2Result);
    if (l2Result.success) {
      await this.recordToCache(action, context, l2Result);
      return this.buildResult(l2Result, start, cachedHit, preflightOk, attempts);
    }

    // ─── Layer 3: 视觉兜底层 ───
    if (this.config.enableVision) {
      const l3Result = await this.tryLayer(
        "L3_VISION",
        action,
        context,
        this.config.visionEngines,
      );
      attempts.push(l3Result);
      if (l3Result.success) {
        await this.recordToCache(action, context, l3Result);
        return this.buildResult(l3Result, start, cachedHit, preflightOk, attempts);
      }
    }

    // ─── 全层失败 ───
    const errorSummary = attempts
      .filter((a) => !a.success)
      .map((a) => `${a.layer}(${a.engine ?? "?"}): ${a.error ?? "unknown"}`)
      .join(" | ");

    return {
      success: false,
      layer: "L3_VISION",
      error: `四层降级全部失败: ${errorSummary}`,
      duration: Date.now() - start,
      cachedHit,
      preflightOk,
      attempts,
    };
  }

  /**
   * 尝试在指定层执行动作
   */
  private async tryLayer(
    layer: LayerLevel,
    action: ExecutionAction,
    context: ExecutionContext,
    engines: EngineType[],
  ): Promise<LayerAttempt> {
    const start = Date.now();
    console.log(`[FourLayerRouter] 尝试 ${layer}, 引擎: [${engines.join(",")}]`);

    const result = await executeWithFallback(action, context, {
      chainOverride: engines,
      maxRetries: 1,
    });

    return {
      layer,
      engine: result.engine,
      success: result.success,
      error: result.error,
      duration: Date.now() - start,
    };
  }

  /**
   * Layer 4: 前置校验
   */
  private async runPreflight(context: ExecutionContext): Promise<PreflightResult> {
    try {
      return await preflightCheck({
        needsNetwork: !!context.isWebApp || !!context.url,
      });
    } catch (e) {
      return {
        ok: true,
        warnings: [`前置校验异常: ${(e as Error).message}`],
        errors: [],
      };
    }
  }

  /**
   * 成功后记录到缓存（Layer 4 记忆闭环）
   */
  private async recordToCache(
    action: ExecutionAction,
    context: ExecutionContext,
    attempt: LayerAttempt,
  ): Promise<void> {
    if (!this.config.enableCache) return;
    const cacheKey = buildCacheKey(action, context);
    if (!cacheKey) return;

    try {
      let strategy: SuccessEntry["strategy"] = "coordinate";
      if (attempt.engine === "shortcut") {
        strategy = "shortcut";
      } else if (attempt.engine === "uia") {
        strategy = "tab_order";
      }
      await recordSuccess(cacheKey, strategy, {
        keys: action.value,
      });
      console.log(`[FourLayerRouter] 缓存记录: ${cacheKey} → ${strategy}`);
    } catch (e) {
      console.warn("[FourLayerRouter] 缓存写入失败:", (e as Error).message);
    }
  }

  /**
   * 构建统一结果
   */
  private buildResult(
    attempt: LayerAttempt,
    startTime: number,
    cachedHit: boolean,
    preflightOk: boolean,
    attempts: LayerAttempt[],
  ): FourLayerResult {
    return {
      success: attempt.success,
      layer: attempt.layer,
      engine: attempt.engine,
      error: attempt.error,
      duration: Date.now() - startTime,
      cachedHit,
      preflightOk,
      attempts,
    };
  }
}

// ─── 默认实例与便捷函数 ───

/** 全局默认四层路由器实例 */
const defaultRouter = new FourLayerRouter();

/**
 * 便捷函数：通过四层降级路由执行动作
 */
export function dispatchFourLayer(
  action: ExecutionAction,
  context: ExecutionContext,
): Promise<FourLayerResult> {
  return defaultRouter.dispatch(action, context);
}

/**
 * 便捷函数：四层降级点击
 */
export function fourLayerClick(
  target: string,
  context: ExecutionContext,
): Promise<FourLayerResult> {
  return defaultRouter.dispatch({ type: "click", target }, context);
}

/**
 * 便捷函数：四层降级输入
 */
export function fourLayerType(
  text: string,
  context: ExecutionContext,
): Promise<FourLayerResult> {
  return defaultRouter.dispatch({ type: "type", value: text }, context);
}

/**
 * 便捷函数：四层降级快捷键
 */
export function fourLayerKey(
  keys: string,
  context: ExecutionContext,
): Promise<FourLayerResult> {
  return defaultRouter.dispatch({ type: "key", value: keys }, context);
}
