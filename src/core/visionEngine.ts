/**
 * Vision 轻量兜底引擎 — 截图 + Vision LLM 识别 UI 元素坐标 + 模拟鼠标点击
 *
 * 定位：executor 降级链的最后一环
 * UIA → 快捷键 → OCR → **Vision（本模块）**
 *
 * 原理：
 * 1. PowerShell 截取屏幕/窗口截图
 * 2. 发给 Vision LLM（GPT-4o / Claude / Gemini），让它返回目标元素的像素坐标
 * 3. 用 PowerShell 模拟鼠标点击该坐标
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLOUD_LLM } from "../config/llmConfig.js";

const SCREENSHOTS_DIR = join(tmpdir(), "superos-vision");

function ensureDir(): void {
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// ─── 截图 ───

/**
 * 全屏截图，返回文件路径（PNG）
 */
export function captureFullScreen(): string {
  ensureDir();
  const filePath = join(SCREENSHOTS_DIR, `screen_${Date.now()}.png`);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${filePath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`, { timeout: 10000 });
  return filePath;
}

/**
 * 截取指定窗口区域截图
 */
export function captureWindow(x: number, y: number, w: number, h: number): string {
  ensureDir();
  const filePath = join(SCREENSHOTS_DIR, `win_${Date.now()}.png`);
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$bmp.Save('${filePath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`, { timeout: 10000 });
  return filePath;
}

// ─── Vision LLM 定位 ───

export interface VisionLocateResult {
  found: boolean;
  x: number;
  y: number;
  confidence: number;
  description?: string;
}

/**
 * 用 Vision LLM 在截图中定位指定 UI 元素的像素坐标
 */
export async function locateElementByVision(
  screenshotPath: string,
  targetDescription: string,
): Promise<VisionLocateResult> {
  if (!CLOUD_LLM.apiKey) {
    return { found: false, x: 0, y: 0, confidence: 0, description: "无 Cloud API Key" };
  }

  const imageData = readFileSync(screenshotPath).toString("base64");
  const mimeType = "image/png";

  const systemPrompt = `你是一个精确的 UI 元素定位器。用户会给你一张桌面截图和目标元素描述。
你需要找到该元素在截图中的像素坐标（中心点），返回 JSON：
{"found": true, "x": 数字, "y": 数字, "confidence": 0-1之间的数字, "description": "简短描述元素位置"}
如果找不到，返回：{"found": false, "x": 0, "y": 0, "confidence": 0, "description": "原因"}
只输出 JSON，不要其他文字。`;

  const resp = await fetch(`${CLOUD_LLM.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CLOUD_LLM.apiKey}`,
    },
    body: JSON.stringify({
      model: CLOUD_LLM.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: `请在截图中定位：「${targetDescription}」` },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageData}` } },
          ],
        },
      ],
      max_tokens: 200,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("[vision] LLM 请求失败:", resp.status, errText);
    return { found: false, x: 0, y: 0, confidence: 0, description: `API ${resp.status}` };
  }

  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? "";

  try {
    const codeMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
    const parsed = JSON.parse(codeMatch[1]?.trim() ?? content.trim()) as VisionLocateResult;
    return {
      found: !!parsed.found,
      x: Math.round(parsed.x ?? 0),
      y: Math.round(parsed.y ?? 0),
      confidence: parsed.confidence ?? 0,
      description: parsed.description,
    };
  } catch {
    console.error("[vision] 无法解析 LLM 返回:", content.slice(0, 200));
    return { found: false, x: 0, y: 0, confidence: 0, description: "解析失败" };
  }
}

// ─── 模拟鼠标点击 ───

/**
 * 在指定屏幕坐标处模拟鼠标左键单击
 */
export function clickAtCoordinate(x: number, y: number): void {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MouseSim {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); // LEFTDOWN
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); // LEFTUP
  }
}
'@
[MouseSim]::Click(${x}, ${y})
`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`, { timeout: 5000 });
}

// ─── 组合接口 ───

/**
 * 一键 Vision 点击：截图 → 定位 → 点击
 * 返回是否成功
 */
export async function visionClick(targetDescription: string): Promise<{
  success: boolean;
  x: number;
  y: number;
  confidence: number;
  error?: string;
}> {
  try {
    console.log(`[vision] 截图中…`);
    const screenshot = captureFullScreen();

    console.log(`[vision] 定位「${targetDescription}」…`);
    const result = await locateElementByVision(screenshot, targetDescription);

    try { unlinkSync(screenshot); } catch { /* cleanup */ }

    if (!result.found || result.confidence < 0.3) {
      return {
        success: false,
        x: result.x,
        y: result.y,
        confidence: result.confidence,
        error: result.description ?? "未找到目标元素",
      };
    }

    console.log(`[vision] 找到目标 (${result.x}, ${result.y}) 置信度 ${(result.confidence * 100).toFixed(0)}%，点击中…`);
    clickAtCoordinate(result.x, result.y);

    return { success: true, x: result.x, y: result.y, confidence: result.confidence };
  } catch (e) {
    return { success: false, x: 0, y: 0, confidence: 0, error: (e as Error).message };
  }
}

/**
 * Vision 输入文本：先 visionClick 定位输入框，再用 SendKeys 输入
 */
export async function visionTypeText(
  inputFieldDescription: string,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const click = await visionClick(inputFieldDescription);
  if (!click.success) return { success: false, error: click.error };

  await new Promise((r) => setTimeout(r, 200));

  try {
    const escaped = text.replace(/[+^%~(){}[\]]/g, "{$&}");
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')"`, { timeout: 5000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
