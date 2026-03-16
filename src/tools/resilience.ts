/**
 * 自愈机制工具：失败重试、超时处理、备用方案
 * 供 orchestrator 及后续 Agent 封装外部调用使用，所有内部异步均 try-catch + 日志
 */

/** 重试选项 */
export interface RetryOptions {
  /** 最大尝试次数（含首次） */
  maxAttempts: number;
  /** 首次失败后等待毫秒数 */
  delayMs?: number;
  /** 是否指数退避：每轮等待时间 = delayMs * (backoffFactor ^ attempt) */
  backoff?: boolean;
  /** 退避系数，默认 2 */
  backoffFactor?: number;
}

/**
 * 失败重试：对 fn 执行最多 maxAttempts 次，失败则按 delayMs/backoff 等待后重试
 * @param fn 无参、返回 Promise<T> 的异步函数
 * @param options 重试配置
 * @returns 首次成功时的结果；全部失败则抛出最后一次错误并打日志
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, delayMs = 1000, backoff = false, backoffFactor = 2 } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        console.error(`[resilience] withRetry 第 ${attempt}/${maxAttempts} 次失败: ${msg}`);
      } catch (_) {
        /* 日志失败不向外抛 */
      }
      if (attempt === maxAttempts) break;
      const wait = backoff ? delayMs * Math.pow(backoffFactor, attempt - 1) : delayMs;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  try {
    console.error(`[resilience] withRetry 已用尽 ${maxAttempts} 次尝试，最后错误:`, lastError);
  } catch (_) {}
  throw lastError;
}

/**
 * 超时处理：在 timeoutMs 内完成 fn，否则 reject 并打日志
 * @param fn 无参、返回 Promise<T> 的异步函数
 * @param timeoutMs 超时毫秒数
 * @returns fn 在超时前完成则返回结果；超时则抛出 Error 并记录日志
 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    try {
      timeoutId = setTimeout(() => {
        try {
          console.error(`[resilience] withTimeout 超时 (${timeoutMs}ms)`);
        } catch (_) {}
        reject(new Error(`操作超时 (${timeoutMs}ms)`));
      }, timeoutMs);
    } catch (err) {
      try {
        console.error("[resilience] withTimeout 设置定时器异常:", err);
      } catch (_) {}
      reject(err);
    }
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    if (timeoutId != null) clearTimeout(timeoutId);
    return result;
  } catch (err) {
    if (timeoutId != null) clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * 备用方案：先执行 primary，失败则执行 fallback；两者均失败则抛出并打日志
 * @param primary 主方案（无参、返回 Promise<T>）
 * @param fallback 备用方案（无参、返回 Promise<T>）
 * @returns primary 或 fallback 的成功结果；都失败则抛出 fallback 的错误并记录 primary 失败原因
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  let primaryError: unknown;
  try {
    return await primary();
  } catch (err) {
    primaryError = err;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      console.error(`[resilience] withFallback 主方案失败: ${msg}`);
    } catch (_) {}
  }
  try {
    return await fallback();
  } catch (err) {
    try {
      console.error("[resilience] withFallback 备用方案也失败; 主方案错误:", primaryError);
    } catch (_) {}
    throw err;
  }
}
