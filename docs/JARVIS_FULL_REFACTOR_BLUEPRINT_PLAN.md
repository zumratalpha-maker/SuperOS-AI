# Jarvis 超级个体 OS：全量重构 Blueprint Plan（全局架构师模式）

> 纯 Markdown 计划 · 不包含任何可执行代码  
> 待您明确回复「Blueprint 审核通过，请开始写代码」后再进入实现阶段。

---

## 零、产品愿景与工程原则

### 0.1 产品定位与愿景

Jarvis 是一款**文字与语音双模控制的高级模型**，面向「一人公司」超级个体的全自动电脑交互场景。目标是在 OpenClow 等现有技术边界之上实现突破，成为**未来人们电脑的必备软件**。

- **文字+语音双模**：用户可通过键盘输入自然语言指令，或通过语音下达任务；两种模式共享同一套意图解析、任务编排与物理执行层，保证行为一致、体验统一。
- **突破技术边界**：不满足于「单窗口附着」「单步执行」的局限，从 RootElement 全域视角出发，支持跨软件、跨窗口、跨多屏的复合任务链，实现真正的无人值守自动化。
- **必备软件愿景**：设计时必须考虑真实使用场景，使系统在实际办公、创作、学习、资源整理中真正可用，而非 demo 级别功能堆砌。

### 0.2 使用场景贴合实际（必须覆盖）

Blueprint 的设计必须**贴合实际使用场景**，以下典型场景在实现时不得省略或简化：

| 场景 | 用户指令示例 | 系统必须完成的核心动作 |
|------|--------------|------------------------|
| 文档创作与保存 | 「打开记事本，写一首诗，保存在桌面」 | open_app → 剪贴板秒贴 → 文件→保存 → 1.5s 对话框延迟 → 输入文件名 → 保存 |
| 资源检索与落地 | 「帮我找法考资料并存到桌面」 | 资源猎人 → 用户选择 → 桌面建文件夹 → 保存链接到文件 |
| 跨应用报表处理 | 「处理新疆草莓冷链报表」 | 打开相关应用 → 读取/编辑数据 → 保存/导出；或拆解为可执行的子步骤链 |
| 多屏精准操作 | 「在副屏的记事本里输入主屏剪贴板内容并保存」 | 通过 PID/窗口名锁定副屏窗口 → 置顶 → 粘贴 → 保存 |
| 语音控制 | 「嘿 Jarvis，打开微信给美少女战士发一条消息」 | 语音→文本 → 同文字模式 parseIntent → a11y_sequence 或 open_target |

### 0.3 工程原则：绝不偷工减料

- **禁止**为图方便而减少代码、合并分支、省略错误处理或降级路径；每个设计点（剪贴板秒贴、自适应快捷键、PID 传递、1.5s 对话框延迟）**必须完整实现**，不得用「先这样，后面再说」敷衍。
- **禁止**用「简单方案能跑就行」替代蓝图中的鲁棒设计；例如：不能因「多数场景用不到」而省略多窗/PID 支持、不能因「Win11 新记事本少见」而放弃 AcceleratorKey 优先与语义快捷键兜底。
- **必须**为每个阶段设定明确验收点，未通过验收不得进入下一阶段；实现时若发现蓝图遗漏，应**补充设计**而非悄悄简化。
- **必须**保证文字模式与语音模式共享同一执行层；语音入口仅增加「语音→文本」的转换环节，后续 parseIntent、createTask、runNextTask 等逻辑**完全复用**，不得为语音单独写一套简化实现。

### 0.4 能力边界与演进路径

- **终极愿景**：本系统**理论上可在电脑上执行任何操作**——包括 CAD、专业设计/剪辑软件、复杂业务流程等，只要用户能通过自然语言拆解为可执行步骤，系统即可分步完成。能力边界由「UIA 可访问性 + 物理层执行可靠性」决定，而非人为限制「只能做某几类任务」。
- **分步执行**：复杂任务一律拆解为多步链（open_app、type、click、scroll、drag 等原子动作），按序执行；每步有明确的找窗 → 置顶 → 操作的闭环。
- **先基础、后扩展**：现阶段**优先达成基础目标**（记事本输入保存、资源搜索存桌面、多屏/多窗精准操作、剪贴板秒贴、语义快捷键兜底），确保执行层稳定、神经连接畅通。**在基础目标验收通过后**，再逐步扩展到 CAD、剪映、Excel 等复杂软件；不一次性求全，避免摊子铺大导致质量塌陷。

