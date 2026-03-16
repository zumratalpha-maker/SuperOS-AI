# 语音模块接口设计（预留）

本文档定义「语音指令 → JSON Action」的接口规范，供 Phase 2 及以后实现。**当前阶段仅预留设计，不实现具体识别逻辑。**

---

## 1. 目标

- **输入**：用户通过麦克风说出唤醒词 + 简单命令（如「打开设置」「点击保存」）。
- **输出**：严格的 **JSON Action Schema**，与 DirectShell 及无障碍 API 对齐，供 MCP/Agent 层调用执行。
- **原则**：Local-First，所有语音与指令数据不出本地；可选 Ollama 做语义理解时也仅本地推理。

---

## 2. 数据流（概览）

```
麦克风 → 唤醒词检测（本地）→ 命令片段 → 本地解析 / Ollama fallback → JSON Action → MCP/DirectShell 执行
```

- **唤醒词**：在本地用轻量模型或规则检测，不依赖云端。
- **命令解析**：优先规则映射（关键词 → action + target）；复杂句式可走 Ollama 本地模型，输出固定 JSON 结构。
- **执行**：仅将 JSON 交给现有 DirectShell MCP 工具（如 `ds_click`、`ds_text`、`ds_key` 等），不在此模块内操作 UI。

---

## 3. JSON Action Schema（与 DirectShell 对齐）

语音模块**只产出**如下结构的 JSON，不关心具体执行实现。

### 3.1 点击

```json
{
  "action": "click",
  "target_accessibility_id": "元素名或 accessibility_id",
  "params": {}
}
```

### 3.2 输入文本

```json
{
  "action": "text",
  "target_accessibility_id": "可选，输入框标识",
  "params": { "text": "要输入的字符串" }
}
```

### 3.3 按键（快捷键等）

```json
{
  "action": "key",
  "target_accessibility_id": null,
  "params": { "key": "ctrl+s" }
}
```

### 3.4 批量（多步合并）

```json
{
  "action": "batch",
  "target_accessibility_id": null,
  "params": {
    "steps": [
      { "action": "click", "target_accessibility_id": "Save", "params": {} },
      { "action": "key", "target_accessibility_id": null, "params": { "key": "escape" } }
    ]
  }
}
```

### 3.5 约束

- `action` 必填，取值与 DirectShell 工具一致：如 `click`、`text`、`key`、`batch`、`scroll` 等。
- `target_accessibility_id` 可为 null（如全局按键），或为元素名/无障碍 ID。
- `params` 为对象，内容依 action 类型而定；未用到的键可省略。

---

## 4. 语音侧接口（预留）

以下为**接口约定**，具体实现留待 Phase 2。

### 4.1 唤醒词

- **约定**：可配置字符串，例如 `"小牛"` 或 `"DirectShell"`；检测到后进入「听指令」状态。
- **实现方式**：本地轻量唤醒模型或关键词匹配，不上传音频。

### 4.2 命令 → JSON 映射（示例）

| 用户说法（示例）     | 产出 JSON（示例） |
|----------------------|--------------------|
| 「点击保存」         | `{"action":"click","target_accessibility_id":"Save","params":{}}` |
| 「按 Ctrl+S」        | `{"action":"key","target_accessibility_id":null,"params":{"key":"ctrl+s"}}` |
| 「输入 你好」        | `{"action":"text","params":{"text":"你好"}}` |

复杂说法（如「先点保存再关掉窗口」）由 Ollama 或规则引擎产出 `action: "batch"` 的 JSON。

### 4.3 与 MCP / DirectShell 的对接

- 语音模块**仅输出**上述 JSON，不直接调 Windows API。
- 由 Cursor Agent 或本机 Orchestrator 接收该 JSON，再调用 DirectShell MCP 的对应工具（如 `ds_click`、`ds_text`、`ds_key`、`ds_batch`）执行。
- 这样保证：单一数据格式（JSON Action Schema）、执行路径统一（DirectShell），便于测试与扩展。

---

## 5. 隐私与本地化

- 麦克风数据**不离开本机**；唤醒与识别均在本地完成。
- 若使用 Ollama：仅本地部署模型，无外网请求。
- 不依赖任何云端语音服务（如 Azure Speech、Google ASR）除非用户明确要求并自行配置。

---

## 6. 状态

- **Phase 2 阶段 1–2 已实现**：文本命令 → JSON Action → 执行（`parseVoiceCommandToAction`、`executeVoiceAction`）；Jarvis 在 `VOICE_MODE=1` 时优先走语音规则映射。
- **阶段 3 唤醒词**：`detectWakeWord` 为占位实现，返回 false；麦克风采集与 ASR 待后续接入。
- **后续**：逐步扩展命令集、接入 Porcupine / Whisper 等本地语音方案。
