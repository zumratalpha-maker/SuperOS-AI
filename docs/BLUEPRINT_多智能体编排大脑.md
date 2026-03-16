# Blueprint Plan：多智能体编排大脑（自愈层 + 调度层）

本文档为「大脑」建设的实现计划，待用户批准后再编写代码。

---

## 一、思考步骤

1. **目标**：在 DirectShell 执行层就绪前，先搭好多智能体编排的「大脑」——包含自愈机制（resilience）与任务调度（orchestrator），为后续接入 MCP、语音、短视频流水线打基础。
2. **约束**：遵守 .cursorrules——TypeScript 强类型、函数式/声明式、所有外部调用 try-catch + 日志；不输出非 JSON Action 的脚本逻辑到执行层。
3. **依赖**：Node.js + TypeScript 环境；无第三方运行时依赖（仅用标准库 + 自写工具），便于后续与 DirectShell MCP 对接。

---

## 二、交付物 1：`src/tools/resilience.ts`（自愈机制）

### 2.1 职责

为任意异步操作提供三种自愈能力：**失败重试**、**超时处理**、**备用方案**。供 orchestrator 及后续 Agent 调用封装使用。

### 2.2 函数签名与行为（计划）

| 函数 | 用途 | 计划要点 |
|------|------|----------|
| **withRetry** | 失败重试 | 参数：`fn: () => Promise<T>`、`maxAttempts: number`、可选 `delayMs`/`backoff`；失败时按策略重试，全部失败后抛出或返回 Result；内部 try-catch，打日志（含 attempt 序号与 error 信息）。 |
| **withTimeout** | 超时处理 | 参数：`fn: () => Promise<T>`、`timeoutMs: number`；用 Promise.race + setTimeout 实现；超时则 reject 并打日志；外部调用处统一 try-catch + 日志。 |
| **withFallback** | 备用方案 | 参数：`primary: () => Promise<T>`、`fallback: () => Promise<T>`；primary 失败时调用 fallback，两者均失败则抛出并打日志；内部 try-catch 记录 primary 失败原因。 |

### 2.3 规范

- 全部 **TypeScript 强类型**（泛型 `T` 等），导出类型与函数。
- 所有 **内部异步调用** 包在 try-catch 中，**日志** 使用 `console.error` 或项目内统一 logger（若暂无则先用 `console`，预留 logger 注入）。
- **函数式**：纯函数、无副作用封装，参数显式传入配置。

---

## 三、交付物 2：`src/agents/orchestrator.ts`（调度层）

### 3.1 职责

定义**任务状态**（TaskStatus）、**创建任务**（createTask）、以及**基础调度逻辑**（如按状态推进、失败时应用自愈策略），作为多智能体编排的入口。

### 3.2 类型与状态（计划）

- **TaskStatus**：枚举或联合类型，例如 `pending | running | completed | failed | cancelled`（具体命名可与现有 workflow_state 对齐）。
- **Task**：至少包含 `id`、`status: TaskStatus`、`payload`（或 `input`）、`createdAt`、可选 `updatedAt`、`error?: string`。
- **createTask**：接收输入参数，返回 `Task` 对象（含唯一 id、status 初始为 pending）；内部 try-catch，失败时打日志并抛出或返回 Result。

### 3.3 调度逻辑（计划）

- **基础调度**：维护任务列表（内存或后续扩展持久化）；提供「取下一待执行任务」「更新任务状态」等函数。
- **自愈集成**：在「执行任务」的路径上，对**外部调用**（如调用 MCP、调用 DirectShell、调用 LLM）用 `withRetry` / `withTimeout` / `withFallback` 包装；所有对外调用必须 try-catch + 日志。
- 不在本 Blueprint 内实现具体 MCP 调用，仅预留「执行一步」的接口（如 `executeStep(task, step)`），内部使用 resilience 工具。

### 3.4 规范

- **TypeScript 强类型**：Task、TaskStatus、createTask 的入参/返回值均显式类型。
- **中文注释**：关键类型、函数、逻辑分支加简短中文注释。
- **外部调用**：凡调用 resilience、或将来调用 MCP/网络/文件，一律 try-catch 并记录错误日志。

---

## 四、目录与文件结构（计划）

```
src/
  tools/
    resilience.ts     # withRetry, withTimeout, withFallback
  agents/
    orchestrator.ts   # TaskStatus, Task, createTask, 基础调度 + 自愈接入
```

- 若项目尚无 `tsconfig.json` 或 `package.json`，在实现阶段一并补全（仅说明，不在此 Plan 中写具体依赖版本）。

---

## 五、实现顺序（批准后执行）

1. 创建 `src/tools/resilience.ts`，实现并导出 `withRetry`、`withTimeout`、`withFallback`，带类型与中文注释，内部 try-catch + 日志。
2. 创建 `src/agents/orchestrator.ts`，定义 `TaskStatus`、`Task`、`createTask`，实现基础调度逻辑，并在「执行步骤」处接入 resilience 三件套；所有外部调用 try-catch + 日志。
3. 视需要添加 `src/index.ts` 或测试入口，仅做最小导出与调用验证（可选，在实现时决定）。

---

## 六、风险与注意

- **日志**：当前可用 `console`，后续可替换为统一 logger，接口设计时预留。
- **任务存储**：首版仅内存，后续可扩展持久化（如 JSON 文件或 SQLite），不在本 Blueprint 范围。
- **与 DirectShell 的关系**：本模块不依赖 DirectShell 或 MCP 已就绪；调度层预留「执行步骤」接口，待 MCP 可用后注入具体实现。

---

**状态**：本 Blueprint 已输出，等待用户批准。批准后将按上述顺序编写代码，不提前实现。
