# 强焦点盲打：仅用 PowerShell + .NET SendKeys，无 robotjs/Java 依赖
# 用法: .\send_keys_ps.ps1 -Keys "你的文字"  或  .\send_keys_ps.ps1 -Keys "%f"  (Alt+F)
# SendKeys 特殊字符: + ^ % ~ { } [ ] ( ) \  需转义为 {+} {^} {%} {~} {{} {}}
param([Parameter(Mandatory=$true)][string]$Keys)

Add-Type -AssemblyName System.Windows.Forms
try {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
