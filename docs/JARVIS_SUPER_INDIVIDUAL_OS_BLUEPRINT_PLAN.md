# Jarvis 超级个体 OS：全量重构 Blueprint Plan

> 全局架构师模式 · 纯 Markdown 计划 · 不包含可执行代码  
> 待审核通过后，再按「Blueprint 审核通过，请开始写代码」执行实现。

---

## 一、思考步骤：当前代码问题根源

### 1.1 runInject non-zero / timeout waiting for inject done

- **根源**：`runInject` 依赖 `scripts/ds_inject.py`，通过 `spawn(py, [pyScript, action, ...args])` 调用，超时为 `INJECT_TIMEOUT_MS`（8s）。Python 环境缺失、py 未在 PATH、或 inject 脚本内部依赖（如 pyautogui/键盘钩子）失败时，会返回 non-zero 或超时。
- **关联**：click/type/scroll 在 directshell.exe（UiaSniper）失败后会走 runInject 兜底；若 inject 也不可用，用户只会看到超时或 exit code 日志，无清晰降级路径。
- **设计方向**：将 inject 明确标为「可选兜底」；主路径以 C# directshell + 内联 PowerShell 为主；inject 失败时不再阻塞，直接进入「语义快捷键/剪贴板」兜底，并打日志区分「inject 不可用」与「业务失败」。

### 1.2 SendKeys 打字速度极慢（输入法冲突）

- **根源**：若仍存在「逐字 SendKeys(文字)」路径（例如通过 runInject 或某兜底分支发送原文），会触发中文输入法逐字上字，极慢且易乱码。
- **现状**：directShellBridge 已提供 Set-Clipboard + SendKeys('^v') 的剪贴板秒贴路径，且 typeText 优先走剪贴板；需审计所有「输入文字」入口，确保无任何分支对**整段用户文字**调用 SendKeys(原文)。
- **设计方向**：输入模块降维为「唯一主路径：Set-Clipboard → 置顶目标窗 → SendKeys('^v')」；仅快捷键（如 ^s、^a）使用 SendKeys(快捷键)，绝不 SendKeys(用户文本)。

### 1.3 保存菜单/快捷键失效（Alt+F / Ctrl+S 不触发）

- **根源**：菜单点击依赖 UIA 查找「文件」「保存」等控件；Win11 新版记事本等 UIA 树结构变化大，控件名或层级与预期不符，导致找不到元素。而快捷键路径（先 bring 目标窗，再 SendKeys('^s')）依赖「当前焦点在目标窗」；若置顶后动画未完成或焦点被抢，^s 会发到错误窗口。
- **现状**：STRONG_SHORTCUT_MAP 已把「保存/Save」映射为 ^s，clickByName 在 UIA/inject 失败后会走该兜底；afterSaveShortcutMs（1500ms）在发送 ^s 后已生效。问题可能在于：置顶后到发送 ^s 之间的延迟不足，或 runSendKeys 未正确发送到前台。
- **设计方向**：语义快捷键拦截优先于菜单点击——当目标 name 匹配「保存/Save/全选/Select All」等时，**直接**走快捷键路径（bring + 固定延迟 + SendKeys），不先尝试 UIA 点击；并保证 afterBringFrontMs 与 afterSaveShortcutMs 可配置且足够（如 1000ms + 1500ms）。

### 1.4 Win11 新版记事本 UIA 兼容性极差（控件找不到）

- **根源**：UIA 树由应用提供，Win11 新记事本可能使用新控件/虚拟化，AutomationId/Name 不稳定或层级深，C# FindElementInScope 与 TS 侧 readCurrentA11ySnapshot 均可能拿不到「文件」「保存」等节点。
- **设计方向**：不依赖 UIA 找到具体菜单项；对「文件/保存/全选」等高频动作，一律走「语义快捷键」路径（^s、^a、%f 等），C# 仅负责「查窗 + 置顶 + 可选地点击已知控件」，文本输入一律剪贴板；这样即使 UIA 树残缺，保存/全选仍可用。

### 1.5 焦点切换太快（窗口动画未完成）

- **根源**：bringWindowToFront 调用后立即执行 click/type，若系统窗口动画或 DWM 尚未完成，焦点可能仍在旧窗口，导致按键发错目标。
- **现状**：ExecutionTimingConfig 有 afterBringFrontMs（1000）、stepCooldownMs（600）等，但可能未在所有分支统一应用（例如 inject 兜底路径未再等一步）。
- **设计方向**：建立「绝对时序」——任何「置顶后操作」必须经过单一权威延迟（afterBringFrontMs）；runA11ySequence 与 directShellBridge 共用 getExecutionTimingConfig()，且在 clickByName/typeText 的**所有**分支（含快捷键兜底）在发送按键前都显式 await 该延迟。

### 1.6 多步链路跳过或不连续执行

