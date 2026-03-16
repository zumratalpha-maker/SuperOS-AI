/**
 * 执行进度浮窗 — 在桌面右下角显示 always-on-top 的透明窗口
 * 使用 PowerShell + WPF 实现，不依赖 Electron（CLI 模式下也能用）
 *
 * 接口：
 *   showOverlay()   — 显示浮窗
 *   updateOverlay(step, progress, total) — 更新当前步骤和进度
 *   hideOverlay()   — 隐藏浮窗
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let overlayProcess: ChildProcess | null = null;
const PIPE_NAME = "\\\\.\\pipe\\superos_overlay";

const OVERLAY_SCRIPT = `
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$screenW = [System.Windows.SystemParameters]::PrimaryScreenWidth
$screenH = [System.Windows.SystemParameters]::PrimaryScreenHeight

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.Width = 320
$window.Height = 90
$window.Left = $screenW - 340
$window.Top = $screenH - 140
$window.ResizeMode = 'NoResize'

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = New-Object System.Windows.CornerRadius(12)
$border.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(230, 24, 24, 36))
$border.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(40, 255, 255, 255))
$border.BorderThickness = New-Object System.Windows.Thickness(1)
$border.Padding = New-Object System.Windows.Thickness(16, 10, 16, 10)

$panel = New-Object System.Windows.Controls.StackPanel

$title = New-Object System.Windows.Controls.TextBlock
$title.Text = 'SuperOS'
$title.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(120, 255, 255, 255))
$title.FontSize = 11
$title.Margin = New-Object System.Windows.Thickness(0, 0, 0, 4)

$stepText = New-Object System.Windows.Controls.TextBlock
$stepText.Name = 'StepText'
$stepText.Text = 'Ready'
$stepText.Foreground = [System.Windows.Media.Brushes]::White
$stepText.FontSize = 13
$stepText.TextTrimming = 'CharacterEllipsis'

$progressBg = New-Object System.Windows.Controls.Border
$progressBg.Height = 4
$progressBg.CornerRadius = New-Object System.Windows.CornerRadius(2)
$progressBg.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(30, 255, 255, 255))
$progressBg.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)

$progressFill = New-Object System.Windows.Controls.Border
$progressFill.Name = 'ProgressFill'
$progressFill.Height = 4
$progressFill.CornerRadius = New-Object System.Windows.CornerRadius(2)
$progressFill.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(79, 143, 247))
$progressFill.HorizontalAlignment = 'Left'
$progressFill.Width = 0

$progressBg.Child = $progressFill

$panel.Children.Add($title) | Out-Null
$panel.Children.Add($stepText) | Out-Null
$panel.Children.Add($progressBg) | Out-Null
$border.Child = $panel
$window.Content = $border

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
  if ([Console]::In.Peek() -ge 0) {
    $line = [Console]::ReadLine()
    if ($line -eq 'QUIT') { $window.Close(); return }
    if ($line -match '^UPDATE\\|(.*)\\|(.*)$') {
      $stepText.Text = $matches[1]
      $pct = [double]$matches[2]
      $progressFill.Width = $progressBg.ActualWidth * ($pct / 100.0)
    }
  }
})
$timer.Start()

$window.ShowDialog() | Out-Null
`;

const SCRIPT_PATH = join(tmpdir(), "superos_overlay.ps1");

export function showOverlay(): void {
  if (overlayProcess) return;
  if (process.platform !== "win32") return;

  const BOM = "\uFEFF";
  writeFileSync(SCRIPT_PATH, BOM + OVERLAY_SCRIPT, { encoding: "utf-8" });

  overlayProcess = spawn("powershell", [
    "-NoProfile", "-STA",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${SCRIPT_PATH}'`,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  overlayProcess.on("exit", () => {
    overlayProcess = null;
    try { unlinkSync(SCRIPT_PATH); } catch { /* ok */ }
  });

  overlayProcess.on("error", (e) => {
    console.warn("[overlay] 进度浮窗启动失败:", e.message);
    overlayProcess = null;
  });
}

export function updateOverlay(stepDescription: string, progressPercent: number): void {
  if (!overlayProcess?.stdin?.writable) return;
  const clean = stepDescription.replace(/[|\n\r]/g, " ").slice(0, 60);
  const pct = Math.max(0, Math.min(100, Math.round(progressPercent)));
  const msg = `UPDATE|${clean}|${pct}\n`;
  overlayProcess.stdin.write(Buffer.from(msg, "utf-8"));
}

export function hideOverlay(): void {
  if (!overlayProcess?.stdin?.writable) return;
  overlayProcess.stdin.write(Buffer.from("QUIT\n", "utf-8"));
  overlayProcess = null;
}

/**
 * 便捷函数：执行多步任务时自动管理浮窗
 */
export async function withProgress<T>(
  totalSteps: number,
  fn: (report: (step: number, desc: string) => void) => Promise<T>,
): Promise<T> {
  showOverlay();
  try {
    const result = await fn((step, desc) => {
      updateOverlay(`${step}/${totalSteps} ${desc}`, (step / totalSteps) * 100);
    });
    updateOverlay("完成", 100);
    setTimeout(hideOverlay, 2000);
    return result;
  } catch (e) {
    updateOverlay("失败", 0);
    setTimeout(hideOverlay, 3000);
    throw e;
  }
}
