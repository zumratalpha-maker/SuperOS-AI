# 学习用户操作（Learn from User Operation）

> 由用户手动操作，系统记录动作与上下文，用于完善自动化坐标与流程。

---

## 一、流程

```
用户操作 → [按键记录] → 捕获当前状态 → 写入学习数据 → 完善 automationSuccessCache / jianyingSteps
```

1. 用户启动「学习模式」
2. 用户手动操作（如：打开剪映 → 点开始创作 → 点弹窗开始创作 → 点导入 → …）
3. 每完成一步，用户按 **记录键**（如 F12）
4. 系统捕获：前台窗口 hwnd、标题、尺寸、光标相对坐标、时间戳
5. 可选：用户输入该步语义（如「开始创作」「开始创作(弹窗)」「导入」）
6. 追加写入 `data/learned_operations.jsonl`
7. 事后：解析学习数据，更新 `automationSuccessCache` 或 `docs/automation_memory.md`

---

## 二、学习数据格式（单条）

```json
{
  "timestamp": 1710234567890,
  "sessionId": "jianying_export_20250313",
  "stepIndex": 1,
  "action": "click",
  "semanticTarget": "开始创作",
  "hwnd": 12345678,
  "windowTitle": "剪映专业版",
  "windowRect": { "width": 800, "height": 600 },
  "cursorScreen": { "x": 544, "y": 84 },
  "cursorRelative": { "xRel": 0.68, "yRel": 0.14 }
}
```

---

## 三、实现计划

| 阶段 | 内容 |
|------|------|
| P0 | `npm run learn:start`：监听全局热键（F12），按一次记录一次当前窗口+光标，写入 `data/learned_operations.jsonl` |
| P1 | 记录时弹出简短输入框，让用户填「该步语义」（或从预设列表选） |
| P2 | 解析 `learned_operations`，批量写入 `automationSuccessCache` 或生成 `automation_memory` 记录 |

---

## 四、依赖

- **node-global-key-listener** 或 **iohook** 等：监听 F12 等全局热键（Windows）
- 或 **PowerShell** 轮询 `GetAsyncKeyState` 实现简单热键检测
- **user32.dll**：`GetForegroundWindow`、`GetCursorPos`、`GetWindowRect`（已有 directShellBridge 类似逻辑）

---

## 五、与现有组件的衔接

- `trajectoryRecorder`：格式不同，可扩展为支持「用户触发的轨迹」
- `automationSuccessCache`：学习到的 `{ target, strategy: "coordinate", data: { xRel, yRel } }` 直接写入
- `automation_memory.md`：学习到的坐标与语义可追加为「有效策略」

---

*创建于 2026-03-13，用于剪映等应用的坐标与流程学习。*