- **根源**：a11ySequenceStep 在单次 runNextTask 调用中**循环执行全部 steps**，若某步抛错，withRetry 会对「整段 stepFn」重试，即重跑整个链而非单步；且 stepFn 一次只处理一个 task，task 的 payload 含整条 steps，所以要么全成功要么某步抛错后整链失败。若 parseIntent 未产出 a11y_sequence（例如被误判为 SIMPLE_OS_ACTION），则整链不会创建，表现为「只打开了应用」。
- **设计方向**：保持「一个 task 对应一整条 a11y_sequence，一次 stepFn 执行整链」的模型；通过「关键词强判 + null 时 planWithLocal」保证复合指令 100% 产出 a11y_sequence；withRetry 的粒度保持「整链」重试，但重试前增加短延迟（如 400–500ms），避免连续失败。

### 1.7 附着单窗口问题（多屏、全屏遮挡、后台窗口）

- **根源**：历史设计可能依赖「当前焦点窗口」或「单一附着窗口」；当前实现已改为从 RootElement 第一层 Children 扫顶级窗口，按 Name/PID 匹配，再 bring 该 hwnd，理论上支持多窗。但若扫描只取「第一个匹配」且多屏下存在多个同名窗口，可能命中错误窗口；或后台/最小化窗口在部分 UIA 实现中未枚举到。
- **设计方向**：严格「全域上帝视角」——仅从 RootElement.FindAll(Children, ControlType.Window) 获取顶级窗口列表，不依赖 FocusedElement；按「窗口名包含 + 可选 PID」过滤，多匹配时可用 PID（上一级 open_app 的 processId）锁定；支持最小化窗口（先 ShowWindow SW_RESTORE 再 SetForegroundWindow）。

### 1.8 依赖 .ps1 脚本（执行策略拦截）

- **根源**：若存在通过 `powershell -File xxx.ps1` 调用的逻辑，会受 ExecutionPolicy 限制。
- **现状**：directShellBridge 中 PowerShell 调用均为 `-NoProfile -Command` 或 `-NoProfile -EncodedCommand` 内联脚本，未发现 -File 引用；UniversalExecutor 中有 -ExecutionPolicy Bypass，属显式放宽。需确认全仓库无 .ps1 文件被直接 -File 执行。
- **设计方向**：全项目禁止「-File 引用 .ps1」；所有 PowerShell 逻辑一律内联（-Command 或 -EncodedCommand），必要时对单条命令加 -ExecutionPolicy Bypass（仅该进程）。

---

## 二、风险与注意

- **runInject 弱依赖**：若完全移除或大幅弱化 inject，依赖 inject 的旧流程（如某类 click）需由 C# + 快捷键兜底完全覆盖，否则功能回退。建议保留 runInject 调用，但失败时快速降级、不拉长超时。
- **时序放大会拉长整链耗时**：afterBringFrontMs、afterSaveShortcutMs 等放大后，多步任务总时长增加，需在「稳定性」与「体感速度」间取平衡；建议可配置且提供默认值（如 1000/1500），便于按环境调参。
- **C# directshell 未安装或路径错误**：getSniperExePath 若返回 null，所有依赖 directshell 的路径都会失败；需在文档或启动时检查 target/release/directshell.exe 或 scripts/uia_sniper/UiaSniper.exe 存在，并给出明确错误提示。
- **多窗同名**：多屏下两窗标题均为「无标题 - 记事本」时，仅按名称匹配会歧义；必须依赖 lastWindowPid（open_app 后记录）在后续 step 中传入 findWindowByName 的 processId 选项，实现精准锁定。
- **Win11 新控件**：除「保存/全选」等用快捷键绕过外，若未来需要点击更多 UIA 控件，仍可能遇到新控件兼容问题；建议新能力优先用快捷键或剪贴板，UIA 点击仅作补充。

---

## 三、交付物：需修改的文件与核心函数/配置

- **src/tools/directShellBridge.ts**
  - 函数：`typeText`、`clickByName`、`runInject`（或封装层）、`runSendKeys`、`setClipboardOnly`/`sendCtrlVOnly`/`runPasteFromClipboard`、`resolveTargetHwnd`、`findWindowByName`、`runFindWindowFromRoot`、`bringWindowToFront`、`waitForTarget`。
  - 配置/常量：`ExecutionTimingConfig`（DEFAULT_TIMING）、`SNIPER_TIMEOUT_MS`、`INJECT_TIMEOUT_MS`、`STRONG_SHORTCUT_MAP`/`MENU_SHORTCUTS`、`resolveShortcut`。
  - 设计要点：输入唯一路径为剪贴板秒贴；语义快捷键优先；inject 失败快速降级；所有置顶后操作统一延迟；Root + L1 查窗与 HWND 缓存保持不变。
