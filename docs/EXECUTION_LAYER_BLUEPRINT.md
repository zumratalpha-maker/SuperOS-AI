# 全局执行层重构 Blueprint Plan（蓝图规划）

**文档性质**：架构与设计规划，不含具体实现代码。  
**约束**：仅使用 Node 原生能力 + 内联 PowerShell，不引入 robotjs / Java。  
**生效条件**：在负责人明确回复「Blueprint 审核通过，请开始写代码」之后，再进入实现阶段。

---

## 一、现状与问题归纳

| 层级 | 现状 | 痛点 |
|------|------|------|
| **directShellBridge** | UiaSniper → inject → 置前窗口 + SendKeys/剪贴板/快捷键兜底；延迟为分散常量 | 无全局时序；剪贴板与 SendKeys 混用；^s 后 1.5s 仅写在 clickByName 内，编排层不可见 |
| **runA11ySequence** | 按步循环执行，固定 STEP_DELAY_MS / AFTER_OPEN_*；bringAppToFront 仍用临时 .ps1 | 步与步之间无「动作类型感知」延迟；open 后延迟与 directShell 置前延迟重复且不统一 |
| **orchestrator** | runNextTask 用 withTimeout/withRetry/withFallback 包装 stepFn，无步骤间冷却 | 无「上一动作」状态；无法在「刚执行保存」后自动加 1.5s；executeStep 未注入时仅 noop 打日志 |

**全局性塌陷**：时序与延迟散落在 bridge、runA11ySequence、常量三处，没有单一真相源；输入路径存在 SendKeys 与剪贴板并存；语义快捷键与「保存后对话框等待」未形成可复用的协议。

---

## 二、设计目标与原则

1. **单一时序权威**：所有「动作间隔」「动画等待」「保存后对话框等待」由同一套配置与状态驱动，编排层与执行层共用。
2. **输入唯一路径**：文本输入统一为「剪贴板写入 + Ctrl+V」，不再对正文使用 SendKeys 逐字敲击；SendKeys 仅用于快捷键（^s、^a、^v 等）。
3. **语义优先**：凡可映射为系统快捷键的语义（保存、全选等），在底层统一拦截并走快捷键，不依赖 UIA/菜单点击。
4. **零外部脚本**：所有 PowerShell 逻辑内联，通过 `powershell -NoProfile -Command "..."` 执行，不依赖 .ps1 文件或临时脚本。

---

## 三、四大痛点与设计方案

### 3.1 绝对时序与状态机管理（State & Delay Management）

**目标**：建立全局的「动作冷却（Action Cooldown）」与「物理动画等待（Animation Delay）」机制，杜绝光速连续执行导致焦点/对话框丢失。

**思路**：

- **集中配置**：在一个模块（建议 `ExecutionTiming` 或并入 `directShellBridge` 的配置区）中定义所有延迟常量，且命名与语义一一对应：
  - 置前窗口后到可输入/可发键的等待（当前 600ms 级）
  - 未置前时发键前最短等待（当前 180ms 级）
  - 发送 **Ctrl+S** 后、「另存为」对话框完全弹出并抢焦的**生死延迟**（1500ms）
  - 步骤间基础冷却（当前 600ms 级，可与「上一动作类型」结合）
- **执行状态（最小状态机）**：
  - 记录「上一动作类型」：如 `none` | `bring_window` | `type_text` | `send_shortcut` | `shortcut_save`。
  - 当上一动作为 `shortcut_save` 时，**下一步执行前**强制插入 1500ms 等待（或由编排层在「下一步」前调用「等待对话框就绪」）。
- **两种实现策略二选一（Blueprint 阶段不写代码，只定接口）**：
  - **策略 A**：在 **directShellBridge** 内部维护 `lastActionKind` 与 `lastActionAt`，对外提供 `await ensureCooldown()` / `await ensurePostSaveDialogDelay()`，由 **runA11ySequence** 在每步前/后调用。
  - **策略 B**：由 **runA11ySequence**（或更上层的 Jarvis 执行入口）维护「上一步是否为保存」状态，在 `executeOneStep` 中在「下一步开始前」若上一步为保存则 `await delay(1500)`，并统一使用从同一配置模块读取的常量。

**建议**：采用策略 B，将「步骤间延迟」与「保存后 1.5s」放在编排层（runA11ySequence）统一处理，directShellBridge 仅负责单次动作并可在 `clickByName` 成功发送 ^s 时返回「已触发保存」标志，供编排层设置状态。

**需要明确的函数/接口（仅签名与职责）**：

- `getExecutionTimingConfig(): ExecutionTimingConfig`  
  返回：`{ afterBringFrontMs, noBringMs, afterSaveShortcutMs, stepCooldownMs }`，供 bridge 与 runA11ySequence 共用。
