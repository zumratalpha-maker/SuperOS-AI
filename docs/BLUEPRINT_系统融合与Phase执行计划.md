# Blueprint：系统融合与 Phase 执行计划

> 整合 Scrapling、自我进化能力与 Phase C 短视频流水线，形成统一开发路线。  
> **状态：NEEDS_PLAN_APPROVAL** — 用户明确批准（回复「批准」或「OK」）后再进行编码实现。

---

## 一、融合目标

将以下三块能力纳入 SuperOS，形成**自适应、可自我进化**的短视频自动化流水线：

| 来源 | 能力 | 融入形态 |
|------|------|----------|
| **Scrapling** | Web 抓取、自适应解析、MCP | MCP 集成（P3 发布用）+ 多策略/相似度思想（桌面端） |
| **Ralph Loop / 自我进化** | 失败重试、反馈注入、知识库 | runA11ySequence 外层验证 loop + `automation_memory.md` |
| **Phase C** | 剪映 P0～P3 | 收尾 P0 → P1 导入 → P2 TTS → P3 发布（含 Scrapling） |

---

## 二、整体架构（融合后）

```
┌─────────────────────────────────────────────────────────────────┐
│                     SuperOS 短视频流水线                           │
├─────────────────────────────────────────────────────────────────┤
│  Ralph Loop 层：runA11ySequence 外层验证 → 失败则反馈重试           │
├───────────────┬───────────────┬───────────────┬─────────────────┤
│  P0 剪映导出   │  P1 导入素材   │  P2 TTS/字幕  │  P3 发布(Web)    │
│  (DirectShell)│  (DirectShell)│  (DirectShell)│  (Scrapling MCP)│
├───────────────┴───────────────┴───────────────┴─────────────────┤
│  桌面端多策略定位：Name → AutomationId → 相似度 → 坐标（Scrapling 思想） │
├─────────────────────────────────────────────────────────────────┤
│  知识库：docs/automation_memory.md（已知失效模式、坐标漂移、版本差异）   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、分阶段执行计划

### Phase C-P0 收尾（当前优先）

**目标**：`npm run verify:jianying-export` 全流程通过。

| 步骤 | 内容 | 验收 |
|------|------|------|
| P0-1 | 修复 findExportDialogHwnd：按实际剪映版本补全窗口标题/子窗口结构，或增加调试输出定位 | 步骤 5「click 桌面」能正确作用于导出对话框 |
| P0-2 | （可选）导出对话框内「桌面」「文件名」「导出」的坐标兜底（若 UIA 仍失败） | 全流程可无人工干预完成 |

**依赖**：无（基于现有 directShellBridge、runA11ySequence）。

---

### Phase C-P1 导入本地素材

**目标**：打开剪映 → 开始创作 → 导入本地图片/视频 → 进入导出流程。

| 步骤 | 内容 | 验收 |
|------|------|------|
| P1-1 | 明确剪映导入 UI 流程（点击入口、路径输入、确认） | 形成 jianyingSteps 的 `buildJianyingImportSteps` |
| P1-2 | 扩展 runA11ySequence：支持「导入」步骤类型或 click+type 组合 | 可执行「导入 C:\Users\xxx\video.mp4」 |
| P1-3 | 坐标/多策略兜底：导入按钮、路径输入框（借鉴 Scrapling 多策略） | 至少一种策略在目标环境中有效 |
| P1-4 | 合并到 videoPipeline：runJianyingFullPipeline(importPath, exportPath) | 端到端：导入 → 导出 |

**依赖**：P0 通过（导出流程稳定）。

---

### Phase C-P2 TTS 与字幕

**目标**：文案 → TTS 配音 → 字幕生成 → 剪映导入/对齐。

| 步骤 | 内容 | 验收 |
|------|------|------|
| P2-1 | TTS 模块：Ollama TTS 或云端 API，输出音频文件 | 给定文案可生成 mp3/wav |
| P2-2 | 字幕生成： Whisper 或接口，输出 SRT | 给定音频可生成 SRT |
| P2-3 | 剪映字幕流程：导入 SRT 或自动识别；a11y steps 设计 | 配音+字幕可进入时间轴 |
| P2-4 | 与 videoPipeline 编排：文案 → TTS → 字幕 → 剪映导入 → 导出 | 一条指令完成配音视频 |

**依赖**：P1 导入稳定。

---

### Phase E 自我进化基础（可与 P0 并行）

**目标**：为后续自适应打下基础，不改 Phase C 主流程逻辑。

| 步骤 | 内容 | 验收 |
|------|------|------|
| E-1 | 知识库：新建 `docs/automation_memory.md` | 记录剪映/微信已知失效模式、坐标、版本差异 |
| E-2 | Ralph Loop：为 runA11ySequence 增加可选「验证 loop」 | 单步失败时注入「上次失败原因」并重试 1～2 次 |
| E-3 | 失败写入知识库（可选）：clickByName 失败时 append 到 automation_memory | 可供人工或后续 Agent 参考 |

**依赖**：无（独立于 Phase C）。

---

### Phase C-P3 发布 + Scrapling 融入

**目标**：Web 端填标题、选分区；为 P3 发布做技术储备。

| 步骤 | 内容 | 验收 |
|------|------|------|
| P3-1 | 接入 Scrapling MCP：`.cursor/mcp.json` 增加 scrapling 配置 | Cursor 可调用 Scrapling 抓取指定 URL |
| P3-2 | P3 Blueprint：明确发布流程（抖音/B站等）— 桌面上传 vs Web 填表 | 选定一种平台做 POC |
| P3-3 | Scrapling 抓取页面结构：提取表单字段、分区选项 | 为「自动填标题、选分区」提供输入 |
| P3-4 | 发布流程编排：videoPipeline 末端调用 Scrapling 或 Playwright | 端到端：导出 → 发布到某平台 |

**依赖**：P2 完成或与 P2 并行（若优先验证 Web 发布）。

---

### Phase A 桌面端多策略与相似度（长期）

**目标**：将 Scrapling 的「自适应解析」思想迁移到桌面 UIA。

| 步骤 | 内容 | 验收 |
|------|------|------|
| A-1 | directShellBridge：多策略查找顺序配置化 | Name → AutomationId → 相对位置 → 坐标，可配置 |
| A-2 | UIA 相似度模块（可选）：文本/控件类型/相对位置相似度 | 剪映 UI 改版后仍能找「开始创作」等价按钮 |
| A-3 | 坐标漂移自适应：从 automation_memory 读取历史成功坐标，做加权/投票 | 减少单点坐标失效 |

**依赖**：E-1/E-2 知识库与 loop 已运行一段时间，有足够失败/成功样本。

---

## 四、执行优先级与依赖图

```
                    ┌─────────────┐
                    │   P0 收尾   │ ◄── 当前阻塞点
                    └─────┬───────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐   ┌─────────────┐   ┌─────────┐
    │ E 进化基础 │   │   P1 导入   │   │ (并行)  │
    └──────────┘   └──────┬──────┘   └─────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │   P2 TTS    │
                    └──────┬──────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐   ┌─────────────┐   ┌─────────┐
    │ P3 发布   │   │  A 多策略   │   │ (长期)  │
    │ Scrapling │   │  相似度     │   │         │
    └──────────┘   └─────────────┘   └─────────┘
