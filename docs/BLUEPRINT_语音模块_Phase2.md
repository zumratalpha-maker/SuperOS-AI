# Blueprint Plan：语音模块 Phase 2（唤醒词 + 简单命令 → JSON Action）

> 按顺序执行，A → B → C → D 中的 **A. 语音模块**。
> 批准后将按本 Blueprint 分阶段实现，不提前写代码。

---

## 一、思考步骤

1. **目标**：实现 `voice_module_spec.md` 定义的「唤醒词 + 简单命令 → JSON Action」最小闭环，Local-First，不离开本机。
2. **约束**：遵守 .cursorrules——TypeScript 强类型、函数式、try-catch + 日志；与现有 parseIntent / directShellBridge 对接，不重复造轮子。
3. **最小闭环定义**：用户说唤醒词后说命令 → 系统产出 JSON Action → 由已有执行层（clickByName / typeText / sendKeys）执行。首版优先打通「文本命令 → JSON → 执行」路径，麦克风采集与 ASR 可先用占位或轻量方案。

---

## 二、分阶段计划

### 阶段 1：命令文本 → JSON Action（文本桥接层）

| 步骤 | 位置 | 动作 |
|------|------|------|
| 1.1 | `src/voice/voiceToAction.ts`（新建） | 定义 `VoiceAction` 类型（与 spec 3.1–3.4 对齐）：`click`、`text`、`key`、`batch`；实现 `parseVoiceCommandToAction(text: string): VoiceAction | null`，用规则映射表将「点击保存」「按 Ctrl+S」「输入 你好」等转为 JSON。 |
| 1.2 | 同上 | 规则映射表：`"点击保存"` → `{action:"click", target_accessibility_id:"Save"}`；`"按 Ctrl+S"` / `"保存"` → `{action:"key", params:{key:"ctrl+s"}}`；`"输入 X"` → `{action:"text", params:{text:"X"}}`；至少 8–10 条常用命令。 |
| 1.3 | `src/voice/index.ts` | 导出 `parseVoiceCommandToAction`、`executeVoiceAction`；`executeVoiceAction` 内部调用 `clickByName`、`typeText`、`sendKeys`（已有 directShellBridge），将 JSON 转为实际调用。 |

**验收**：单元测试或手动调用 `parseVoiceCommandToAction("点击保存")` 返回正确 JSON；`executeVoiceAction` 能驱动 clickByName。

---

### 阶段 2：与 Jarvis 集成（语音入口占位）

| 步骤 | 位置 | 动作 |
|------|------|------|
| 2.1 | `src/jarvis.ts` | 新增 `voice` 子命令或环境变量 `VOICE_MODE=1`：当启用时，readline 输入的文本先经 `parseVoiceCommandToAction` 尝试解析；若返回非 null，则直接 `executeVoiceAction`，不走完整 parseIntent。若为 null，则回退到原有 parseIntent 流程。 |
| 2.2 | `src/index.ts` | 导出 `parseVoiceCommandToAction`、`executeVoiceAction`，供上层或 MCP 接入。 |

**验收**：`npm run start:jarvis` 下，输入「点击保存」能触发 executeVoiceAction → clickByName；输入「打开记事本写诗」仍走 parseIntent。

---

### 阶段 3：唤醒词检测（占位 + 可扩展）

| 步骤 | 位置 | 动作 |
|------|------|------|
| 3.1 | `src/voice/wakeWord.ts`（新建） | 定义接口 `detectWakeWord(): Promise<boolean>`；首版实现：**占位**，直接返回 `false`（不启用麦克风），或从环境变量读取模拟值。预留注释说明后续可接入 Porcupine / 自定义关键词检测。 |
| 3.2 | 同上 | 可选：若用户配置 `VOICE_WAKE_WORD=1` 且存在简单 Node 录音库，实现基于 VAD（语音活动检测）+ 关键词匹配的极简唤醒；否则保持占位。 |

**验收**：接口存在、不报错；不阻塞阶段 1、2 的文本命令路径。

---

### 阶段 4：文档与配置

| 步骤 | 位置 | 动作 |
|------|------|------|
| 4.1 | `docs/voice_module_spec.md` | 更新「状态」节：Phase 2 阶段 1–2 已实现（文本命令 → JSON → 执行）；阶段 3 唤醒词为占位。 |
| 4.2 | `workflow_state.md` | 更新当前任务：Phase 2 语音模块阶段 1–2 IMPLEMENTED。 |

---

## 三、目录与文件结构（计划）

```
src/
  voice/
    voiceToAction.ts   # parseVoiceCommandToAction, executeVoiceAction, 规则映射
    wakeWord.ts        # detectWakeWord 占位
    index.ts           # 统一导出
```

---

## 四、风险与注意

- **麦克风 / ASR**：首版不实现真实麦克风采集与语音转文字，仅打通「文本 → JSON → 执行」路径。真实语音需后续接入 Whisper.cpp 本地或类似方案。
- **规则映射**：命令集可扩展，建议将映射表抽成可配置 JSON 或常量数组，便于后续追加。
- **与 parseIntent 关系**：`parseVoiceCommandToAction` 仅处理简短单步命令；复杂多步（如「打开记事本写诗」）仍走 parseIntent，避免重复逻辑。

---

## 五、实现顺序（批准后执行）

1. 创建 `src/voice/voiceToAction.ts`：类型定义 + 规则映射 + `parseVoiceCommandToAction` + `executeVoiceAction`
2. 创建 `src/voice/wakeWord.ts`：`detectWakeWord` 占位
3. 创建 `src/voice/index.ts`：导出
4. 修改 `src/jarvis.ts`：集成 voice 分支（环境变量或子命令）
5. 更新 `src/index.ts`、`docs/voice_module_spec.md`、`workflow_state.md`

---

**状态**：本 Blueprint 已输出，等待用户批准。批准后将按上述顺序编写代码。