- `clickByName(...): Promise<ClickResult>`  
  返回类型包含 `{ done: boolean; triggeredSave?: boolean }`，以便编排层知道是否触发了保存。
- `executeOneStep(step, state?: StepState): Promise<StepState>`  
  接收并返回 `StepState`：`{ lastActionKind, lastTriggeredSave, ... }`；在步与步之间根据 state 与配置执行 `ensureCooldown` / 保存后 1.5s 等待。

---

### 3.2 输入模块的降维重构（Clipboard Injection 剪贴板秒贴）

**目标**：彻底废弃对「正文」的 SendKeys 逐字敲击，统一为 Node 侧写入系统剪贴板 + 置前窗口（若需要）+ 发 Ctrl+V，实现 0 毫秒级无 IME 冲突输入。

**思路**：

- **唯一正文输入路径**：  
  `typeText` 的兜底逻辑只允许一条路：**Set-Clipboard（内联 PowerShell）+ SetForegroundWindow（若需要）+ 物理延迟 + SendKeys('^v')**。  
  不再对 `text` 调用 `SendKeys(text)` 或任何逐字敲击。
- **技术要点**：
  - 剪贴板内容通过内联 PowerShell 的 `Set-Clipboard -Value '...'` 写入，字符串需做 PowerShell 单引号转义（`'` → `''`），不做 SendKeys 转义。
  - 置前窗口与延迟沿用 3.1 的配置（置前后 600ms / 未置前 180ms），再执行「Set-Clipboard + SendKeys('^v')」。
- **保留 runSendKeys 的用途**：仅用于**快捷键**（如 `^s`、`^a`、`^v`），不用于长文本。

**需要明确的函数签名**：

- `runPasteFromClipboard(text: string): Promise<boolean>`  
  内联 PowerShell：Set-Clipboard -Value '<escaped>'; Add-Type ...; SendKeys::SendWait('^v')。  
  转义仅针对 PowerShell 单引号，不调用 escapeSendKeys。
- `typeText(text, target?, options?): Promise<void>`  
  内部：UiaSniper / inject 失败后，仅走「置前 → 延迟 → runPasteFromClipboard(text)」，不再有 SendKeys(正文) 分支。

---

### 3.3 智能语义快捷键拦截（Semantic Hotkey Routing）

**目标**：对极易失败的 UI 点击（如「文件」→「保存」）在底层自动映射为向激活窗口发送 Ctrl+S / Ctrl+A 等全局快捷键，不依赖 UIA 或菜单动画。

**思路**：

- **拦截点**：在 `clickByName` 内，在 UiaSniper / inject 均失败后，**先**根据 `nameOrTarget` 解析出「语义关键字」与「窗口部分」。
- **强映射表**：维护「关键字 → 快捷键」表，优先于通用 MENU_SHORTCUTS；  
  规则示例：名称包含「保存」或「Save」→ `^s`；包含「全选」或「Select All」→ `^a`。  
  可扩展：另存为、打开、新建、退出等。
- **执行顺序**：置前窗口（若有窗口部分）→ 配置的物理延迟 → `runSendKeys(shortcut)` → 若 shortcut 为 `^s`，则由**编排层**或**本层返回 triggeredSave**，由 3.1 的时序层插入 1.5s 等待。

**需要明确的函数签名**：

- `resolveShortcut(keyword: string): string | undefined`  
  先强映射（保存/Save → ^s，全选/Select All → ^a），再 MENU_SHORTCUTS 精确/包含匹配。
- `clickByName(nameOrTarget, options?): Promise<ClickResult>`  
  返回 `{ done: boolean; triggeredSave?: boolean }`，便于上层做「保存后对话框」延迟。

---

### 3.4 安全且无依赖的兜底器（Native Fallback Execute）

**目标**：执行层仅使用 Node 原生能力 + 内联 PowerShell，不引入 robotjs、Java 或任何 .ps1 文件依赖。

**思路**：

- **所有需在 Windows 上执行的逻辑**：
  - 置前窗口：`powershell -NoProfile -Command "Add-Type ...; $p = Get-Process | Where ...; [W]::SetForegroundWindow(...)"`，不调用 `bring_window_front_ps.ps1`。
  - 剪贴板 + Ctrl+V：`powershell -NoProfile -Command "Set-Clipboard -Value '...'; Add-Type ...; SendKeys::SendWait('^v')"`。
  - 仅发快捷键：`powershell -NoProfile -Command "Add-Type ...; SendKeys::SendWait('^s')"` 等。
