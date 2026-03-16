# Jarvis「打开+写+保存」不执行完整链 — 完整执行计划

## 一、问题现象

- **用户指令**：`打开记事本,写一首诗,保存在桌面`
- **实际行为**：只执行了「打开记事本」，没有「写诗」「保存」「保存到桌面」等后续步骤。
- **日志关键信息**：
  - `[parseIntent] 混合路由分类: SIMPLE_OS_ACTION` — 被分到「简单操作」，未进入 A11y 规划分支。
  - `[parseIntent] LLM 返回 null，使用 open_target 回退` — 全量 LLM 解析失败后，回退为「仅打开目标」。

结论：**意图解析层没有产出 `a11y_sequence`**，执行链（runA11ySequence → clickByName/typeText）从未被触发。问题在「神经」上游（parseIntent），不在 directShellBridge 或 orchestrator。

---

## 二、根因链

1. **混合路由**（HYBRID_ENABLED=1）先用本地小模型做意图分类：
   - 当前把「打开记事本,写一首诗,保存在桌面」判成 **SIMPLE_OS_ACTION**，而不是 **COMPLEX_A11Y_PLANNING**。
2. 只有 **COMPLEX_A11Y_PLANNING** 才会走：
   - `planWithCloud`（有云端 Key）或 `planWithLocal`（本地）→ 得到 `steps` → 返回 `{ kind: "a11y_sequence", steps }`。
3. 因为被分到 SIMPLE_OS_ACTION，逻辑直接进入「全量 LLM 解析」（SYSTEM_PROMPT + 用户输入）。
4. 全量 LLM 返回内容解析后为 **null**（或 content 为空），于是：
   - 走 `openTargetFallback(trimmed)`：检测到「打开」+「记事本」→ 只返回 `{ kind: "open_target", targetName: "记事本" }`。
5. jarvis 只收到 **open_target**，因此只执行「打开记事本」，不会创建 a11y_sequence 任务，也不会调用 `a11ySequenceStep`。

---

## 三、执行计划（按顺序做）

### 阶段 1：强制「打开+写/输入/保存」走 A11y 规划

| 步骤 | 位置 | 动作 |
|------|------|------|
| 1.1 | `src/jarvis/parseIntent.ts` | 在拿到 `route = classifyWithLocal(trimmed)` 之后，增加 **关键词强判**：若输入同时包含「打开」+ 至少一个动作词（写、输入、保存、点击、点），则 **覆盖** `route = "COMPLEX_A11Y_PLANNING"`，确保进入 planWithLocal/planWithCloud 分支。 |
| 1.2 | 同上 | 可选：若 `classifyWithLocal` 抛错或超时，对同样关键词组合也设 `route = "COMPLEX_A11Y_PLANNING"`，避免一次失败就退化成「只打开」。 |

### 阶段 2：open_target 回退前再试一次 A11y 规划

| 步骤 | 位置 | 动作 |
|------|------|------|
| 2.1 | `src/jarvis/parseIntent.ts` | 在「全量 LLM 返回 null / content 为空」且即将调用 `openTargetFallback(trimmed)` 之前：若输入包含动作词（写、输入、保存、点击、点），**先调用一次** `planWithLocal(trimmed)`；若返回 `steps.length > 0`，则直接返回 `{ kind: "a11y_sequence", steps }`，不再回退到仅 open_target。 |
| 2.2 | 同上 | 仅在 `planWithLocal` 抛错或返回空 steps 时，再执行原来的 `openTargetFallback`，保证兼容性。 |

### 阶段 3：本地规划提示与鲁棒性

| 步骤 | 位置 | 动作 |
|------|------|------|
| 3.1 | `src/llm/hybridRouter.ts` | 检查并微调 `LOCAL_PLAN_PROMPT`：明确「写一首诗」→ type 步骤的文案可用占位（如「一首诗」或简短默认诗句）；「保存在桌面」→ 文件名可设为「未命名.txt」或「桌面/未命名.txt」，确保输出合法 steps。 |
| 3.2 | `src/llm/hybridRouter.ts` | `planWithLocal` 解析 JSON 时若 `parsed.steps` 不存在或非数组，尝试从整段内容中提取 `a11y_sequence.steps` 或仅 `steps`，减少因格式轻微偏差导致的空 steps。 |

### 阶段 4：可选 — 规则兜底 A11y 步骤

| 步骤 | 位置 | 动作 |
|------|------|------|
| 4.1 | `src/jarvis/parseIntent.ts` 或新文件 | 新增 **规则兜底**：当输入匹配「打开 [应用名]」+「写/输入 [可选内容]」+「保存（到桌面）」时，不调 LLM，直接构造最小 steps：`open_app` → `type`（无具体内容时用占位）→ `click 文件` → `click 保存` → `type 文件名`（默认或从「桌面」推导）→ `click 保存`。仅在 **openTargetFallback 之前** 且 **planWithLocal 未产出步骤** 时使用，避免覆盖正常 LLM 结果。 |

### 阶段 5：验证与日志

| 步骤 | 位置 | 动作 |
|------|------|------|
| 5.1 | `src/jarvis/parseIntent.ts` | 在返回 `a11y_sequence` 时打日志：`[parseIntent] 产出 a11y_sequence，steps 数: N`，便于确认链路接通。 |
| 5.2 | 实测 | 启动 `npm run start:jarvis`，输入「打开记事本，写一首诗，保存在桌面」或「打开记事本，输入上帝视角已打通，点击文件保存，输入 test_final.txt，点击保存」，确认：parseIntent 返回 a11y_sequence、runA11ySequence 被调用、各步（打开→输入→保存→文件名→保存）均有执行。 |

---

## 四、依赖与风险

- **依赖**：Ollama（或配置的本地模型）可用，`planWithLocal` 能正常返回 JSON；若完全无 LLM，可依赖阶段 4 规则兜底（若实现）。
- **风险**：关键词强判可能把少量本意「只打开」的句子误判为 COMPLEX_A11Y_PLANNING；可通过限定动作词列表（写、输入、保存、点击、点）与「打开」同句出现来降低误判。

---

## 五、完成标准

1. 输入「打开记事本，写一首诗，保存在桌面」或等价表述后，日志中出现 `[parseIntent] 产出 a11y_sequence，steps 数: N`（N ≥ 3）。
2. Jarvis 实际执行：打开记事本 → 输入内容（或占位）→ 点击文件 → 点击保存 → 输入文件名（或默认）→ 点击保存。
3. 不再出现「只打开记事本、无写/保存」且日志为「LLM 返回 null，使用 open_target 回退」的情况（除非用户输入确实只有「打开X」）。

---

**你说「继续」后，将按上述计划从阶段 1 开始实现并提交代码。**