---

## 一、思考步骤：当前代码问题根源

### 1.1 directshell.exe 单窗口附着缺陷（无法穿透全屏/副屏/后台）

- **现状审计**：本仓库内 **scripts/uia_sniper/UiaSniper.cs** 已采用 **AutomationElement.RootElement** + **TreeScope.Children** 仅扫描第一层顶级窗口，**无 FocusedElement 附着**；通过窗口 Name 包含匹配 + 可选 **ProcessId** 过滤，理论上支持多窗、多屏、后台窗口。若用户实际运行的 directshell.exe 来自「Cursor 封装下载」或历史构建，**可能并非由此源码编译**，仍可能是旧版单窗口附着逻辑，导致在多屏/全屏/后台场景下失明。
- **根源归纳**：  
  - 运行中的 **exe 与仓库内 C# 源码不同源**，或未重新编译部署，导致行为与源码不一致。  
  - 或 TS 层在调用 exe 时**未传入 /pid**，多窗同名时无法用 PID 锁定当前链打开的窗口。
- **设计方向**：第一步必须**以本仓库 C# 源码为唯一真相源**，审计并补全后**重新编译 directshell.exe 并覆盖部署**；TS 层在 open_app 后记录 lastWindowPid，并在后续所有需要定位窗口的调用中传入 PID（或等效 targetHwnd），实现「同链同窗」精准锁定。

### 1.2 C# 源码残缺（缺少 Root、PID、缓存、SW_RESTORE）

- **现状审计**：**当前仓库内 UiaSniper.cs 已包含**：  
  - RootElement + FindAll(TreeScope.Children, ControlType.Window)，MAX_TOP_LEVEL 限制；  
  - HandleCache（key=name|pid，IsWindow 校验后复用）；  
  - FindWindowByName(namePart, filterPid) 的 PID 过滤；  
  - Win32.ShowWindow(hwnd, SW_RESTORE) + SetWindowPos + SetForegroundWindow 的 BringToFront。  
  因此「缺少 Root、PID、缓存、SW_RESTORE」**针对的是可能存在的旧版/外部 exe**，而非当前仓库源码本身。
- **仍缺失或待强化的能力**：  
  - **自适应快捷键**：当前 Click 路径为 TryInvoke → 失败则 MouseClickAbsolute，**未**读取控件的 **AcceleratorKey** / **AccessKey** 做「Invoke 失败后发送原生快捷键」的降维。  
  - 若存在从 **GetForegroundWindow** 反查窗口的路径（无 windowName 时），需确保其仅作兜底，且仍写入缓存、输出 HWND，避免退化为「单窗口附着」心智。
- **设计方向**：在 C# 中**补全「底层探知」**：在查找目标控件后、Invoke 之前或 Invoke 失败后，读取该元素的 **AutomationElement.AcceleratorKeyProperty** 与 **AccessKey**；若存在则解析为 SendKeys 可发送的键序列并发送，实现「控件自带快捷键优先」；仅当读不到或发送失败时，再依赖 TS 侧语义推断（如 保存→^s）兜底。同时确认全流程**无**单窗口附着假设，所有查窗均从 Root + Children 出发。

### 1.3 runInject non-zero / timeout waiting for inject done

- **根源**：runInject 依赖 **scripts/ds_inject.py** 与 Python 环境；py 未在 PATH、或脚本内部依赖（如 pyautogui、钩子）失败时，会 non-zero 或超时。TS 层将 inject 作为 UiaSniper 失败后的兜底，若 inject 亦不可用，用户会看到超时或 exit code 报错。
- **设计方向**：将 inject 明确为**可选兜底**；主路径以 **directshell.exe + 内联 PowerShell** 为主。inject 失败时**快速降级**（不拉长超时），直接进入「语义快捷键 / 剪贴板」兜底，并打清晰日志区分「inject 不可用」与「业务失败」；不因 inject 阻塞整链。

