# Jarvis 全域上帝视角重构蓝图

> 总架构师视角：全局审计 + 四支柱方案，不直接写代码，供审核后实施。

---

## 第一阶段：全局架构审计结果

### 1.1 文件与角色（实际路径）

| 文档中提及路径 | 实际路径 / 说明 |
|----------------|-----------------|
| `src/agents/router.ts` | **不存在**。路由决策在 **`src/jarvis/parseIntent.ts`** + **`src/llm/hybridRouter.ts`** 中实现。 |
| `src/agents/orchestrator.ts` | ✅ 存在。任务创建、pending 队列、`runNextTask(stepFn, config)`，自愈用 `withRetry` / `withTimeout` / `withFallback`。 |
| `src/tools/directShellBridge.ts` | ✅ 存在。TS↔C# 桥接、findWindowByName（Root 第一层）、HWND 缓存、clickByName/typeText 兜底。 |
| `src/bin/UiaSniper.cs` | **不存在**。C# 执行器在 **`scripts/uia_sniper/UiaSniper.cs`**，编译产出为 **`target/release/directshell.exe`**。 |
| `src/jarvis.ts` | ✅ 存在。入口、readline 循环、`parseIntent` → 分支分发，**a11y_sequence 时** `createTask` + `runNextTask(a11ySequenceStep, { useStepFallback: false })`。 |

### 1.2 路由层（Brain Fog 根因）

- **入口**：`parseIntent(input, history)`（parseIntent.ts）。
- **混合路由**（HYBRID_ENABLED）：先 `classifyWithLocal(input)` → 得到 `SIMPLE_OS_ACTION` | `CHAT` | `COMPLEX_A11Y_PLANNING`。
- **问题**：本地小模型常把「打开记事本，写一首诗，保存」判成 **SIMPLE_OS_ACTION**，导致**从不进入** COMPLEX_A11Y_PLANNING 分支，也就不会调用 `planWithLocal` / `planWithCloud`，无法产出 `a11y_sequence`。
- **后续**：走「全量 LLM」解析；若返回 null 或解析失败，则 `openTargetFallback` 只解析出「打开记事本」→ 仅执行 open_target，**写/保存步骤从未进入编排**。
- **结论**：路由识别是当前「只打开、不写不保存」的**首要根因**，需在蓝图 2.2 中重点设计。

### 1.3 编排层（Synapse 现状）

- **orchestrator**：`runNextTask(stepFn, config)` 的 `stepFn` 由**调用方传入**；默认 `noopExecuteStep`。
- **jarvis.ts**：对 `intent.kind === "a11y_sequence"` 明确传入 `a11ySequenceStep`，且 `useStepFallback: false`，故**神经已接通**：规划 → createTask(a11y_sequence) → runNextTask(a11ySequenceStep) → executeOneStep 链。
- **断裂点**：当 `parseIntent` 未返回 a11y_sequence 时，jarvis 根本不会走到该分支，故表现为「未注入」实为**上游未产出 a11y_sequence**；若 a11ySequenceStep 内抛错，之前 useStepFallback 会切到 noop（已改为不吞错）。
- **结论**：编排与执行链在「有 a11y_sequence 时」已正确注入；需保证路由 100% 对复合指令产出 a11y_sequence（见 2.2）。

### 1.4 底层视野（Static Blindness 现状）

- **TS 侧**：`runFindWindowFromRoot` 使用 **PowerShell + UIA**：`AutomationElement.RootElement` → `FindAll(Children, ControlType.Window)`，只扫**第一层子节点**（顶级窗口），再按 Name 模糊匹配 + 可选 PID；结果写 JSON 落盘再读回。有 `handleCache`（IsWindow 校验）+ `findWindowByAppWithRetry` / 窗口名别名。
- **C# 侧**：UiaSniper 同样 **RootElement** → `FindAll(Children, Window)`，`MAX_TOP_LEVEL=512`，名称包含匹配 + PID 过滤；窗口内用 **TreeWalker** 按层查找元素，`MAX_DEPTH=25`，已避免暴力全树递归。
- **问题**：「另存为」对话框弹出后，需在**新顶级窗口**中查找；当前 runA11ySequence 在 `lastTriggeredSave` 后通过 `resolveSaveDialogHwnd()`（findWindowByName("另存为"/"Save As")）再 bring 前台，逻辑已有，但若对话框标题或出现时机与扫描不同步，仍会失败；多屏/遮挡时依赖「先 bring 再操作」，无「操作后校验焦点是否真在目标」的闭环。
- **结论**：底座已是 Root + 第一层 Window + 有限深度子节点，满足 8GB 显存约束；需在蓝图中明确「执行后校验 HWND/焦点」与「对话框/多窗」的鲁棒策略（见 2.1、2.3）。

### 1.5 依赖注入与数据流（小结）

