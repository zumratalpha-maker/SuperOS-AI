# SuperEye Daemon 蓝图

**文档性质**：架构与设计规划，作为万能 AI 无人操作系统「眼睛」层的主线蓝图。  
**目标**：自研 Rust daemon，融合 DirectShell 的持久化 + Terminator 的 locator，保留现有语义快捷键与 Profile 能力。  
**缘起**：DirectShell 不完善，达不到超级 AI 目标；需自研「万能眼睛」实现可操作一切桌面的自动化。  
**生效条件**：在负责人明确回复「Blueprint 审核通过，请开始写代码」之后，再进入实现阶段。

---

## 零、战略背景：为何自研 SuperEye

### 0.1 各项目定位与能力对比

| 项目 | 核心定位 | 桌面「眼睛」能力 | 与我们的关系 |
|------|----------|-----------------|--------------|
| **OpenClaw** (313k⭐) | 多通道 AI 助理：WhatsApp、Telegram、Slack 等 | 无原生 Windows UIA 桌面控制；有 Browser、Canvas | 不在同一赛道 |
| **DirectShell** (IamLumae) | 桌面 UIA daemon，数据库即 API | 有：daemon + SQLite、500ms 树刷新、inject 表、EnumWindows | 可借鉴 daemon 与持久化；**不完善** |
| **Terminator** (1314⭐) | Desktop Playwright，AI 驱动自动化 | 有：Rust + uiautomation、locator、录制、确定性执行 + AI 恢复 | 可借鉴架构与库 |
| **我们 SuperOS** | 万能 AI 无人操作系统 | 有：PowerShell + UIA，C# UiaSniper，按需调用 | 当前实现，**需升级** |

**结论**：DirectShell 不完善，达不到超级 AI 目标。OpenClaw 不做桌面控制主战场。我们的超越点在于更强的「眼睛 + 手」。

### 0.2 各项目可借鉴的核心点

| 项目 | 可借鉴 |
|------|--------|
| **DirectShell** | daemon 常驻、500ms 树 / 2s 窗口枚举、SQLite 作为 API、RawViewWalker |
| **Terminator** | uiautomation、Locator 体系（name/role/automationId/index）、录制 → 确定性脚本、AI 恢复策略 |
| **现有设计** | 语义快捷键优先、剪贴板输入唯一路径、Profile 与窗口别名、双屏/PID 精准匹配 |
| **OpenClaw** | 仅参考编排与工具层组织，不做通道/多端 |

### 0.3 与 OpenClaw 的差异化（超越点）

| 维度 | OpenClaw | 我们 SuperEye + SuperOS |
|------|----------|-------------------------|
| 桌面控制 | 主要是浏览器 + Canvas | 任意 Windows 应用、任意 UIA 控件 |
| 通道与助理 | 25+ 消息通道可选接入 | 非核心 |
| 操作系统能力 | 弱 | 强：启动应用、查窗、操作 UI、多屏 |
| 目标场景 | 个人助理、多端对话 | 万能 AI 无人操作系统 |
| 技术形态 | Node/TS 为主 | Rust daemon + TS 编排 |

**我们不是在「做另一个 OpenClaw」，而是在「做更强的操作系统级自动化」。**

---

## 一、战略共识

| 项目 | 采纳策略 |
|------|----------|
| **OpenClaw** | 方向不同，不必模仿；可学其架构思路，但不做通道/多端主战场 |
| **DirectShell** | daemon + 数据库 + IPC 模式**完全采纳** |
| **Terminator** | Rust 栈、uiautomation、locator、录制与 AI 恢复策略**可复用** |
| **自研 SuperEye** | 以 Rust daemon 为核心，融合上述能力，保留现有语义快捷键与 Profile |

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    J.A.R.V.I.S. / Orchestrator (TS)              │
│   parseIntent → createTask → runA11ySequence → 语义快捷键/Profile  │
└────────────────────────────┬────────────────────────────────────┘
                             │ IPC (stdio JSON-RPC 或 HTTP)