- **src/agents/orchestrator.ts**
  - 函数：`runStepWithResilience`、`runNextTask`、默认 config（stepTimeoutMs、stepRetry、useStepFallback）。
  - 设计要点：a11y 任务调用方传 useStepFallback: false；重试前可增加短延迟（或由 resilience 支持）。
- **src/runA11ySequence.ts**
  - 函数：`executeOneStep`、`a11ySequenceStep`、`findWindowByAppWithRetry`、`findWindowByWindowNameWithAliases`、`resolveSaveDialogHwnd`。
  - 状态：StepState（lastWindowPid、lastWindowName、saveDialogHwnd、lastTriggeredSave）。
  - 设计要点：每步严格使用 getExecutionTimingConfig() 的 afterBringFrontMs/afterSaveShortcutMs/stepCooldownMs；保存后 1.5s 再 resolve 另存为对话框；type/click 一律带 targetHwnd（或 saveDialogHwnd）。
- **src/jarvis.ts**
  - 分支：`intent.kind === "a11y_sequence"` 时 createTask + runNextTask(a11ySequenceStep, { stepTimeoutMs, useStepFallback: false })。
  - 设计要点：确认无 fallback 吞错；错误信息向用户展示。
- **src/jarvis/parseIntent.ts**
  - 函数：`parseIntent`、`hasCompoundActionKeywords`、`openTargetFallback`；全量 LLM 返回 null 或异常时先试 `planWithLocal` 再回退。
  - 设计要点：复合指令 100% 产出 a11y_sequence（关键词强判 + null 时 planWithLocal）。
- **src/llm/hybridRouter.ts**
  - 函数：`classifyWithLocal`、`planWithLocal`；常量：LOCAL_CLASSIFY_PROMPT、LOCAL_PLAN_PROMPT。
  - 设计要点：分类与规划 prompt 强化「打开+写/保存」必走 COMPLEX_A11Y_PLANNING 且拆成至少 4 步。
- **src/tools/resilience.ts**
  - 函数：`withRetry`、`withTimeout`、`withFallback`。
  - 设计要点：可选「重试前最小延迟」参数，供 orchestrator 使用。
- **src/config 或 单一时序配置模块**
  - 导出全局 ExecutionTimingConfig 默认值与可选覆盖（环境变量或配置文件），供 bridge 与 runA11ySequence 共用。
- **scripts/uia_sniper/UiaSniper.cs（或 directshell 编译源）**
  - 设计要点：保持 Root + L1 Children 查窗；窗口内 TreeWalker 深度限制；不依赖 FocusedElement；成功时 stdout 输出 HWND；可选 find 命令。无 .ps1 依赖。

---

## 四、执行顺序：分阶段计划与验收点

### 阶段 1：绝对时序与状态机

- **内容**：统一 ExecutionTimingConfig 的读取与默认值；在 clickByName/typeText 的**所有**分支（含 UIA、inject、快捷键兜底）中，在「置顶后」到「发送按键/点击」之间强制 await afterBringFrontMs；在发送 ^s 后强制 await afterSaveShortcutMs；runA11ySequence 每步之间 stepCooldownMs。
- **验收**：执行「打开记事本 → 输入一段字 → 点保存」，观察无「焦点未切到记事本就输入」或「保存未弹窗就输入文件名」；日志中可见延迟执行顺序。

### 阶段 2：输入降维与语义快捷键

- **内容**：确认 typeText 唯一文本输入路径为 Set-Clipboard → 置顶 → SendKeys('^v')；移除或禁用任何对「用户文本」的 SendKeys(原文)。扩展 STRONG_SHORTCUT_MAP，覆盖「文件」→ %f、「另存为」→ %fa 等；在 clickByName 中当 resolveShortcut 命中时，**优先**走「bring + delay + runSendKeys(shortcut)」，仅当无快捷键时才尝试 UIA/inject。
- **验收**：在记事本中输入长句，应瞬间粘贴无逐字效果；点击「保存」应在无 UIA 控件时仍能触发 Ctrl+S 并弹出另存为。

### 阶段 3：runInject 降级与无 .ps1 依赖

- **内容**：runInject 超时或 non-zero 时，不阻塞主流程，直接进入快捷键/剪贴板兜底并打日志「inject 不可用或超时」；全项目检索 -File、.ps1，确保无 PowerShell -File 调用；必要时对内联命令显式传 -ExecutionPolicy Bypass。
- **验收**：在无 Python 或故意让 ds_inject.py 失败时，保存/输入仍能通过快捷键与剪贴板完成；无 ExecutionPolicy 相关报错。

### 阶段 4：全域上帝视角与多窗

