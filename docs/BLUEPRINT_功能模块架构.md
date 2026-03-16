# 功能模块架构 — 对标 DirectShell + Terminator + 现有设计

> 自研能力优先，DirectShell 为辅；分层清晰，能力来源明确。  
> **缘起**：DirectShell 不完善，达不到「超级 AI 无人操作系统」的目标，故自研 SuperEye daemon 作为主线。详见 `SUPEREYE_DAEMON_BLUEPRINT.md`。

---

## 一、分层概览

| 层级 | 职责 | 能力来源 |
|------|------|----------|
| **窗口层** | 枚举顶级窗口，名称/PID/hwnd，2s 刷新，内存缓存 | DirectShell + 现有 |
| **元素层** | 按 hwnd 获取 UIA 树，多条件定位 | Terminator locator |
| **执行层** | click、type、scroll、drag、SendKeys | 现有 + DirectShell inject |
| **Profile 层** | 微信/剪映/记事本等应用专用规则 | 自研 |
| **语义层** | 保存→^s、全选→^a 等快捷键映射 | 现有 STRONG_SHORTCUT_MAP |

---

## 二、各层明细

### 2.1 窗口层（Window Layer）

- **能力**：枚举所有顶级窗口，返回 名称 / PID / hwnd
- **刷新**：2s 周期，内存缓存
- **来源**：DirectShell RootElement 扫描 + 现有 `findWindowByName`、`getGlobalSnapshot`
- **现状**：`directShellBridge.ts` 中已有 `findWindowByName`、`runFindWindowByProcessName`、`getGlobalSnapshot`，进程名兜底、句柄缓存

### 2.2 元素层（Element Layer）

- **能力**：按 hwnd 获取 UIA 树，支持多条件定位
- **条件**：name / role / automationId / index / rect
- **来源**：Terminator locator（或自研 PowerShell UIA 脚本）
- **现状**：DirectShell UiaSniper 部分覆盖；SuperEye locator 兜底；自研 `findSaveDialogHwnd`、`findExportDialogHwnd` 用 PowerShell UIA

### 2.3 执行层（Execution Layer）

- **能力**：
  - `click`：坐标点击、元素点击
  - `type`：剪贴板 + Ctrl+V 秒贴
  - `scroll`：上下左右
  - `drag`：拖拽
  - SendKeys：快捷键（^s、%f 等）
- **来源**：现有 `clickByName`、`typeText`、`scroll`、`drag`、`sendKeys` + DirectShell inject
- **现状**：自研 `clickAtClientCoords`、`runSendKeys` 为主，inject 为辅

### 2.4 Profile 层（应用专用）

- **能力**：微信 / 剪映 / 记事本等应用的专用逻辑
- **内容**：
  - 窗口匹配（WINDOW_NAME_ALIASES、APP_TO_PROCESS）
  - 等待策略（open_app 后延迟、导出对话框重试）
  - 控件规则（另存为、导出对话框、微信输入框聚焦）
- **来源**：自研
- **现状**：`runA11ySequence`、`directShellBridge` 中的 `focusWeChatInputBox`、剪映坐标点击、`findSaveDialogHwnd`、`findExportDialogHwnd`

### 2.5 语义层（Semantic Layer）

- **能力**：语义动作 → 快捷键映射
- **示例**：保存→^s、全选→^a、另存为→%fa、文件→%f
- **来源**：现有 `STRONG_SHORTCUT_MAP`、`MENU_SHORTCUTS`
- **现状**：`directShellBridge.ts` 中 `resolveShortcut`，供 `clickByName` 优先走快捷键

---

## 三、能力来源总结

```
DirectShell：窗口枚举、UIA 基础能力（不完善，作为辅助）
Terminator：locator 多条件元素定位
自研：Profile 规则、坐标点击、PowerShell UIA 脚本、语义映射、优先策略
```

---

## 四、与现有代码映射

| 模块 | 文件 | 对应层 |
|------|------|--------|
| 窗口查找 | `directShellBridge.ts` findWindowByName、getGlobalSnapshot | 窗口层 |
| 元素定位 | PowerShell UIA 脚本、SuperEye、UiaSniper | 元素层 |
| 执行 | clickByName、typeText、scroll、drag、sendKeys、clickAtClientCoords | 执行层 |
| Profile | runA11ySequence StepState、WINDOW_NAME_ALIASES、APP_TO_PROCESS、focusWeChatInputBox、剪映坐标 | Profile 层 |
| 语义 | STRONG_SHORTCUT_MAP、MENU_SHORTCUTS、resolveShortcut | 语义层 |

---

## 五、实现优先级（与 Phase 对应）

1. **窗口层**：已有，可补 2s 刷新 + 缓存容量上限
2. **元素层**：扩展自研 PowerShell UIA，减少对 DirectShell UiaSniper 依赖
3. **执行层**：已有，剪映等用自研坐标优先
4. **Profile 层**：按应用扩展（剪映导出、Excel 保存等）
5. **语义层**：已有，按需扩展映射

---

*文档更新于 2026-03-15*