### 1.4 SendKeys 打字极慢且与中文输入法冲突

- **根源**：任何「逐字 SendKeys(用户文本)」都会触发中文输入法逐字上字，极慢且易乱码。
- **现状**：directShellBridge 已提供 **Set-Clipboard + SendKeys('^v')** 的剪贴板秒贴路径，typeText 已优先「Set-Clipboard → 置顶 → Ctrl+V」。需确认**所有**输入文字入口均无对**整段用户文字**的 SendKeys(原文)。
- **设计方向**：输入模块**降维为唯一主路径**：**Set-Clipboard → [HWND 置顶 + 固定延迟] → SendKeys('^v')**，实现 0ms 级无损输入；仅快捷键（^s、^a、%f 等）使用 SendKeys(快捷键)，**绝不** SendKeys(用户文本)。

### 1.5 菜单点击因系统动画遮挡而失效

- **根源**：置顶后立即 UIA Invoke 或鼠标点击，若窗口动画/DWM 未完成，焦点可能仍在旧窗，或控件尚未可交互，导致点击无效。
- **设计方向**：**绝对时序**——任何「置顶后操作」必须经过**单一权威延迟**（afterBringFrontMs）；并在 C# 端 Invoke 失败时，优先走 **AcceleratorKey/AccessKey** 再走 TS 语义快捷键，减少对「精确点击时机」的依赖。

### 1.6 Win11 新版记事本（WinUI 3）UIA 兼容性极差

- **根源**：WinUI 3 架构下 UIA 树结构、控件名或层级与经典 Win32 不同，FindElementInScope 可能找不到「文件」「保存」等节点。
- **设计方向**：**不依赖 UIA 必须找到菜单项**；通过 **C# 端 AcceleratorKey/AccessKey 优先** + **TS 端语义快捷键兜底**（保存→^s、文件→%f 等），使「保存/全选/文件」在 UIA 残缺时仍可用；文本输入一律剪贴板秒贴。

### 1.7 多步链路跳过与「executeStep 未注入实现」

- **根源**：若 **parseIntent** 未产出 **a11y_sequence**（例如被误判为 SIMPLE_OS_ACTION），则 jarvis 只会执行 **open_target** 等单步，不会 createTask(a11y_sequence) 或 runNextTask(a11ySequenceStep)，表现为多步跳过。另：当 a11ySequenceStep 抛错时，若 orchestrator 使用 **useStepFallback: true**，会执行 noopExecuteStep 并打「未注入实现」类日志，导致用户误以为神经未接通。
- **设计方向**：**路由层**通过关键词强判 + LLM 返回 null 时再试 planWithLocal，保证复合指令 **100% 产出 a11y_sequence**；**jarvis** 对 a11y_sequence 分支**强制 useStepFallback: false**，使真实错误上抛、任务标为 failed，不再静默 fallback 到 noop。

### 1.8 依赖 .ps1 导致的执行策略拦截

- **根源**：若存在 **powershell -File xxx.ps1** 调用，会受 ExecutionPolicy 限制。
- **现状**：directShellBridge 中 PowerShell 均为 **-NoProfile -Command** 或 **-EncodedCommand** 内联，未发现 -File；UniversalExecutor 中有 -ExecutionPolicy Bypass。需全仓库确认无 **-File 引用 .ps1**。
- **设计方向**：**禁止** -File 引用 .ps1；所有 PowerShell 逻辑**仅内联**（-Command / -EncodedCommand），必要时对单次调用加 -ExecutionPolicy Bypass（仅该进程）。

---

## 二、风险与注意

