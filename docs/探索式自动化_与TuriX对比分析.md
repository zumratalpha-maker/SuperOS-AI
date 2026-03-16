# 探索式自动化 vs 规则驱动：差异分析与 TuriX 对比

> 基于用户交流、GitHub/TuriX 调研、现有代码架构的综合分析  
> 更新于 2026-03

---

## 一、核心差异：你说的 vs 我做的

| 维度 | 当前 SuperOS 架构 | 交流中提出的「探索闭环」 |
|------|-------------------|---------------------------|
| **驱动方式** | 规则 + 预设路径（parseIntent → a11y_sequence/规则兜底） | 目标解析 → 探索试错 → 效果校验 → 记忆 |
| **未命中时** | 走 ResearchAgent 搜「Best way to do X」→ 返回 CLI/脚本建议，**不执行 GUI 探索** | 主动遍历 UI/OCR → 试点击 → 校验是否成功 → 记路径 |
| **记忆粒度** | 单点坐标 `{ target, xRel, yRel }` | 完整操作路径 `actionPath: [{ ctrl, xRel, yRel }, ...]` |
| **校验** | 部分：记忆执行后校验焦点、链补全（保存/发送） | 全流程：每步后校验「是否达到目标」 |

**本质区别**：你是「剧本驱动演员」，提议是「自己写剧本并试戏的演员」。

---

## 二、必要性评估

### 2.1 有无必要？

**有，但不必一步到位。** 理由：

1. **你已有 80% 基础**
   - UIA + OCR + `learnedActions` = 手脚已有
   - ResearchAgent = 已会「搜最优方案」
   - 缺的只是：**搜不到时的 GUI 探索 + 每步校验**

2. **你当前主场景（剪映流水线）是「预设路径密集」**
   - 打开→开始创作→导入→导出：全是明确步骤
   - 探索价值在「长尾指令」：如「剪映给视频加滤镜」「微信置顶某人」等

3. **探索有成本**
   - 试错会点错、弹窗、卡住
   - 视障/单用户场景下，试错体验差
   - 需要「探索开关」：仅对白名单应用/指令开放

### 2.2 多大必要？（量化）

| 场景 | 当前能覆盖 | 加探索后 | 必要性 |
|------|------------|----------|--------|
| 剪映导出、记事本写诗、微信发消息 | ✅ | ✅ | 低（已有） |
| 剪映加滤镜、微信置顶、Excel 筛选 | ❌ | ✅ | **高** |
| 全新应用、全新操作 | ❌ | 部分 | 中（依赖探索质量） |

**结论**：对**剪映/微信等核心应用的长尾操作**必要性高；对「任意应用任意操作」必要性中，且需分阶段。

---

## 三、TuriX 与你的差异（可借鉴点）

### 3.1 TuriX 是什么

- **TuriX CUA**：开源 Computer-Use Agent，GitHub 1.5k+ star
- **架构**：四角色并行——Planner / Action / Evaluator / Supervisor
- **技术**：视觉模型（截图→点哪里）+ 像素级点击 + 68% OSWorld 通过率
- **平台**：macOS 15.6+ / Windows 10+

### 3.2 与你架构的差异

| 维度 | SuperOS（你） | TuriX |
|------|---------------|-------|
| **感知** | UIA 树 + OCR + DirectShell | 截图 + 视觉模型（端到端） |
| **决策** | 规则 + LLM 意图解析 + 预设步骤链 | Planner 模型规划、Evaluator 评估 |
| **执行** | DirectShell / 坐标 / 记忆 | 像素坐标 + 虚拟鼠标键盘 |
| **学习** | 坐标记忆（单点） | 任务级轨迹记忆（未开源细节） |
| **Token/成本** | 本地 Ollama 为主，可控 | 依赖云端大模型或自建 VLM |
| **视障友好** | 有设计（语音、无屏） | 未强调 |
| **Win11 深度** | 强（DirectShell、UIA、多策略） | 通用跨平台 |

### 3.3 可借鉴的点（能结合）

1. **效果校验（Evaluator）**
   - TuriX：每一步后评估「是否达成子目标」
   - 你可做：剪映导出→校验桌面是否出现 mp4；微信发消息→校验聊天框是否出现文字

2. **多角色架构**
   - 你已有「意图解析 → 步骤执行」，可拆成：Parser / Executor / **Checker**（新增）
   - Checker 在步骤后调用：OCR 或 UIA 查「是否出现预期结果」

3. **轨迹记忆**
   - TuriX 做任务级轨迹；你目前只有单点坐标
   - 可扩展 `LearnedRecord`：`actionPath: Array<{ctrl, xRel, yRel}>`，支持多步序列记忆

### 3.4 暂不宜直接套用的点

- **端到端视觉模型**：需要大量标注数据 + GPU，与你「Local-First、轻量」不符
- **TuriX 源码**：Repo 以官网/文档为主，核心 CUA 逻辑未全开源，难以直接嵌入

---

## 四、落地计划（分阶段）

### Phase A：效果校验（1～2 天）★ 优先

**目标**：让系统知道「做对了没有」。

| 步骤 | 动作 | 产出 |
|------|------|------|
| 1 | 新增 `effectChecker.ts`：`checkExportSuccess(exportPath)`、`checkWeChatMessageSent()` 等 | 可复用的校验函数 |
| 2 | 在 `runA11ySequence` 的剪映导出链末端调用 `checkExportSuccess` | 导出成功则记路径，失败则清记忆 |
| 3 | 在微信发消息链末端调用 `checkWeChatMessageSent`（OCR 查聊天框是否出现消息） | 同上 |

