# 按窗口标题（包含关键字）将窗口置前，SetForegroundWindow
# 用法: .\bring_window_front_ps.ps1 -TitlePart "记事本"
param([Parameter(Mandatory=$true)][string]$TitlePart)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Front {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitlePart*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [Win32Front]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  exit 0
}
exit 1