```
用户输入
  → parseIntent (hybridRouter 分类 + 全量 LLM / planWithLocal)
  → IntentResult (open_target | a11y_sequence | multi_step | ...)
  → jarvis 分支
  → a11y_sequence: createTask + runNextTask(a11ySequenceStep)
  → a11ySequenceStep(ctx): 循环 executeOneStep(step, state)
  → executeOneStep: findWindowByAppWithRetry / findWindowByWindowNameWithAliases
      → bringWindowToFront(hwnd) → clickByName/typeText(..., { targetHwnd })
  → directShellBridge: getSniperExePath → directshell.exe 或 UiaSniper.exe
  → C#: RootElement → FindWindowByNameWithCache → FindElementInScope → Click/SetValue/Scroll
  → stdout "HWND: XXXXX" 被 TS 解析，可用于缓存（当前主要用于日志/兼容）
```

---

## 第二阶段：四支柱重构方案

### 2.1 上帝视角底座方案

**目标**：跨窗口、跨屏幕、对话框弹出后仍能精准定位，且不暴力递归、控制显存与 CPU。

- **层级与范围（保持不变并固化）**
  - **L0**：`AutomationElement.RootElement`，仅作「根」，不遍历其子树。
  - **L1**：`root.FindAll(TreeScope.Children, ControlType.Window)`，仅第一层子节点，数量上限（如 512），得到所有**顶级窗口**（含主窗、弹窗、另存为对话框）。
  - **L2**：仅在「已选定的一个 Window」上，用 **TreeWalker** 或 **FindAll(Descendants)** 时限制 **depth / 节点数**（如 MAX_DEPTH=25，或每窗最多 N 个可交互节点），禁止整树递归。
- **HWND 缓存与失效**
  - 保持现有 TS + C# 双端缓存；**失效策略**：每次操作前对即将使用的 hwnd 做 **IsWindow**（或等价的 UIA FromHandle 可访问性）校验，无效则从缓存剔除并重新 L1 扫描。
  - **对话框/新窗**：在「保存」等会弹出新窗口的步骤后，**固定延迟**（如 1.5s）再执行「解析目标窗口」；目标窗口列表明确为「另存为 / Save As / 保存为」等标题关键字，从 L1 结果中按名称匹配，取第一个匹配的 hwnd，再 bring + 后续 type/click。
- **多屏与遮挡**
  - 不增加「截屏」作为默认路径；继续以 **RootElement 的 Children** 为唯一真相源（UIA 与窗口可见性一致）。
  - 通过 **bringWindowToFront(hwnd)** 保证目标窗在前台；若某步失败（如 find 不到），则进入「异常自愈」流程（见 2.4），可在此处考虑「重试 + 短延迟再扫 L1」或后续迭代中的「截屏反思」。
- **性能与显存**
  - 不扩大 TreeScope（禁止 Root 上 TreeScope.Descendants 全屏扫）；子节点搜索严格 depth-limited；单次 L1 扫描结果可缓存 5–10s，同一链内重复查同一窗口名优先用缓存。

### 2.2 强悍路由协议（100% 识别复合指令）

**目标**：凡「打开 X + 写/输入/保存/点击」类复合指令，必须产出 `a11y_sequence`，绝不误判为仅 open_target。

- **关键词强判（优先于本地分类器）**
  - 在 `parseIntent` 内，**在调用 classifyWithLocal 之后**（或之前，二选一统一）：若用户输入**同时包含**「打开」与至少一个动作词（**写、输入、保存、点击、点、另存为**），则**强制** `route = "COMPLEX_A11Y_PLANNING"`，不再信任分类器对该句的输出。
  - 可选：若 classifyWithLocal 抛错/超时，且输入含「打开」+ 动作词，同样强制 COMPLEX_A11Y_PLANNING。
- **全量 LLM 返回 null 时的二次机会**
  - 当全量 LLM 返回 null（或 content 为空），且**即将**执行 `openTargetFallback` 时：若输入含动作词，**先**调用一次 `planWithLocal(trimmed)`；若返回 `steps.length > 0`，则直接返回 `{ kind: "a11y_sequence", steps }`，**不再**回退到仅 open_target。
- **Prompt 与解析鲁棒性**
  - **LOCAL_CLASSIFY_PROMPT**：增加 1–2 句明确示例——「只要句子里同时有“打开”和“写/输入/保存/点”等，一律标 COMPLEX_A11Y_PLANNING」。
  - **LOCAL_PLAN_PROMPT**：明确「写一首诗」→ type 步骤可填占位文案（如「一首诗」）；「保存在桌面」→ 文件名可默认「未命名.txt」或由用户句意提取；保证输出合法 steps 数组。
  - **planWithLocal 解析**：若 `JSON.parse` 得到对象但 `parsed.steps` 缺失，尝试从整段内容中提取 `steps` 或 `a11y_sequence.steps`，避免格式轻微偏差导致空数组。
- **可选：规则兜底**
  - 对「打开 [应用] + 写/输入 [内容] + 保存（到桌面）」的简单模式，可增加**纯规则**构造最小 steps（open_app → type → click 文件 → click 保存 → type 文件名 → click 保存），仅在「planWithLocal 仍失败且 openTargetFallback 即将生效」时使用，避免覆盖正常 LLM 结果。

### 2.3 执行闭环机制（执行 → 反馈 → 修正）

