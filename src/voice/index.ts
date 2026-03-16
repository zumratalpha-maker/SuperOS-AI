/**
 * 语音模块：唤醒词 + 简单命令 → JSON Action + TTS 反馈
 * 阶段 1–2：文本命令 → JSON → 执行；唤醒词占位
 * 阶段 3：TTS 语音反馈（Windows SAPI）
 */

export {
  parseVoiceCommandToAction,
  executeVoiceAction,
  type VoiceAction,
} from "./voiceToAction.js";
export { detectWakeWord } from "./wakeWord.js";
export {
  speak,
  speakAsync,
  speakReply,
  setTtsEnabled,
  isTtsEnabled,
  VOICE_REPLIES,
} from "./tts.js";
export {
  recognizeOnce,
  startListening,
  stopListening,
  isListening,
} from "./localAsr.js";
