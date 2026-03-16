/**
 * TTS 语音反馈模块
 * 使用 Windows SAPI 朗读文本，让系统执行结果可通过语音反馈给用户
 */

import { spawn } from "node:child_process";

let ttsEnabled = process.env.TTS_ENABLED === "1";

export function setTtsEnabled(enabled: boolean): void {
  ttsEnabled = enabled;
}

export function isTtsEnabled(): boolean {
  return ttsEnabled;
}

/**
 * 朗读文本（Windows SAPI）
 * 非阻塞，不等待朗读完成；Windows 下使用 PowerShell + SAPI.SpVoice
 */
export function speak(text: string): void {
  if (!ttsEnabled || !text?.trim() || process.platform !== "win32") return;

  const clean = text.trim().slice(0, 200).replace(/"/g, "'").replace(/\n/g, "，");
  const script = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; $s.Speak("${clean}")`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
    windowsHide: true,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

/**
 * 朗读文本（异步等待完成）
 */
export function speakAsync(text: string, timeoutMs = 10000): Promise<void> {
  if (!ttsEnabled || !text?.trim() || process.platform !== "win32") {
    return Promise.resolve();
  }

  const clean = text.trim().slice(0, 200).replace(/"/g, "'").replace(/\n/g, "，");
  const script = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; $s.Speak("${clean}")`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: timeoutMs,
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/** 快捷反馈（常用语音回复预设） */
export const VOICE_REPLIES = {
  done: "已完成。",
  failed: "操作失败，请查看日志。",
  thinking: "正在处理中，请稍候。",
  hello: "你好，先生，请问需要什么帮助？",
  notUnderstood: "抱歉，我没有理解您的指令。",
  loginRequired: "需要您手动登录，请在浏览器中完成登录。",
  planCreated: "计划已创建，等待执行。",
} as const;

export function speakReply(key: keyof typeof VOICE_REPLIES): void {
  speak(VOICE_REPLIES[key]);
}