**实现要点**：
- 校验可选：`CHECK_EFFECT=1` 环境变量开启
- 失败时：`deleteLearnedAction(target)`，下次重走 OCR/UIA

### Phase B：简单探索（3～5 天）

**目标**：预设路径未命中时，对**文字类控件**做有向探索。

| 步骤 | 动作 | 产出 |
|------|------|------|
| 1 | 新增 `exploreAndTry(target, hwnd)`：UIA/OCR 搜含 target 关键词的控件 | 候选控件列表 |
| 2 | 按类型优先级试：Button → MenuItem → …，逐个 `simulateClick` | 试错循环 |
| 3 | 每试一次调用 `effectChecker` 或简单启发式（如「窗口标题变化」） | 成功则 `appendLearnedAction` |
| 4 | 白名单：仅对 `剪映|微信|Excel` 等开启探索 | 避免乱点系统设置 |

**与现有代码结合**：
- 在 `parseIntent` 返回 `null` 且 `hasCompoundActionKeywords` 时，不走 ResearchAgent，先走 `exploreAndTry`
- 探索失败再 fallback ResearchAgent

### Phase C：操作路径记忆（约 1 周）

**目标**：一次探索成功，记完整路径，下次直接复用。

| 步骤 | 动作 | 产出 |
|------|------|------|
| 1 | 扩展 `LearnedRecord`：`actionPath?: Array<{ctrl, xRel, yRel}>` | 支持多步序列 |
| 2 | 探索成功后：`appendLearnedAction` 写入完整 path | 单条记录 = 一整条路径 |
| 3 | `clickByName` 查记忆时：若命中 `actionPath`，按序执行 | 免重复探索 |
| 4 | 路径失效时：`deleteLearnedAction` 清 path，触发重新探索 | 自愈 |

### Phase D：目标解析（可选，约 1 周）

**目标**：用本地小模型把指令拆成「目标 + 校验规则」。

- 输入：「剪映给视频加滤镜」
- 输出：`{ goal: "视频轨道出现滤镜效果", checkRule: "OCR检测到滤镜/效果相关文字", subGoals: ["找滤镜入口", "选滤镜", "应用"] }`
- 需要：轻量模型（Llama.cpp 7B 级）+ 少量 prompt 工程

**必要性**：中。Phase A～C 做扎实后，目标解析可显著提升探索命中率。

### Phase E：向量视觉记忆（远期，后续再考虑）

**目标**：给 Jarvis 加上「向量眼睛」——截图 → 视觉模型（LLaVA/Qwen-VL 等）→ 控件转 embedding 存储 → 下次向量相似度匹配后点击。

| 能力 | 说明 |
|------|------|
| **与 OCR 区别** | OCR 只认字（image→text）；向量眼睛 = 完整「看+思考+记住」链路，可识别图标、无文字控件 |
| **教导模式** | 用户指屏 + 语音「这是 XX 按钮」→ UIA 能摸到则存坐标；摸不到则截图 → VLM → 存 embedding + 坐标 |
| **下次执行** | 拿当前截图/区域 embedding 与向量库相似度匹配 → 命中则点击存储坐标，或引导 Rust 手臂执行 |

**执行顺序**：排在 Phase A～D、TuriX 可选集成之后。**未来接入预留**：

- `clickByName` 保留「视觉兜底」调用点：UIA/OCR 均失败时，可插 `vectorEyes.tryMatch(target)` 或类似接口
- `learnedActions` / 记忆层：数据结构可扩展为支持 `embedding?: number[]`，与现坐标存储兼容
- 教导模式：与 `trajectoryRecorder`、语音模块联动时，预留「当前帧 + 用户所指区域」作为视觉输入

---

## 五、与 TuriX 的结合方式（可选）

| 方式 | 可行性 | 说明 |
|------|--------|------|
| **直接集成 TuriX 二进制** | 低 | TuriX 以桌面 App 形式分发，难以作为库嵌入 |
| **借鉴 TuriX Evaluator 思路** | 高 | 你自建 Checker，逻辑类似 |
| **用 TuriX 做「探索子任务」** | 中 | 若 TuriX 提供 API，可把「未知操作」外包给 TuriX，你只做编排 |
| **参考架构文档** | 高 | 读 technical report，仿多角色（Parser/Executor/Checker）设计 |

---

## 六、总结

1. **差异**：你偏规则+记忆，缺「探索+校验」闭环；提议的改造成本可控，与现有架构兼容。
2. **必要性**：对剪映/微信长尾操作**高**；对任意应用**中**，建议分阶段。
3. **TuriX**：可借鉴 Evaluator、多角色架构；端到端视觉方案与你的 Local-First 不完全对齐。
4. **建议顺序**：Phase A（效果校验）→ Phase B（简单探索）→ Phase C（路径记忆）→ Phase D（目标解析，可选）→ **Phase E（向量视觉记忆，远期）**。

5. **向量视觉记忆**：已写入计划，后续再考虑；当前设计需为未来接入预留接口（`clickByName` 视觉兜底调用点、`LearnedRecord` 扩展 `embedding`、教导模式与轨迹/语音联动）。

**落地第一步**：先做 `effectChecker` + 剪映导出/微信发消息的末端校验，约 1 天可验证价值。
      output.mp4     