**目标**：每一步「物理操作」在视为成功前，有可选的**反馈校验**，避免「点了保存但焦点还在主窗」等静默失败。

- **闭环点设计**
  - **A. 操作前**：已具备——resolve targetHwnd → bringWindowToFront(hwnd) → 短延迟 → 再执行 click/type。保持。
  - **B. 操作后（可选，分阶段）**
    - **Phase 1（本版可做）**：对「会改变前台窗口」的步骤（如 click 保存 → 弹出另存为），在 **runA11ySequence** 中**固定**：触发保存后 `await delay(afterSaveShortcutMs)`，再 `resolveSaveDialogHwnd()`；若 resolve 失败则**抛错**，由 withRetry 重试，形成「执行 → 等弹窗 → 再 find 对话框」的简单闭环。
    - **Phase 2（后续）**：在 directShellBridge 或 runA11ySequence 中，对关键步骤（如 click 保存）执行后，**轮询 2–3 次**「当前前台窗口 hwnd 是否等于预期（主窗或另存为）」；若超时仍不匹配，则视为失败并抛错，触发重试或自愈。
- **HWND 传递与 C# 输出**
  - 保持 C# 成功时 stdout 输出 `HWND: XXXXX`；TS 端 `runUiaSniper` 已解析并返回 `{ ok, hwnd }`。可将该 hwnd 写回 bridge 的 **handleCache**（以当前 target 或 windowName 为 key），减少后续同链内对同一窗口的 L1 扫描次数。
- **不增加**：本阶段不引入「每步后截屏 + 视觉模型判断」；闭环仅基于 UIA + HWND + 窗口标题。

### 2.4 异常自愈流程

**目标**：目标元素未找到、被遮挡、对话框未弹出时，系统可自动重试或降级，避免静默失败和用户无感。

- **已有能力**
  - **withRetry**：orchestrator 的 runStepWithResilience 已对 stepFn 做 withRetry（如 3 次、退避）；a11y 链内 findWindow 失败会抛错，触发重试。
  - **useStepFallback: false**：a11y 链不再回退到 noop，错误会向上抛出，任务标为 failed，用户可见错误信息。
- **增强设计**
  - **重试前延迟**：在 withRetry 的每次重试**前**，对「未找到窗口」类错误增加 300–500ms 延迟，再执行下一次，给窗口/对话框出现留时间。
  - **对话框未找到**：若 `resolveSaveDialogHwnd()` 失败，当前已抛错；建议错误信息明确为「未找到另存为对话框，请重试」，便于与「未找到主窗」区分；重试由外层 withRetry 统一处理。
  - **可选（后续）**：若某步连续失败达 N 次，可触发「截屏反思」：调用一次轻量截屏 + 本地/云端视觉模型，输出「当前画面是否包含另存为/保存按钮」等，再决定是再试一次还是报错并提示用户。本蓝图不强制实现，仅作扩展点。
- **日志与可观测**
  - 关键步骤（open_app 完成、triggeredSave、resolveSaveDialogHwnd 成功/失败、每步 executeOneStep 开始/结束）打结构化日志（含 taskId、stepIndex、hwnd），便于排查「神经断联」与「视野狭窄」问题。

---

## 第三阶段：显存/性能约束与神经连接

- **显存与 UIA 扫描**
  - 严禁在 Root 上使用 `TreeScope.Descendants` 无界遍历；仅 **TreeScope.Children** 取顶级窗口，且数量上限（如 512）。
  - 子节点搜索：仅在被选中的单个 Window 内，用 TreeWalker + depth 上限（如 25）或单窗可交互节点数上限；不一次性拉取全屏所有控件树。
- **神经连接（executeStep 注入）**
  - **现状**：jarvis 在 `intent.kind === "a11y_sequence"` 时已写死 `runNextTask(a11ySequenceStep, { useStepFallback: false })`，故**规划一旦产出 a11y_sequence，执行链 100% 由 a11ySequenceStep 执行**，无「未注入」歧义。
  - **要打通的是上游**：通过 2.2 的「关键词强判 + 全量 null 时再试 planWithLocal + Prompt/解析加固」，保证**复合指令 100% 产出 a11y_sequence**，则神经从「意图 → 编排 → 执行」全链路贯通。
  - 可选：在 jarvis 中增加一行日志——「已注入 a11ySequenceStep，taskId=…」，便于运维确认。

---

## 第四阶段：实施顺序建议

1. **路由协议（2.2）**：关键词强判 + null 时再试 planWithLocal + Prompt/解析增强；可配合《JARVIS_A11Y_FIX_PLAN.md》的阶段 1–3。
2. **底座与闭环（2.1 + 2.3）**：固化 L1-only + depth-limited 子节点；Phase 1 的「保存后延迟 + resolveSaveDialogHwnd 失败即抛错」；可选 hwnd 回写缓存。
3. **自愈（2.4）**：重试前短延迟、错误信息区分、日志增强。
4. **可选扩展**：截屏反思、操作后焦点轮询校验。

---

**以上为《Jarvis 全域上帝视角重构蓝图》全文；未直接修改代码，供审核后按阶段落地。**
