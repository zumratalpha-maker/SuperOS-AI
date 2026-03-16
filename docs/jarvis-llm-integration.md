# Jarvis LLM 接入方案

## 目标

将 `jarvis.ts` 中死板的关键词匹配替换为：**用户输入自然语言 → LLM 解析为 createTask 所需的 JSON**，再创建任务并执行。

---

## 1. 需要引入的依赖

| 依赖 | 用途 | 安装 |
|------|------|------|
| **openai** | 调用 OpenAI API（或兼容接口），支持结构化输出 | `npm install openai` |
| 或 **@anthropic-ai/sdk** | 调用 Claude API | `npm install @anthropic-ai/sdk` |

**二选一即可**。若使用本地 / 自托管模型（如 Ollama），可用 `openai` 包 + `baseURL` 指向本地，或直接用 `fetch` 发 HTTP 请求。

**环境变量**（按所选供应商配置其一）：

- `OPENAI_API_KEY` 或
- `ANTHROPIC_API_KEY` 或
- 自托管时 `OPENAI_BASE_URL`（如 `http://localhost:11434/v1`）

---

## 2. 意图类型（与 createTask 对齐）

当前 Orchestrator 支持的任务 payload 示例：

```ts
// 来自 src/agents/orchestrator.ts
interface SnapshotAndClickReviewPayload {
  kind: "snapshot_and_click_review";
  targetApp: string;
  buttonName: string;
}
```

LLM 只需把用户自然语言解析为上述结构；后续若有新 `kind`，在 prompt 和类型里扩展即可。

---

## 3. 代码改造方案

### 3.1 新增模块：意图解析

**文件**：`src/jarvis/parseIntent.ts`（或 `src/tools/llmIntent.ts`）

**职责**：

- 输入：用户原始字符串 `input: string`
- 输出：`Promise<SnapshotAndClickReviewPayload | { kind: "run_next" } | null>`
  - `SnapshotAndClickReviewPayload`：直接传给 `createTask(payload)`，再 `runNextTask(snapshotAndClickStep)`
  - `{ kind: "run_next" }`：仅执行“下一个待办”，不创建新任务
  - `null`：无法解析，Jarvis 回复“未识别”等

**实现要点**：

- 使用 **system prompt** 约定输出格式，例如只返回 JSON，且仅包含 `kind`、`targetApp`、`buttonName` 等字段。
- 可选：OpenAI 的 `response_format: { type: "json_object" }` 或 Claude 的 structured output，减少解析失败。
- 在模块内 `try/catch`，失败时返回 `null`，避免拖垮 CLI。

### 3.2 修改 jarvis.ts

**当前**：`dispatch(input)` 里 `if (t === "点搜索") ... else if (t === "点扩展") ...`。

**改造后**：

1. 若 `input.trim()` 为空，直接 return。
2. 调用 `parseIntent(input)`（async）。
3. 若结果为 `SnapshotAndClickReviewPayload`：
   - 打印 J.A.R.V.I.S. 回复（如“好的，先生，正在为您执行…”）
   - `createTask(result)`
   - `runNextTask(snapshotAndClickStep).catch(...)`
4. 若结果为 `{ kind: "run_next" }`：
   - 打印“正在执行下一个待办…”
   - `runNextTask(snapshotAndClickStep).catch(...)`
5. 若结果为 `null`：
   - 打印“未识别的指令…”或 LLM 返回的简短说明。

**保持**：readline 循环、`say()`、`JARVIS_PREFIX` 等交互逻辑不变，仅把“意图识别”从关键词换成 `parseIntent()`。

### 3.3 调用链小结

```
用户输入 → parseIntent(input) → createTask(payload) + runNextTask(step)
                ↓
         LLM API（OpenAI/Claude/本地） + 固定 JSON schema
```

---

## 4. 示例：parseIntent 的 prompt 草图

```text
你是指令解析器。用户用自然语言发出对 Cursor 界面的操作指令，你只输出一段合法 JSON，不要其他内容。

允许的 JSON 形式：
1. 点击类：{"kind":"snapshot_and_click_review","targetApp":"cursor","buttonName":"<按钮名>"}
   - 按钮名示例：Search、Extensions、Review、Agents
2. 仅执行下一个待办：{"kind":"run_next"}

若无法解析或与上述不符，只输出：{"kind":null}
```

模型返回后做 `JSON.parse`，校验 `kind` 再决定是 `createTask`、仅 `runNextTask` 还是当未识别处理。

---

## 5. 后续可做

- 在 `parseIntent` 内接入 `costTracker` 统计 token 或调用次数。
- 支持更多 `kind`（如 `snapshot_only`、`type_text`）时，在 payload 类型和 prompt 里同步扩展即可。
