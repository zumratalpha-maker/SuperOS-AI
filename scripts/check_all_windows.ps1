# 诊断 UIA 顶级窗口 - 查找记事本
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$coll = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

Write-Host "=== 所有顶级窗口 (共 $($coll.Count) 个) ==="
$i = 0
foreach ($w in $coll) {
  try {
    $i++
    $name = $w.Current.Name
    $procId = $w.Current.ProcessId
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "?" }
    if ($procName -like "*notepad*" -or $procName -like "*Notepad*") {
      Write-Host "[$i] ***记事本*** PID=$procId Proc=$procName Name='$name'"
    } else {
      $safeName = if ($null -eq $name) { "" } else { $name }
      $shortName = if ($safeName.Length -gt 40) { $safeName.Substring(0, 40) + "..." } else { $safeName }
      Write-Host "[$i] PID=$procId Proc=$procName Name='$shortName'"
    }
  } catch {
    Write-Host "[$i] 错误: $_"
  }
}