- **内容**：确认 findWindowByName/runFindWindowFromRoot 仅用 RootElement.FindAll(Children, Window)，且子节点搜索 depth-limited；runA11ySequence 在 open_app 后记录 lastWindowPid，后续 type/click 均带 processId 调用 findWindowByWindowNameWithAliases；C# 端保持 Root + L1 + 别名（如记事本/Notepad）；bring 前对最小化窗口执行 ShowWindow(SW_RESTORE)。
- **验收**：双屏或多窗同时打开两个记事本时，通过「打开记事本 → 输入 A → 保存」只影响当前链打开的窗口；另存为对话框通过「另存为/Save As」从 L1 再次查窗并置顶。

### 阶段 5：路由与规划 100% 复合指令

- **内容**：parseIntent 中 hasCompoundActionKeywords 覆盖「打开+写/输入/保存/点击/点」等，强制 route=COMPLEX_A11Y_PLANNING；全量 LLM 返回 null 或异常时，先 planWithLocal，再 openTargetFallback；hybridRouter 的 LOCAL_CLASSIFY_PROMPT / LOCAL_PLAN_PROMPT 强化「写诗并保存」拆成至少 4 步。
- **验收**：输入「打开记事本，写一首诗，保存在桌面」或「帮我找法考资料并存到桌面」，日志出现「产出 a11y_sequence，steps 数 ≥ 3」，且实际执行打开、输入/搜索、保存/建文件夹等步骤。

### 阶段 6：神经连接与错误可见

- **内容**：jarvis 中 a11y_sequence 分支确认 useStepFallback: false；orchestrator 在 stepFn 抛错时更新任务为 failed 并带 error 信息；对用户 say 出错误摘要（如「执行 A11y 链时出错：未找到窗口:xxx」）。
- **验收**：故意制造「未找到窗口」或 inject 不可用，应看到任务失败和明确错误提示，而非静默完成或「未注入实现」类日志。

### 阶段 7：完整交互闭环（可选增强）

- **内容**：语音准备、多轮对话、轨迹记忆、资源搜索、下载、保存到桌面等已有模块的串联；确保「找法考资料并保存到桌面」走 resource_hunt + manage_file（建文件夹）+ 保存链接，与 a11y_sequence 的「打开应用→输入→保存」并行不冲突。
- **验收**：端到端指令「帮我找法考资料并存到桌面」完成：检索 → 展示 → 用户选择 → 建文件夹 → 保存链接；以及「打开记事本输入xxx保存」完整执行。

---

## 五、测试用例

### 5.1 多屏 / 全屏

- **前置**：双屏或单屏多窗口，例如主屏记事本 A、副屏记事本 B（或另一「无标题 - 记事本」）。
- **指令**：「打开记事本，输入主屏内容，点文件保存，输入 main.txt，点保存。」
- **预期**：仅主链打开的记事本收到输入与保存；另一窗不受影响；日志中可见 lastWindowPid 用于后续查窗。

### 5.2 完整交互：打开 + 输入 + 保存

- **指令**：「打开记事本，输入上帝视角已打通，超级个体起飞！，点击文件，点击保存，输入 test_final.txt，点击保存。」
- **预期**：记事本打开 → 剪贴板秒贴整段文字 → 快捷键或菜单打开「另存为」→ 1.5s 后对话框置顶 → 文件名输入 test_final.txt → 点击保存；全程无逐字打字、无 Alt+F/Ctrl+S 失效。

### 5.3 完整交互：找资料并保存到桌面

- **指令**：「帮我找法考资料并存到桌面。」
- **预期**：解析为 resource_hunt + manage_file（建文件夹「法考资料」或类似）+ 保存链接；或拆成 a11y_sequence + 多步；检索结果展示后用户可选择「下第 N 个」；链接保存到桌面新建文件夹。

### 5.4 保存快捷键与对话框延迟

- **指令**：「打开记事本，写一首诗，保存在桌面。」
- **预期**：至少 4 步（open_app、type、click 文件、click 保存；若含文件名则更多）；点击保存后 1.5s 内不输入文件名；之后若存在「另存为」窗口则在其内输入文件名并保存。

### 5.5 无 Python / inject 失败

- **前置**：重命名或移除 ds_inject.py，或使 py 不可用。
- **指令**：「打开记事本，输入测试，点保存。」
- **预期**：通过 directshell + 剪贴板 + 快捷键（^s）仍能完成；日志中有 inject 超时或不可用提示，但任务可成功或明确失败（非静默）。

### 5.6 Win11 新记事本（UIA 控件缺失）

- **前置**：使用 Win11 自带新版记事本。
- **指令**：「打开记事本，输入一段话，点保存，输入 1.txt，点保存。」
- **预期**：即使 UIA 找不到「文件」「保存」控件，仍通过 %f、^s 等快捷键完成；输入为剪贴板粘贴。

---

**以上为《Jarvis 超级个体 OS：全量重构 Blueprint Plan》全文。未包含任何可执行代码。审核通过后，请回复「Blueprint 审核通过，请开始写代码」再进入实现阶段。**
