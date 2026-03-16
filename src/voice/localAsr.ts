/**
 * 本地语音识别（ASR）— 使用 Windows SAPI 语音识别引擎
 *
 * 无需外部依赖（Whisper/Vosk），直接调用 Windows 内置语音识别。
 * 支持中文和英文。
 *
 * 用法：
 *   import { startListening, stopListening, recognizeOnce } from "./voice/localAsr.js";
 *
 *   // 单次识别（说一句话后返回）
 *   const text = await recognizeOnce();
 *
 *   // 持续监听（回调每句话）
 *   startListening((text) => dispatch(text));
 *   stopListening();
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let listenerProcess: ChildProcess | null = null;
let onResultCallback: ((text: string) => void) | null = null;

const ASR_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech

$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recognizer.SetInputToDefaultAudioDevice()

$grammar = New-Object System.Speech.Recognition.DictationGrammar
$recognizer.LoadGrammar($grammar)

$mode = $args[0]

if ($mode -eq "once") {
  try {
    $result = $recognizer.Recognize([TimeSpan]::FromSeconds(10))
    if ($result -and $result.Text) {
      Write-Output "##ASR##$($result.Text)"
    } else {
      Write-Output "##ASR_EMPTY##"
    }
  } catch {
    Write-Output "##ASR_ERROR##$($_.Exception.Message)"
  }
  $recognizer.Dispose()
  exit
}

# continuous mode
Write-Output "##ASR_READY##"

$recognizer.Add_SpeechRecognized({
  param($sender, $e)
  if ($e.Result -and $e.Result.Text -and $e.Result.Confidence -gt 0.4) {
    Write-Output "##ASR##$($e.Result.Text)"
  }
})

$recognizer.Add_SpeechRecognitionRejected({
  # ignored
})

$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq "STOP") { break }
  Start-Sleep -Milliseconds 100
}

$recognizer.RecognizeAsyncCancel()
$recognizer.Dispose()
Write-Output "##ASR_STOPPED##"
`;

function getScriptPath(): string {
  const dir = join(tmpdir(), "superos");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "asr.ps1");
}

function ensureScript(): string {
  const path = getScriptPath();
  const BOM = "\uFEFF";
  writeFileSync(path, BOM + ASR_SCRIPT, { encoding: "utf-8" });
  return path;
}

/**
 * 单次语音识别 — 说一句话后返回识别结果
 * 超时 10 秒自动停止
 */
export function recognizeOnce(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  const scriptPath = ensureScript();
  return new Promise((resolve) => {
    const child = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath}' once`,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });

    child.on("close", () => {
      const lines = stdout.split("\n").map((l) => l.trim());
      const result = lines.find((l) => l.startsWith("##ASR##"));
      if (result) {
        resolve(result.replace("##ASR##", "").trim());
      } else {
        resolve(null);
      }
    });

    child.on("error", () => resolve(null));
    setTimeout(() => { try { child.kill(); } catch {} }, 15000);
  });
}

/**
 * 启动持续语音监听 — 每识别一句话就回调
 */
export function startListening(onResult: (text: string) => void): boolean {
  if (process.platform !== "win32") return false;
  if (listenerProcess) {
    console.warn("[localAsr] 已在监听中，先停止再启动");
    stopListening();
  }

  const scriptPath = ensureScript();
  onResultCallback = onResult;

  listenerProcess = spawn("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-Command",
    `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath}' continuous`,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  listenerProcess.stdout?.on("data", (d: Buffer) => {
    const lines = d.toString("utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("##ASR##") && onResultCallback) {
        const text = line.replace("##ASR##", "").trim();
        if (text.length > 0) {
          console.log(`[localAsr] 识别到: ${text}`);
          onResultCallback(text);
        }
      } else if (line === "##ASR_READY##") {
        console.log("[localAsr] 语音识别就绪，开始监听…");
      }
    }
  });

  listenerProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString("utf-8").trim();
    if (msg) console.warn("[localAsr] stderr:", msg);
  });

  listenerProcess.on("exit", (code) => {
    console.log(`[localAsr] 语音识别进程退出 (code: ${code})`);
    listenerProcess = null;
  });

  listenerProcess.on("error", (e) => {
    console.warn("[localAsr] 启动失败:", e.message);
    listenerProcess = null;
  });

  return true;
}

/**
 * 停止持续监听
 */
export function stopListening(): void {
  if (listenerProcess?.stdin?.writable) {
    listenerProcess.stdin.write(Buffer.from("STOP\n", "utf-8"));
  }
  setTimeout(() => {
    if (listenerProcess) {
      try { listenerProcess.kill(); } catch {}
      listenerProcess = null;
    }
  }, 2000);
  onResultCallback = null;
}

export function isListening(): boolean {
  return listenerProcess !== null;
}
