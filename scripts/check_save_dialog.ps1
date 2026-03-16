# 诊断：另存为对话框在 UIA 树中的位置（顶级 vs 子窗口）
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$topLevel = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

Write-Host "=== 1) 顶级窗口中含「另存为/Save As」的 ==="
$found = $false
foreach ($w in $topLevel) {
  try {
    $name = $w.Current.Name
    if ($name -and ($name -like "*另存为*" -or $name -like "*Save As*" -or $name -like "*保存为*")) {
      Write-Host "  [顶级] PID=$($w.Current.ProcessId) Name='$name' Hwnd=$($w.Current.NativeWindowHandle)"
      $found = $true
    }
  } catch {}
}
if (-not $found) { Write-Host "  (无)" }

Write-Host "`n=== 2) 遍历顶级窗口，在其子级中搜索「另存为」==="
foreach ($w in $topLevel) {
  try {
    $pid = $w.Current.ProcessId
    $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
    $pname = if ($p) { $p.ProcessName } else { "?" }
    $wName = $w.Current.Name
    # 在子级中找 Window 类型的「另存为」
    $subWinCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $subs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $subWinCond)
    foreach ($sw in $subs) {
      try {
        $sn = $sw.Current.Name
        if ($sn -and ($sn -like "*另存为*" -or $sn -like "*Save As*" -or $sn -like "*保存为*")) {
          Write-Host "  [子窗口] 父 PID=$pid Proc=$pname 父名='$wName' 子名='$sn' Hwnd=$($sw.Current.NativeWindowHandle)"
          $found = $true
        }
      } catch {}
    }
  } catch {}
}
Write-Host "`n诊断完成。"