┌────────────────────────────▼────────────────────────────────────┐
│                  SuperEye Daemon (Rust 自研)                       │
│  ┌─────────────┬─────────────┬─────────────┬─────────────────────┐ │
│  │ 窗口枚举     │ 元素树快照   │ 动作执行器  │ 应用 Profile 引擎   │ │
│  │ EnumWindows  │ UIA Tree    │ click/type │ 微信/剪映/记事本    │ │
│  │ 2s 刷新      │ 按需/缓存   │ scroll/drag│ 窗口匹配+等待策略   │ │
│  └─────────────┴─────────────┴─────────────┴─────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 状态：窗口列表缓存 / 元素树缓存 / 句柄有效期校验              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│              Windows UIA (IUIAutomation) + SendInput              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、Phase 1：最小可用 Daemon（2–4 周）

### 3.1 目标

- 提供常驻 daemon，替代当前「每次 spawn PowerShell」的按需扫描
- 窗口枚举 + 按 hwnd 元素树 + click / type / SendKeys
- TS 侧 `directShellBridge` 可切换为 SuperEye 客户端，不可用时回退现有实现

### 3.2 技术选型

| 维度 | 选型 |
|------|------|
| 语言 | Rust |
| UIA 绑定 | `uiautomation` crate 或 `windows` crate 内 UIA 绑定 |
| IPC | stdio JSON-RPC（启动时 `supereye --stdio`）或 HTTP `:9876` |
| 配置 | 同目录 `supereye.json` 或环境变量 |

### 3.3 目录结构（建议）

```
SuperOS/
├── crates/
│   └── supereye/
│       ├── Cargo.toml
│       ├── src/
│       │   ├── lib.rs
│       │   ├── main.rs          # CLI 入口，--stdio / --http / --daemon
│       │   ├── windows.rs       # EnumWindows, 窗口列表
│       │   ├── uia.rs           # UIA 树扫描、元素查找
│       │   ├── actions.rs       # click, type, SendKeys
│       │   ├── ipc.rs           # JSON-RPC 协议
│       │   └── profile.rs       # Phase 2 扩展点
│       └── build.rs
├── src/
│   └── tools/
│       └── supereyeClient.ts    # SuperEye IPC 客户端
└── docs/
    └── SUPEREYE_DAEMON_BLUEPRINT.md
```

### 3.4 IPC 协议（JSON-RPC）

**请求格式**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "windows.list",
  "params": {}
}
```

**方法清单（Phase 1）**：

| method | params | 说明 |
|--------|--------|------|
| `windows.list` | `{}` | 返回所有顶级窗口 |
| `window.find` | `{ "name": "微信", "processId?: number", "excludePids?: number[]" }` | 按名称/PID 查找窗口 |
| `element.tree` | `{ "hwnd": number, "maxDepth?: number" }` | 获取窗口内 UIA 树 |
| `element.find` | `{ "hwnd": number, "locator": { "name?": string, "role?": string, "automationId?": string, "index?": number } }` | 在窗内按 locator 查找元素 |
| `action.click` | `{ "hwnd": number, "locator?": object, "x?: number, "y?: number" }` | 点击（locator 优先，无则用坐标） |
| `action.type` | `{ "hwnd": number, "text": string }` | 剪贴板写入 + Ctrl+V 到前台 |
| `action.keys` | `{ "keys": string }` | 发送快捷键（如 `^s`、`^a`、`^v`） |
| `window.bringFront` | `{ "hwnd": number }` | 置前窗口 |

**响应格式**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

**错误格式**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "window not found" }
}
```

### 3.5 数据结构（TypeScript 侧对应）

```ts
// 窗口信息
interface WindowInfo {
  hwnd: number;
  processId: number;
  name: string;
}

// 元素信息（精简，供定位与操作）
interface ElementInfo {
  hwnd: number;
  name?: string;
  role?: string;
  automationId?: string;
  rect?: { left: number; top: number; right: number; bottom: number };
}