- **8GB 显存与 UIA 扫描**：严禁在 Root 上使用 **TreeScope.Descendants** 无界遍历；仅 **TreeScope.Children** 取顶级窗口，且数量上限（如 512）；子节点搜索仅在被选中的单窗内、**深度受限**（如 MAX_DEPTH=25），防止显存/CPU 爆满。
- **PID 冲突与多窗同名**：多屏下两窗标题相同（如「无标题 - 记事本」）时，必须用 **lastWindowPid**（open_app 后记录）在后续 step 传入 findWindowByName 的 processId 选项，否则可能命中错误窗口。
- **自适应快捷键误触**：不同软件对 AcceleratorKey 的实现不一致，部分控件可能返回空或错误格式；解析为 SendKeys 时需做**安全转义与校验**，避免注入异常键序列。语义推断（如 保存→^s）仅作**最后兜底**，并限制在「明确语义」的少数动作上，避免误触其他软件的快捷键。
- **directshell.exe 未部署**：getSniperExePath 若返回 null，主路径完全不可用；需在文档或启动检查中明确「需将编译产物置于 target/release/directshell.exe 或 scripts/uia_sniper/UiaSniper.exe」，并给出明确错误提示。
- **runInject 弱依赖**：若完全移除 inject，需确保 C# + 快捷键 + 剪贴板兜底覆盖所有 click/type 场景，否则功能回退；建议保留 inject 为可选，失败时快速降级并打日志。

---

## 三、交付物：需重写/修改的文件与核心函数签名

- **scripts/uia_sniper/UiaSniper.cs（C# 源码重铸）**
  - **保留并确认**：RootElement、FindAll(Children, ControlType.Window)、HandleCache、FindWindowByName(filterPid)、BringToFront(ShowWindow SW_RESTORE + SetWindowPos + SetForegroundWindow)、ParseTarget(/pid:N)、无 FocusedElement 查窗。
  - **新增**：在查找目标控件（按钮/菜单项）后，读取 **AutomationElement.AcceleratorKeyProperty** 与 **AccessKey**；在 **TryInvoke 失败** 时，若读取到有效快捷键则发送该键序列（通过 Win32 SendInput 或进程内 SendKeys），再返回成功；仅当读不到或发送失败时返回失败，由 TS 兜底。  
  - **函数级**：FindElementInScope（保持深度限制）、ClickElement（先 Invoke，失败则尝试发送 AcceleratorKey/AccessKey，再 BoundingRectangle 点击）、可抽取 **GetAcceleratorOrAccessKey(AutomationElement)** 与 **SendAcceleratorKeys(string)**。
  - **约束**：严禁 TreeScope.Descendants 全树递归；子节点搜索仅限 MAX_DEPTH。

- **src/tools/directShellBridge.ts**
  - **函数**：typeText（唯一输入路径：Set-Clipboard → 置顶 → delay → SendKeys('^v')）、clickByName（先 UIA/exe，失败则 resolveShortcut 语义兜底；保证置顶后 afterBringFrontMs，^s 后 afterSaveShortcutMs）、runInject（超时/non-zero 时快速降级并打日志）、resolveShortcut（语义推断仅作兜底，与 C# 原生快捷键互补）、findWindowByName、runFindWindowFromRoot、bringWindowToFront、setClipboardOnly、sendCtrlVOnly。
  - **配置**：ExecutionTimingConfig（afterBringFrontMs、afterSaveShortcutMs、stepCooldownMs）单一时序权威。

- **src/runA11ySequence.ts**
  - **函数**：executeOneStep、a11ySequenceStep、findWindowByAppWithRetry、findWindowByWindowNameWithAliases、resolveSaveDialogHwnd；**状态**：StepState（lastWindowPid、lastWindowName、saveDialogHwnd、lastTriggeredSave）。
  - **要点**：每步使用 getExecutionTimingConfig()；保存后强制 1.5s 再 resolve 另存为对话框；type/click 一律带 targetHwnd 或 processId。

- **src/jarvis.ts**
  - **分支**：a11y_sequence 时 runNextTask(a11ySequenceStep, { useStepFallback: false, stepTimeoutMs: 90000 })；错误向用户 say 出摘要。

- **src/jarvis/parseIntent.ts**
  - **函数**：parseIntent、hasCompoundActionKeywords、openTargetFallback；全量 LLM 返回 null 或异常时先试 planWithLocal 再回退，保证复合指令产出 a11y_sequence。

- **src/llm/hybridRouter.ts**
  - **函数**：classifyWithLocal、planWithLocal；**常量**：LOCAL_CLASSIFY_PROMPT、LOCAL_PLAN_PROMPT（强化「打开+写/保存」必走 COMPLEX_A11Y_PLANNING 且拆成至少 4 步）。

- **src/agents/orchestrator.ts**
  - **函数**：runStepWithResilience、runNextTask；**配置**：defaultConfig（useStepFallback、stepRetry）；a11y 调用方传 useStepFallback: false。

