# UiaSniper — 两步精准狙击

- **第一步**：仅遍历 Root 的第一层子节点，`PropertyCondition(ControlType.Window)` + Name 包含窗口名，约 0.01s。
- **第二步**：在目标窗口内 TreeWalker 按 Name 包含元素名查找，深度限制 25，避免全局递归。
- **强力唤醒**：WindowPattern 若最小化则 `SetWindowVisualState(Normal)`，再 `SetForegroundWindow(hwnd)`。
- **Electron 兜底**：InvokePattern 不可用时用 `BoundingRectangle` 中心 + `SendInput` 物理点击。

## 编译 (Windows)

```bat
cd scripts\uia_sniper
csc /target:exe /out:UiaSniper.exe /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\UIAutomationClient.dll" /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\UIAutomationTypes.dll" /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\WindowsBase.dll" UiaSniper.cs
```

或使用 VS Developer Command Prompt 后直接：

```bat
csc /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll /reference:WindowsBase.dll UiaSniper.cs
```

## 用法

```text
UiaSniper.exe click "微信|发送"
UiaSniper.exe text "微信|输入框" "要输入的内容"
UiaSniper.exe scroll "记事本|编辑区" "down"
```

target 格式：`窗口名|元素名`。仅传元素名时在“当前焦点窗口”内查找。
