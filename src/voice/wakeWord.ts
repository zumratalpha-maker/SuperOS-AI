/**
 * 唤醒词检测（占位）
 * 后续可接入 Porcupine / 自定义关键词检测 / VAD+关键词
 * 当前不启用麦克风，仅返回 false 或环境变量模拟值
 */

/** 检测是否捕获到唤醒词；首版占位，不启用麦克风 */
export async function detectWakeWord(): Promise<boolean> {
  try {
    if (process.env.VOICE_WAKE_SIMULATE === "1") return true;
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice] detectWakeWord 异常:", msg);
    return false;
  }
}