- **runA11ySequence 中的 bringAppToFront**：与 directShellBridge 对齐，改为内联 PowerShell（或直接调用 bridge 的置前接口），删除「写临时 .ps1 再 -File」的实现。
- **错误与超时**：所有 spawn 的 stderr/stdout 与超时均在 Node 侧捕获并打日志，不静默失败。

**需要明确的函数签名**：

- `runBringWindowToFront(titlePart: string): Promise<boolean>`  
  仅内联 PowerShell，参数做单引号转义，不依赖 scripts 目录下任何文件。
- `runSendKeys(keys: string): Promise<boolean>`  
  keys 仅用于快捷键（如 `^s`、`^a`、`^v`），内联执行，不读临时文件。
- `runPasteFromClipboard(text: string): Promise<boolean>`  
  ？（已在 3.2 中定义）

---

## 四、模块职责与数据流（流程描述）

1. **配置**  
   单一配置源（如 `ExecutionTimingConfig`）提供：置前后延迟、未置前延迟、保存后对话框延迟、步间冷却。  
   directShellBridge 与 runA11ySequence 均从该处读取，不在各自文件内硬编码多套常量。

2. **clickByName 流程**  
   waitForTarget → UiaSniper(click) → runInject(click) → 若失败则解析 keyword/windowPart → resolveShortcut → 若命中则 runBringWindowToFront(若需要) → 延迟(按配置) → runSendKeys(shortcut) → 若 shortcut 为 ^s 则返回 triggeredSave: true；否则返回 done: true/false。

3. **typeText 流程**  
   waitForTarget(若 target) → UiaSniper(text) → runInject(text) → 若失败则 runBringWindowToFront(若需要) → 延迟(按配置) → runPasteFromClipboard(text)，无 SendKeys(正文)。

4. **runA11ySequence 多步流程**  
   维护 stepState（如 lastTriggeredSave）。  
   每步开始前：若 stepState.lastTriggeredSave 为 true，则先 await delay(afterSaveShortcutMs)，再清空该标志。  
   执行 open_app：打开应用 → 置前（内联 PS，不写 .ps1）→ delay(afterOpenDelayMs)。  
   执行 type：按 3.2 只走剪贴板秒贴路径。  
   执行 click：调用 clickByName，若返回 triggeredSave 则 stepState.lastTriggeredSave = true。  
   每步结束后：await delay(stepCooldownMs)。  

5. **orchestrator**  
   仍负责任务状态、重试、超时、fallback；不直接持有「保存后 1.5s」逻辑，由 runA11ySequence（或注入的 ExecuteStepFn）在步骤间根据 stepState 与配置执行延迟。

---

## 五、准备重构的函数与接口清单（仅签名）

以下为需要新增、修改或统一约定的签名，**不包含实现逻辑**。

```ts
// === 配置（可由 directShellBridge 或独立 timing 模块导出） ===
interface ExecutionTimingConfig {
  afterBringFrontMs: number;
  noBringMs: number;
  afterSaveShortcutMs: number;
  stepCooldownMs: number;
}
function getExecutionTimingConfig(): ExecutionTimingConfig;

// === 执行层 bridge ===
function runBringWindowToFront(titlePart: string): Promise<boolean>;
function runSendKeys(keys: string): Promise<boolean>;
function runPasteFromClipboard(text: string): Promise<boolean>;

interface ClickResult {
  done: boolean;
  triggeredSave?: boolean;
}
function clickByName(nameOrTarget: string, options?: DirectShellOptions): Promise<ClickResult>;

function typeText(
  text: string,
  targetOrOptions?: string | DirectShellOptions,
  options?: DirectShellOptions
): Promise<void>;

function resolveShortcut(keyword: string): string | undefined;

// === 编排层 runA11ySequence ===
interface StepState {
  lastTriggeredSave?: boolean;
}
function executeOneStep(step: A11yStep, state?: StepState): Promise<StepState>;
// 内部或导出：在每步前若 state.lastTriggeredSave 则 delay(afterSaveShortcutMs)，并清空
// 每步后 delay(stepCooldownMs)
```
test.txt
---

## 六、验收标准（Blueprint 层）

- 所有「动作间隔」「动画等待」「保存后 1.5s」均来自同一配置，且编排层与执行层行为一致。
- 正文输入仅通过剪贴板 + Ctrl+V，无 SendKeys(长文本)。
- 保存/全选等语义在 clickByName 中强映射为 ^s/^a，并可通过 ClickResult.triggeredSave 驱动保存后延迟。
- 全链路无 .ps1 调用、无 robotjs/Java，仅 Node + 内联 PowerShell。

---

**以上为《全局执行层重构 Blueprint Plan》全文。在收到「Blueprint 审核通过，请开始写代码」之前，不进行任何具体逻辑实现。**
