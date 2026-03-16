# 诊断脚本：查看 UIA 中记事本相关窗口的名称
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$coll = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
foreach ($w in $coll) {
  try {
    $name = $w.Current.Name
    $procId = $w.Current.ProcessId
    if ($name -match "无标题|Untitled|记事本|Notepad") {
      Write-Host "PID=$procId Name='$name'"
    }
  } catch {}
}