```

**建议执行顺序**：

1. **立即**：P0 收尾 + E 基础（可并行）
2. **其次**：P1 导入
3. **再次**：P2 TTS
4. **然后**：P3 发布 + Scrapling
5. **长期**：A 多策略/相似度

---

## 五、产出物清单

| Phase | 产出物 | 路径/说明 |
|-------|--------|-----------|
| P0 | findExportDialogHwnd 修复、坐标兜底 | `directShellBridge.ts` |
| E | automation_memory.md、Ralph Loop 可选参数 | `docs/automation_memory.md`、`runA11ySequence.ts` |
| P1 | buildJianyingImportSteps、runJianyingFullPipeline | `jianyingSteps.ts`、`videoPipeline.ts` |
| P2 | TTS 模块、字幕模块、剪映字幕步骤 | `src/tts/`、`src/subtitles/`、`jianyingSteps.ts` |
| P3 | Scrapling MCP 配置、发布 Blueprint、发布流程 | `.cursor/mcp.json`、`docs/`、`videoPipeline.ts` |
| A | 多策略配置、相似度模块 | `directShellBridge.ts`、`src/tools/uiaSimilarity.ts`（可选） |

---

## 六、风险与约束

- **剪映版本差异**：不同版本 UI 可能不同，需在 automation_memory 中记录并支持多套坐标/策略。
- **Scrapling 依赖**：需 Python 3.10+ 与 `scrapling install`，团队环境需就绪。
- **P3 发布**：各平台反爬与接口不一，优先选一个平台做 POC，再扩展。
- **编码规范**：所有实现遵循 `.cursorrules`（TypeScript、强类型、try-catch、Local-First）。

---

## 七、批准后首步

用户批准本计划后，将按以下顺序开始实现：

1. **P0-1**：排查并修复 findExportDialogHwnd（含调试输出或 Spy++ 辅助定位）
2. **E-1**：新建 `docs/automation_memory.md` 并写入已知剪映/微信模式

后续步骤依验收结果按计划推进。

---

**状态**：NEEDS_PLAN_APPROVAL

*文档基于 Scrapling_集成分析.md、PhaseC_需求说明.md、workflow_state.md 整理。*