- **src/tools/resilience.ts**
  - **函数**：withRetry、withTimeout、withFallback；可选「重试前最小延迟」以配合窗口/对话框出现时机。

- **全仓库**
  - **检索**：禁止 **-File** 引用 **.ps1**；所有 PowerShell 仅内联。

- **语音控制集成（阶段 8 交付物）**
  - **入口**：新增或扩展现有入口（如 `src/voice/` 或 jarvis 启动参数），支持「语音 → 文本」后传入 dispatch；**禁止**为语音单独实现简化版 parseIntent 或 runNextTask。
  - **共享链路**：语音文本与键盘文本在 `parseIntent(input)` 之后**完全共享**同一执行链（createTask、runNextTask、a11ySequenceStep 等）；仅在输入源增加麦克风/语音识别环节。

---

## 四、执行顺序：分阶段详细计划

**第一步（必须最先）：重写/补全 C# 源码并重新编译 exe**

### 阶段 1：C# 源码审计与重铸 + 重新编译 directshell.exe

- **1.1 审计**：逐行确认 UiaSniper.cs 中无 FocusedElement 查窗、无 TreeScope.Descendants；确认 Root + Children、HandleCache、PID 过滤、BringToFront(SW_RESTORE) 均存在且正确。
- **1.2 补全「自适应快捷键」**：在目标控件上读取 AcceleratorKeyProperty 与 AccessKey；将 Invoke 失败时的降维路径改为「若存在原生快捷键则发送，否则再 BoundingRectangle 点击」；实现安全的键序列解析与发送（仅 SendKeys 安全子集或 Win32 SendInput）。
- **1.3 编译与部署**：使用本仓库文档中的 csc 命令（或等价方式），引用 UIAutomationClient、UIAutomationTypes、WindowsBase，产出 **directshell.exe** 至 **target/release/**，并覆盖旧 exe；确认无 .ps1 依赖。
- **验收**：命令行执行 `directshell.exe find "记事本"` 能输出 HWND；`directshell.exe click "记事本|保存"` 在 Win11 记事本中能触发保存（若控件有 AcceleratorKey 则优先用其，否则 Invoke/点击）；双进程记事本时带 `/pid:N` 能锁定指定进程。

### 阶段 2：绝对时序与状态机

- **内容**：统一 ExecutionTimingConfig；在 clickByName/typeText 所有分支中，置顶后强制 await afterBringFrontMs；发送 ^s 后强制 await afterSaveShortcutMs（1.5s）；runA11ySequence 每步间 stepCooldownMs。
- **验收**：执行「打开记事本 → 输入 → 点保存」，无「焦点未切到就输入」或「对话框未弹就输入文件名」；日志可见延迟顺序。

### 阶段 3：输入降维与剪贴板秒贴

- **内容**：确认 typeText **唯一**文本输入路径为 Set-Clipboard → 置顶 → delay → SendKeys('^v')；移除或禁用任何对用户文本的 SendKeys(原文)。
- **验收**：在记事本中输入长句，瞬间粘贴、无逐字、无输入法冲突。

### 阶段 4：语义快捷键兜底与 inject 降级

- **内容**：clickByName 在 exe/inject 失败后，resolveShortcut 命中则「置顶 + delay + runSendKeys(shortcut)」；runInject 超时/non-zero 时快速降级并打日志，不阻塞。
- **验收**：无 UIA 控件时「保存」仍能触发 ^s；inject 不可用时任务仍可通过 exe + 快捷键完成或明确失败。

### 阶段 5：全域上帝视角与 PID 传递

- **内容**：TS 层 findWindowByName 仅 Root + L1 Children（已有）；runA11ySequence 在 open_app 后记录 lastWindowPid，后续 type/click 均带 processId 查窗；确认 C# 与 TS 均无单窗口附着假设。
- **验收**：双屏/多窗同名时，仅当前链打开的窗口被操作；另存为对话框通过 L1 查「另存为/Save As」并置顶。

### 阶段 6：路由与神经连接

- **内容**：parseIntent 关键词强判 + null 时 planWithLocal，保证复合指令产出 a11y_sequence；jarvis 中 a11y_sequence 分支 useStepFallback: false；错误上抛并 say 出摘要。
- **验收**：输入「打开记事本，写一首诗，保存在桌面」会产出 a11y_sequence 并完整执行；失败时看到明确错误而非「未注入实现」。

### 阶段 7：无 .ps1 与完整闭环

- **内容**：全仓库检索 -File 与 .ps1，确保无 -File 调用；多轮对话、轨迹记忆、资源搜索、保存到桌面等串联验收。
- **验收**：无 ExecutionPolicy 报错；「帮我找法考资料并存到桌面」与「打开记事本输入一首诗并保存」均可端到端执行。

### 阶段 8：语音控制集成（文字+语音双模）

- **内容**：新增**语音入口**，将用户语音流转化为文本后，**完全复用** parseIntent → createTask → runNextTask 链路；不得为语音单独写简化实现。语音识别可接入系统默认 API（Windows Speech Recognition）或 Ollama/Whisper 等，输出文本后与文字输入走同一 dispatch 分支。
- **约束**：语音模式与文字模式共享同一执行层；仅增加「语音→文本」转换环节，后续逻辑零差异。
- **验收**：语音输入「打开记事本，输入测试内容，点保存」与文字输入相同指令，产出相同的 a11y_sequence 并完整执行；多轮对话中语音与文字可交替使用。

---

## 五、测试用例

### 5.1 双屏/全屏

- **前置**：双屏或单屏多窗口，例如主屏记事本 A、副屏记事本 B（标题均为「无标题 - 记事本」）。
- **指令**：「打开记事本，输入主屏内容，点文件保存，输入 main.txt，点保存。」
- **预期**：仅主链打开的窗口（通过 lastWindowPid 锁定）收到输入与保存；另一窗不受影响；日志可见 PID 用于查窗。

### 5.2 打开记事本输入一首诗并保存

- **指令**：「打开记事本，输入一首诗，点击文件，点击保存，输入 poem.txt，点击保存。」
- **预期**：记事本打开 → 剪贴板秒贴「一首诗」→ 文件/保存通过 AcceleratorKey 或语义快捷键（%f、^s）触发 → 1.5s 后另存为对话框置顶 → 输入 poem.txt → 点击保存；无逐字打字、无菜单点击因动画失效。

### 5.3 C# 原生快捷键优先（若控件支持）

- **前置**：某应用菜单项暴露了 AcceleratorKey（如 Ctrl+S）。
- **指令**：在该应用中执行「点击保存」。
- **预期**：Invoke 失败时，C# 端读取到 AcceleratorKey 并发送，保存仍成功；TS 侧 STRONG_SHORTCUT_MAP 仅作 C# 未返回或未实现时的兜底。

### 5.4 Win11 新记事本（UIA 残缺）

- **指令**：「打开记事本，输入一段话，点保存，输入 1.txt，点保存。」
- **预期**：即使 UIA 找不到「文件」「保存」控件，仍通过 %f、^s 或 C# 读取到的 AccessKey/AcceleratorKey 完成；输入为剪贴板粘贴。

### 5.5 无 Python / inject 失败

- **前置**：重命名或移除 ds_inject.py。
- **指令**：「打开记事本，输入测试，点保存。」
- **预期**：通过 directshell.exe + 剪贴板 + 快捷键完成；日志有 inject 不可用提示，任务可成功或明确失败（非静默）。

### 5.6 语音控制（阶段 8 验收）

- **前置**：语音入口已接入（本地 STT 或云端 API），唤醒词或按键触发。
- **指令**：语音输入「打开记事本，输入上帝视角已打通，点保存，输入 voice_test.txt，点保存。」
- **预期**：语音→文本 转换后，进入与文字模式**完全相同的** parseIntent → a11y_sequence → createTask → runNextTask(a11ySequenceStep) 流程；执行结果与 5.2 等价，无简化或阉割。

---

**以上为《Jarvis 超级个体 OS：全量重构 Blueprint Plan》全文。未包含任何可执行代码。执行顺序第一步为 C# 源码重铸并重新编译 exe。审核通过后，请明确回复「Blueprint 审核通过，请开始写代码」再进入实现阶段。**