// Locator（多条件，与 Terminator 对齐）
interface Locator {
  name?: string;        // 模糊包含
  role?: string;        // Button, Edit, MenuItem, ...
  automationId?: string;
  index?: number;       // 同类型第几个
}
```

### 3.6 与 directShellBridge 的对接

- 新增 `supereyeClient.ts`：封装 JSON-RPC 调用，提供 `findWindow`、`click`、`type`、`sendKeys`、`bringWindowToFront`。
- `directShellBridge.ts` 内增加**开关**（环境变量 `USE_SUPEREYE=1` 或配置项）：
  - 若开启且 daemon 可用：优先走 SuperEye 客户端
  - 否则：回退现有 PowerShell + UIA 实现
- `runA11ySequence` 与 `executeOneStep` **不修改**，仅底层实现切换。

### 3.7 Phase 1 验收标准

- [ ] `supereye --stdio` 启动后，stdin/stdout 可收发 JSON-RPC
- [ ] `windows.list` 返回当前所有顶级窗口（hwnd, processId, name）
- [ ] `window.find` 支持按名称、PID、excludePids 查找
- [ ] `action.click` 可对指定 hwnd 的 locator 或坐标执行点击
- [ ] `action.type` 通过剪贴板 + Ctrl+V 输入文本
- [ ] `action.keys` 支持 `^s`、`^a`、`^v` 等快捷键
- [ ] `window.bringFront` 正确置前窗口
- [ ] TS 侧 `USE_SUPEREYE=1` 时，打开记事本 + 写 + 保存 全链可跑通

---

## 四、Phase 2：Locator 与 Profile（2–3 周）

### 4.1 Locator 扩展

- 支持 `role`、`automationId`、`index` 组合
- `element.find` 支持多条件 AND
- 可选：`waitFor`（轮询元素出现，超时返回）

### 4.2 应用 Profile

- 内置 Profile：`微信`、`记事本`、`剪映`（窗口匹配规则、启动后等待、excludePids 策略）
- Profile 结构示例：

```json
{
  "微信": {
    "windowNames": ["微信", "WeChat", "wechat"],
    "processName": "WeChat",
    "openWaitMs": 2500,
    "excludePids": [],
    "retryAttempts": 12,
    "retryIntervalMs": 220
  }
}
```

- daemon 在 `window.find` 时优先应用 Profile，TS 侧可传 `app: "微信"` 触发 Profile 逻辑

### 4.3 Phase 2 验收标准

- [ ] 微信打开后能稳定找到窗口（Profile 生效）
- [ ] `element.find` 支持 role + name 组合
- [ ] 可选 `waitFor` 超时返回

---

## 五、Phase 3：性能与确定性（2–3 周）

### 5.1 元素树缓存

- 窗口级缓存，带 TTL（如 500ms）
- 同一 hwnd 短时间内重复请求直接返回缓存

### 5.2 扫描性能目标

- 单次 `windows.list` < 50ms
- 单次 `element.tree`（中等复杂度窗口）< 100ms

### 5.3 工作流录制（扩展点）

- 预留 `action.record` 或独立 `record` 子命令
- 用户操作 → 序列化为 A11y steps JSON，为后续「确定性 + AI 恢复」打基础

---

## 六、Phase 4：万能与复杂应用（持续）

- 扩展 Profile：Office、CAD、专业软件
- 支持按 rect / 相对坐标点击（兜底 UIA 无名控件）
- 可选：轻量 OCR 作为 UIA 补充（Phase 4+）

---

## 七、与现有组件的兼容

| 组件 | 变更 |
|------|------|
| `directShellBridge` | 新增 SuperEye 客户端路径；开关控制优先/回退 |
| `runA11ySequence` | 无变更，继续调用 bridge 抽象 |
| `ExecutionTimingConfig` | 与 daemon 无直接耦合；TS 侧时序逻辑保持不变 |
| `STRONG_SHORTCUT_MAP` / `resolveShortcut` | 保留在 TS 侧，daemon 仅执行 keys，不解析语义 |

---

## 八、实施顺序建议

1. 创建 `crates/supereye` Rust 项目，实现 `windows.list`、`window.find`、`window.bringFront`
2. 实现 `action.click`、`action.type`、`action.keys`
3. 实现 `element.tree`、`element.find`（含基本 locator）
4. 实现 stdio JSON-RPC 协议
5. 实现 TS 侧 `supereyeClient.ts` 与 directShellBridge 开关
6. 端到端验收（记事本、微信）
7. 进入 Phase 2（Profile、waitFor）

---

**以上为《SuperEye Daemon 蓝图》全文。在收到「Blueprint 审核通过，请开始写代码」之前，不进行任何具体逻辑实现。**
